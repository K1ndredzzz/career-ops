#!/usr/bin/env node
/**
 * candidate-screen.mjs — auditable local coarse screen for curated job tables.
 *
 * This is deliberately a discovery boundary. It ranks source-table candidates
 * for browser verification, but never opens a browser, writes data/pipeline.md
 * or data/applications.md, evaluates a JD, generates a CV/PDF, or submits an
 * application. A role still needs an official, role-specific live posting and
 * a full A-G evaluation before it can enter the Pipeline.
 *
 * Usage:
 *   node candidate-screen.mjs
 *   node candidate-screen.mjs --as-of 2026-07-24 --limit 30
 *   node candidate-screen.mjs --dry-run
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT = resolve(ROOT, 'data', 'candidate-pool.json');
const DEFAULT_POLICY = resolve(ROOT, 'data', 'candidate-screen-policy.json');
const DEFAULT_OUTPUT = resolve(ROOT, 'data', 'candidate-shortlist.json');
const DEFAULT_REVIEW_STATE = resolve(ROOT, 'data', 'candidate-review-state.json');

function clean(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function normalizeText(value) {
  return clean(value).replace(/\s+/g, '').toLocaleLowerCase('zh-Hans-CN');
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function safeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function isoToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function testPatterns(patterns, text) {
  const normalized = normalizeText(text);
  return (patterns ?? [])
    .filter((pattern) => {
      try {
        return new RegExp(pattern, 'iu').test(normalized);
      } catch {
        throw new Error(`Invalid policy pattern: ${pattern}`);
      }
    });
}

function valueAcrossSources(record, field) {
  return unique([
    record?.[field],
    ...(Array.isArray(record?.sources) ? record.sources.map((source) => source?.[field]) : []),
  ]);
}

function joinAcrossSources(record, fields) {
  return fields.flatMap((field) => valueAcrossSources(record, field)).join('\n');
}

function candidateId(record) {
  const input = [record.apply_url, record.company, record.title, record.source_file, record.source_row]
    .map(clean)
    .join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().toLocaleLowerCase('en-US');
  } catch {
    return raw.toLocaleLowerCase('en-US');
  }
}

function emptyReviewState() {
  return { schema_version: 1, entries: [] };
}

function validateReviewState(state) {
  if (!state || typeof state !== 'object') throw new Error('Review state must be a JSON object');
  if (!Array.isArray(state.entries)) throw new Error('Review state requires an entries array');
  for (const entry of state.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('Each review-state entry must be an object');
    if (!clean(entry.candidate_id) && !normalizeUrl(entry.apply_url)) {
      throw new Error('Each review-state entry requires candidate_id or apply_url');
    }
    if (!clean(entry.status)) throw new Error('Each review-state entry requires a status');
  }
}

function indexReviewState(state) {
  validateReviewState(state);
  const byCandidateId = new Map();
  const byApplyUrl = new Map();
  for (const entry of state.entries) {
    const normalized = {
      candidate_id: clean(entry.candidate_id),
      apply_url: clean(entry.apply_url),
      status: clean(entry.status),
      checked: clean(entry.checked),
      note: clean(entry.note),
      report: clean(entry.report),
      pipeline: Boolean(entry.pipeline),
      batch_verification: entry.batch_verification && typeof entry.batch_verification === 'object'
        ? entry.batch_verification
        : null,
    };
    if (normalized.candidate_id) byCandidateId.set(normalized.candidate_id, normalized);
    const urlKey = normalizeUrl(normalized.apply_url);
    if (urlKey) byApplyUrl.set(urlKey, normalized);
  }
  return { byCandidateId, byApplyUrl };
}

function findReviewState(record, screening, index) {
  return index.byCandidateId.get(screening.candidate_id)
    ?? index.byApplyUrl.get(normalizeUrl(record.apply_url))
    ?? null;
}

function overlayReviewState(record, state) {
  if (!state) return record;
  const original = record.screening;
  return {
    ...record,
    screening: {
      ...original,
      source_decision: original.decision,
      decision: 'processed',
      verification_ready: false,
      review_state: state,
    },
  };
}

function classifyLink(rawUrl) {
  const value = clean(rawUrl);
  if (!value) return { kind: 'missing', bonus: 0, note: '缺少投递入口' };
  if (value.toLowerCase().startsWith('mailto:')) {
    return { kind: 'manual_channel', bonus: 0, note: '邮件投递入口，无法做页面级存活核验' };
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const combined = `${host}${url.pathname}`.toLowerCase();
    if (/(?:docs\.qq\.com|feishu\.cn|kdocs\.cn|weixin\.qq\.com|z2u\.tv)/.test(host)) {
      return { kind: 'source_or_redirect', bonus: 0, note: '来源页或短链，需展开至官方岗位页' };
    }
    if (/(?:career|careers|campus|recruit|recruitment|jobs|job|zhaopin)/.test(combined)) {
      return { kind: 'career_like', bonus: 3, note: '链接形态像招聘入口，仍需核验是否官方且岗位明确' };
    }
    return { kind: 'unknown_web', bonus: 0, note: '网页入口，归属与岗位状态待核验' };
  } catch {
    return { kind: 'invalid', bonus: 0, note: '入口格式无法解析' };
  }
}

function broadTitle(title) {
  const text = clean(title);
  const separators = (text.match(/[、，,；;|/]/gu) ?? []).length;
  const whitespaceSegments = text.split(/\s+/u).filter(Boolean).length;
  const roleMarkerCount = (text.match(/(?:方向|岗位|职位|类)/gu) ?? []).length;
  return separators >= 2
    || (whitespaceSegments >= 4 && roleMarkerCount >= 2)
    || roleMarkerCount >= 4
    || /(?:等(?:岗位|职位)?$|多个岗位|职位包括|岗位包括|若干岗位|全岗位|不限岗位|下属各单位|各单位岗位|具体见.*链接|详见.*链接)/u.test(text);
}

function selectSourcePriority(record) {
  const priorities = valueAcrossSources(record, 'source_priority')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  return priorities.length ? Math.min(...priorities) : null;
}

function matchedRoleFamilies(policy, roleText, hasFinancialEmployerSignal) {
  return (policy.role_families ?? [])
    .map((family) => {
      const matches = testPatterns(family.patterns, roleText);
      if (!matches.length) return null;
      if (family.requires_financial_employer && !hasFinancialEmployerSignal) return null;
      return { ...family, matches };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function recentUpdateAdjustment(updatedAt, asOf, rules) {
  const updated = safeDate(updatedAt);
  if (!updated) return { score: 0, age_days: null, reason: null };
  const age = daysBetween(updated, asOf);
  if (age < 0) return { score: 0, age_days: age, reason: '来源更新时间在筛选日期之后，未额外加分' };
  if (age <= 3) return { score: rules['0-3'] ?? 0, age_days: age, reason: `来源 ${age} 天内更新` };
  if (age <= 7) return { score: rules['4-7'] ?? 0, age_days: age, reason: `来源 ${age} 天内更新` };
  if (age <= 14) return { score: rules['8-14'] ?? 0, age_days: age, reason: `来源 ${age} 天内更新` };
  if (age <= 30) return { score: rules['15-30'] ?? 0, age_days: age, reason: `来源 ${age} 天内更新` };
  return { score: 0, age_days: age, reason: null };
}

function deadlineAdjustment(record, asOf, rules, updateAge) {
  const deadline = safeDate(record.deadline_at);
  if (deadline) {
    const days = daysBetween(asOf, deadline);
    if (days >= 20) return { score: rules['20+'] ?? 0, days_remaining: days, reason: `距截止 ${days} 天` };
    if (days >= 7) return { score: rules['7-19'] ?? 0, days_remaining: days, reason: `距截止 ${days} 天` };
    if (days >= 1) return { score: rules['1-6'] ?? 0, days_remaining: days, reason: `距截止 ${days} 天` };
    return { score: 0, days_remaining: days, reason: '截止日期已过或为当天，待官方核验' };
  }
  if (record.deadline_status === 'rolling' && updateAge !== null && updateAge >= 0 && updateAge <= 7) {
    return { score: rules.rolling_recent ?? 0, days_remaining: null, reason: '滚动截止且来源近期更新' };
  }
  return { score: 0, days_remaining: null, reason: null };
}

function preferredLocationAdjustment(policy, locationText) {
  const matches = (policy.preferred_locations ?? [])
    .filter((location) => normalizeText(locationText).includes(normalizeText(location)));
  const byCity = policy.location_bonus_by_city ?? {};
  const fallback = policy.rules?.preferred_location_bonus ?? 0;
  const ranked = matches
    .map((city) => ({
      city,
      score: Number.isFinite(byCity[city]) ? byCity[city] : fallback,
    }))
    .sort((left, right) => right.score - left.score || left.city.localeCompare(right.city, 'zh-Hans-CN'));
  const preferred = ranked[0] ?? null;
  return {
    matches,
    preferred_city: preferred?.city ?? null,
    score: preferred?.score ?? 0,
  };
}

function sourceBatchClaim(policy, rawBatchText) {
  const batchText = normalizeText(rawBatchText);
  const verification = policy.batch_verification ?? {};
  const requiredEvidence = verification.required_official_evidence ?? [];
  const sourceClaims = [
    /提前批/u.test(batchText) ? '提前批' : null,
    /秋招|秋季/u.test(batchText) ? '秋招' : null,
    /暑期|summer/u.test(batchText) ? '暑期实习' : null,
    /校招|校园招聘/u.test(batchText) ? '校招' : null,
  ].filter(Boolean);
  const sourceClaim = sourceClaims.length === 1 ? sourceClaims[0] : null;
  let track = 'unknown';
  if (sourceClaims.length > 1) track = 'ambiguous_source_claim';
  else if (sourceClaim === '提前批' || sourceClaim === '秋招') track = 'primary_autumn';
  else if (sourceClaim === '暑期实习') track = 'summer_internship';
  else if (sourceClaim === '校招') track = 'campus';
  return {
    source_claim: sourceClaim,
    source_claims: sourceClaims,
    track,
    official_status: sourceClaims.length > 0 ? 'unverified_source_claim' : 'not_claimed',
    official_confirmation_required: sourceClaims.length > 0,
    required_official_evidence: requiredEvidence,
  };
}

/**
 * Screen one normalized source record. `coarse_score` is intentionally not a
 * final application score; it answers only whether the role merits browser
 * verification before expensive evaluation work.
 */
export function screenCandidate(record, policy, asOfValue) {
  const asOf = safeDate(asOfValue);
  if (!asOf) throw new Error('asOf must use a real YYYY-MM-DD date');
  const rules = policy.rules ?? {};
  const roleText = joinAcrossSources(record, ['title']);
  const companyText = joinAcrossSources(record, ['company']);
  const employerTypeText = joinAcrossSources(record, ['employer_type']);
  const employerText = `${companyText}\n${employerTypeText}`;
  const financialEmployerMatches = testPatterns(policy.financial_employer_patterns ?? policy.financial_context_patterns, companyText);
  const hasFinancialEmployerSignal = financialEmployerMatches.length > 0;
  const financialContextText = `${roleText}\n${companyText}\n${employerTypeText}`;
  const allText = `${financialContextText}\n${joinAcrossSources(record, ['cohort', 'batch', 'location'])}`;
  const title = clean(record.title);
  const locationText = joinAcrossSources(record, ['location']);
  const roleFamilies = matchedRoleFamilies(policy, roleText, hasFinancialEmployerSignal);
  const targetRoleFound = roleFamilies.length > 0;
  const strongRoleMatches = testPatterns(policy.strong_role_signal_patterns ?? [], roleText);
  const primaryStrongRoleMatches = testPatterns(policy.strong_role_signal_patterns ?? [], title);
  const lowFitMatches = testPatterns(policy.low_fit_patterns, roleText);
  const genericMatches = testPatterns(policy.generic_title_patterns, roleText);
  const isBroad = valueAcrossSources(record, 'title').some((sourceTitle) => broadTitle(sourceTitle));
  const financialContextMatches = testPatterns(policy.financial_context_patterns, allText);
  const soeMatches = testPatterns(policy.soe_patterns, employerTypeText);
  const location = preferredLocationAdjustment(policy, locationText);
  const sourcePriority = selectSourcePriority(record);
  const link = classifyLink(record.apply_url);
  const positives = [];
  const cautions = [];
  const exclusions = [];
  let rawScore = 0;

  if (targetRoleFound) {
    const [primary, ...secondary] = roleFamilies;
    rawScore += primary.score;
    positives.push(`目标岗位族：${primary.label}（${primary.matches.join('、')}） +${primary.score}`);
    if (secondary.length > 0) {
      const bonus = Math.min(8, secondary.length * 4);
      rawScore += bonus;
      positives.push(`相邻岗位信号：${secondary.map((item) => item.label).join('、')} +${bonus}`);
    }
  } else {
    exclusions.push('岗位标题未命中目标岗位族，不能仅因公司名称或行业而进入核验队列');
  }

  if (financialContextMatches.length > 0) {
    rawScore += rules.financial_context_bonus ?? 0;
    positives.push(`金融语境：${financialContextMatches.slice(0, 4).join('、')} +${rules.financial_context_bonus ?? 0}`);
  }

  if (soeMatches.length > 0) {
    rawScore += rules.soe_bonus ?? 0;
    positives.push(`国企/央企线索：${soeMatches.slice(0, 3).join('、')} +${rules.soe_bonus ?? 0}`);
  }

  if (location.matches.length > 0) {
    rawScore += location.score;
    positives.push(`优先城市：${location.preferred_city}${location.matches.length > 1 ? `（同时覆盖 ${location.matches.filter((city) => city !== location.preferred_city).join('、')}）` : ''} +${location.score}`);
  }

  const batch = sourceBatchClaim(policy, joinAcrossSources(record, ['batch']));
  if (batch.source_claim === '提前批') {
    rawScore += rules.advance_batch_bonus ?? 0;
    positives.push(`源表标注：提前批（仅作官网核验线索） +${rules.advance_batch_bonus ?? 0}`);
  } else if (batch.source_claim === '秋招') {
    rawScore += rules.autumn_batch_bonus ?? 0;
    positives.push(`源表标注：秋招（仅作官网核验线索） +${rules.autumn_batch_bonus ?? 0}`);
  } else if (batch.source_claim === '校招') {
    rawScore += rules.campus_batch_bonus ?? 0;
    positives.push(`源表标注：校招（仅作官网核验线索） +${rules.campus_batch_bonus ?? 0}`);
  } else if (batch.source_claim === '暑期实习') {
    rawScore += rules.summer_batch_bonus ?? 0;
    positives.push(`源表标注：暑期实习（仅作官网核验线索） +${rules.summer_batch_bonus ?? 0}`);
  }
  if (batch.official_confirmation_required) {
    const sourceBatchLabel = batch.source_claim ?? batch.source_claims.join('、');
    cautions.push(`批次尚未由官网确认：来源标注为${sourceBatchLabel}，须确认${batch.required_official_evidence.join('、') || '批次、届别和开放状态'}后才能正式评分或进入 Pipeline`);
  }

  const update = recentUpdateAdjustment(record.updated_at, asOf, rules.recent_update_bonus ?? {});
  if (update.score > 0) {
    rawScore += update.score;
    positives.push(`${update.reason} +${update.score}`);
  }
  const deadline = deadlineAdjustment(record, asOf, rules.future_deadline_bonus ?? {}, update.age_days);
  if (deadline.score > 0) {
    rawScore += deadline.score;
    positives.push(`${deadline.reason} +${deadline.score}`);
  }

  const sourceBonus = policy.source_priority_bonus?.[String(sourcePriority)] ?? 0;
  rawScore += sourceBonus;
  if (sourceBonus > 0) positives.push(`来源优先级 ${sourcePriority} +${sourceBonus}`);

  rawScore += link.bonus;
  if (link.bonus > 0) positives.push(`${link.note} +${link.bonus}`);
  else if (link.note) cautions.push(link.note);

  // A broad source row can name a high-priority role alongside unrelated roles.
  // Preserve it only as a role-extraction task; never let it become verification-ready
  // or enter the application pipeline without an official, role-specific posting.
  const scoreBeforeCautionPenalties = rawScore;

  if (isBroad) {
    rawScore -= rules.broad_listing_penalty ?? 0;
    cautions.push(`标题是多岗位汇总，未提取到可评分的单一职位 -${rules.broad_listing_penalty ?? 0}`);
  }
  if (genericMatches.length > 0) {
    rawScore -= rules.generic_title_penalty ?? 0;
    cautions.push(`标题过于泛化，缺少具体职责 -${rules.generic_title_penalty ?? 0}`);
  }
  if (lowFitMatches.length > 0) {
    if (!targetRoleFound) {
      exclusions.push(`低匹配岗位信号：${lowFitMatches.slice(0, 5).join('、')}`);
    } else {
      rawScore -= rules.mixed_low_fit_penalty ?? 0;
      cautions.push(`目标岗位与低匹配职责混在同一条目中：${lowFitMatches.slice(0, 4).join('、')} -${rules.mixed_low_fit_penalty ?? 0}`);
    }
  }
  if (update.age_days !== null && update.age_days >= 31) {
    const stalePenalty = update.age_days <= 60
      ? (rules.stale_update_penalty?.['31-60'] ?? 0)
      : (rules.stale_update_penalty?.['61+'] ?? 0);
    rawScore -= stalePenalty;
    cautions.push(`来源已 ${update.age_days} 天未更新 -${stalePenalty}`);
  }
  if (link.kind === 'manual_channel') {
    rawScore -= rules.manual_channel_penalty ?? 0;
    cautions.push(`邮件入口无法完成官方页面核验 -${rules.manual_channel_penalty ?? 0}`);
  }

  const eligibleByScore = targetRoleFound && exclusions.length === 0 && rawScore >= (policy.minimum_coarse_score ?? 0);
  const needsRoleExtraction = isBroad || genericMatches.length > 0 || lowFitMatches.length > 0;
  const clearlyStale = update.age_days !== null && update.age_days >= 61;
  const strongExtractionCandidate = targetRoleFound
    && exclusions.length === 0
    && needsRoleExtraction
    && primaryStrongRoleMatches.length > 0
    && (hasFinancialEmployerSignal || soeMatches.length > 0)
    && scoreBeforeCautionPenalties >= (policy.minimum_coarse_score ?? 0)
    && !clearlyStale
    && !['manual_channel', 'missing', 'invalid'].includes(link.kind);
  if (strongExtractionCandidate && !eligibleByScore) {
    cautions.push(`保留为岗位拆分核验：主标题命中强岗位信号 ${primaryStrongRoleMatches.slice(0, 4).join('、')}，但汇总条目本身不能直接评分或投递`);
  }
  const verificationReady = eligibleByScore
    && !needsRoleExtraction
    && !clearlyStale
    && ['career_like', 'unknown_web'].includes(link.kind);

  let decision = 'exclude';
  if (verificationReady) decision = 'verify';
  else if (eligibleByScore || strongExtractionCandidate) decision = 'review';
  if (!targetRoleFound || exclusions.length > 0) decision = 'exclude';

  const evidence = {
    role_families: roleFamilies.map(({ id, label, matches }) => ({ id, label, matches })),
    strong_role_matches: strongRoleMatches,
    primary_strong_role_matches: primaryStrongRoleMatches,
    financial_context_matches: financialContextMatches,
    soe_matches: soeMatches,
    preferred_locations: location.matches,
    preferred_city: location.preferred_city,
    preferred_location_bonus: location.score,
    batch,
    low_fit_matches: lowFitMatches,
    source_priority: sourcePriority,
    link,
    update_age_days: update.age_days,
    deadline_days_remaining: deadline.days_remaining,
  };

  return {
    candidate_id: candidateId(record),
    decision,
    coarse_score: Math.max(0, rawScore),
    verification_ready: verificationReady,
    needs_role_extraction: needsRoleExtraction,
    strong_extraction_candidate: strongExtractionCandidate,
    positive_reasons: positives,
    cautions,
    exclusion_reasons: exclusions,
    evidence,
  };
}

function compareScreened(left, right) {
  const leftScreen = left.screening;
  const rightScreen = right.screening;
  const leftProcessed = leftScreen.decision === 'processed' ? 1 : 0;
  const rightProcessed = rightScreen.decision === 'processed' ? 1 : 0;
  const leftStrongExtraction = leftScreen.strong_extraction_candidate ? 1 : 0;
  const rightStrongExtraction = rightScreen.strong_extraction_candidate ? 1 : 0;
  return leftProcessed - rightProcessed
    || Number(rightScreen.verification_ready) - Number(leftScreen.verification_ready)
    || rightStrongExtraction - leftStrongExtraction
    || rightScreen.coarse_score - leftScreen.coarse_score
    || (leftScreen.evidence.update_age_days ?? Number.MAX_SAFE_INTEGER) - (rightScreen.evidence.update_age_days ?? Number.MAX_SAFE_INTEGER)
    || (leftScreen.evidence.source_priority ?? Number.MAX_SAFE_INTEGER) - (rightScreen.evidence.source_priority ?? Number.MAX_SAFE_INTEGER)
    || clean(left.company).localeCompare(clean(right.company), 'zh-Hans-CN');
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('Policy must be a JSON object');
  if (!Array.isArray(policy.role_families) || policy.role_families.length === 0) {
    throw new Error('Policy requires at least one role_families entry');
  }
  if (!Number.isFinite(policy.minimum_coarse_score)) {
    throw new Error('Policy minimum_coarse_score must be a number');
  }
  for (const family of policy.role_families) {
    if (!family?.id || !family?.label || !Number.isFinite(family.score) || !Array.isArray(family.patterns)) {
      throw new Error('Each role family requires id, label, numeric score, and patterns');
    }
  }
}

/**
 * Run the local screen without side effects. Exported for tests and future UI.
 */
export function screenCandidatePool({ pool, policy, reviewState = emptyReviewState(), asOf = isoToday(), limit, reviewLimit } = {}) {
  validatePolicy(policy);
  if (!pool || !Array.isArray(pool.records)) throw new Error('Candidate pool must contain a records array');
  if (!safeDate(asOf)) throw new Error('--as-of must use a real YYYY-MM-DD date');
  const reviewStateIndex = indexReviewState(reviewState);
  const verificationLimit = Number.isInteger(limit) && limit >= 0 ? limit : (policy.verification_limit ?? 30);
  const resolvedReviewLimit = Number.isInteger(reviewLimit) && reviewLimit >= 0 ? reviewLimit : (policy.review_limit ?? 12);
  const records = pool.records
    .map((record) => {
      const screened = { ...record, screening: screenCandidate(record, policy, asOf) };
      return overlayReviewState(screened, findReviewState(record, screened.screening, reviewStateIndex));
    })
    .sort(compareScreened);
  const verificationCandidates = records.filter((record) => record.screening.decision === 'verify');
  const reviewCandidates = records.filter((record) => record.screening.decision === 'review');
  const processed = records.filter((record) => record.screening.decision === 'processed');
  const excluded = records.filter((record) => record.screening.decision === 'exclude');

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    as_of: asOf,
    scope: '本地粗筛结果；已处理记录由 candidate-review-state.json 遮罩，不会回到待核验队列。未处理记录尚未核验官方页面、未进行 A-G 正式评分，未写入 Pipeline、Tracker 或申请材料。',
    input: {
      candidate_pool_generated_at: pool.generated_at ?? pool.generatedAt ?? null,
      candidate_count: pool.records.length,
      source_count: pool.source_count ?? null,
    },
    policy: {
      schema_version: policy.schema_version ?? null,
      minimum_coarse_score: policy.minimum_coarse_score,
      verification_limit: verificationLimit,
      review_limit: resolvedReviewLimit,
      preferred_locations: policy.preferred_locations ?? [],
    },
    stats: {
      total_records: records.length,
      decisions: countBy(records, (record) => record.screening.decision),
      verification_ready_total: verificationCandidates.length,
      review_required_total: reviewCandidates.length,
      processed_total: processed.length,
      excluded_total: excluded.length,
    },
    shortlist: verificationCandidates.slice(0, verificationLimit),
    review_queue: reviewCandidates.slice(0, resolvedReviewLimit),
    processed,
    records,
  };
}

function assertSafeOutput(outputPath, inputPath) {
  const target = resolve(outputPath);
  const blocked = new Set([
    resolve(ROOT, 'data', 'pipeline.md'),
    resolve(ROOT, 'data', 'applications.md'),
    resolve(ROOT, 'pipeline.md'),
    resolve(ROOT, 'applications.md'),
    resolve(inputPath),
  ]);
  if (blocked.has(target)) {
    throw new Error('Refusing to overwrite the candidate pool, Pipeline, or applications tracker; this command only writes a shortlist JSON file');
  }
}

function writeJsonAtomically(outputPath, data, inputPath) {
  assertSafeOutput(outputPath, inputPath);
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temporary, resolved);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function parseCliArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    policy: DEFAULT_POLICY,
    output: DEFAULT_OUTPUT,
    reviewState: DEFAULT_REVIEW_STATE,
    asOf: isoToday(),
    limit: null,
    reviewLimit: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--input' || arg === '--policy' || arg === '--output' || arg === '--review-state' || arg === '--as-of' || arg === '--limit' || arg === '--review-limit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--input') options.input = resolve(ROOT, value);
      if (arg === '--policy') options.policy = resolve(ROOT, value);
      if (arg === '--output') options.output = resolve(ROOT, value);
      if (arg === '--review-state') options.reviewState = resolve(ROOT, value);
      if (arg === '--as-of') options.asOf = value;
      if (arg === '--limit' || arg === '--review-limit') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0) throw new Error(`${arg} must be a non-negative integer`);
        if (arg === '--limit') options.limit = number;
        else options.reviewLimit = number;
      }
      index++;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node candidate-screen.mjs [options]

Options:
  --input <path>         Candidate-pool JSON (default: data/candidate-pool.json)
  --policy <path>        User-owned screen policy (default: data/candidate-screen-policy.json)
  --output <path>        Shortlist JSON (default: data/candidate-shortlist.json)
  --review-state <path>  Processed-candidate state (default: data/candidate-review-state.json)
  --as-of YYYY-MM-DD     Date used for freshness and deadline ranking
  --limit <N>            Maximum verification-ready shortlist size
  --review-limit <N>     Maximum role-extraction review queue size
  --dry-run              Print counts without writing output
  --help                 Show this help

Safety: this command never opens a browser, writes Pipeline/Tracker, creates a
CV/PDF, or submits an application. It only ranks local source-table records.`);
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const pool = JSON.parse(readFileSync(options.input, 'utf8'));
      const policy = JSON.parse(readFileSync(options.policy, 'utf8'));
      const reviewState = existsSync(options.reviewState)
        ? JSON.parse(readFileSync(options.reviewState, 'utf8'))
        : emptyReviewState();
      const result = screenCandidatePool({
        pool,
        policy,
        reviewState,
        asOf: options.asOf,
        limit: options.limit ?? undefined,
        reviewLimit: options.reviewLimit ?? undefined,
      });
      if (!options.dryRun) writeJsonAtomically(options.output, result, options.input);
      console.log(JSON.stringify({
        dryRun: options.dryRun,
        output: options.output,
        asOf: result.as_of,
        stats: result.stats,
        shortlist_count: result.shortlist.length,
        review_queue_count: result.review_queue.length,
      }, null, 2));
    }
  } catch (error) {
    console.error(`candidate-screen: ${error.message}`);
    process.exitCode = 1;
  }
}
