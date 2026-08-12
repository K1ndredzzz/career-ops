#!/usr/bin/env node
/**
 * job-source-import.mjs — six curated CSV sources → read-only candidate pool.
 *
 * This importer is deliberately a discovery-only boundary. It reads the six
 * user-supplied CSV snapshots and writes a normalized candidate-pool JSON
 * document. It never evaluates a role, generates an application asset, opens
 * a browser, or writes data/pipeline.md or data/applications.md.
 *
 * Usage:
 *   node job-source-import.mjs
 *   node job-source-import.mjs --dry-run --as-of 2026-07-24
 *   node job-source-import.mjs --output data/my-candidate-pool.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DIR = resolve(ROOT, 'data', 'job-sources');
const DEFAULT_OUTPUT = resolve(ROOT, 'data', 'candidate-pool.json');
const RECENT_UPDATE_DAYS = 30;

/**
 * The files are ordered by the source-quality review, not by any individual
 * role score. Aliases keep the importer tolerant of the pre-review filenames
 * that omitted the underscore after the rank.
 */
export const SOURCE_CONFIGS = Object.freeze([
  { file: '01_阿七.csv', aliases: ['01阿七.csv'], priority: 1, fallbackHeaderRecord: 3 },
  { file: '02_毕业帮.csv', aliases: ['02毕业帮.csv'], priority: 2, fallbackHeaderRecord: 3 },
  { file: '03_小师姐Emma.csv', aliases: ['03小师姐Emma.csv'], priority: 3, fallbackHeaderRecord: 2 },
  { file: '04_熬夜波比.csv', aliases: ['04熬夜波比.csv'], priority: 4, fallbackHeaderRecord: 1 },
  { file: '05_小林.csv', aliases: ['05小林.csv'], priority: 5, fallbackHeaderRecord: 1 },
  { file: '06_远哥.csv', aliases: ['06远哥.csv'], priority: 6, fallbackHeaderRecord: 1 },
]);

const EXCLUSION_KEYS = Object.freeze([
  'not_2027_cohort',
  'unsupported_track',
  'expired_deadline',
  'summer_rolling_not_recent',
  'summer_unknown_deadline',
  'no_apply_url',
  'missing_company_or_title',
]);

const HEADER_MATCHERS = Object.freeze({
  company: [
    /^公司名称$/, /^企业名称$/, /^企业$/, /^企业\/招聘单位名称$/, /^企业\/单位名称$/,
  ],
  employer_type: [
    /^企业性质$/, /^企业\/单位性质$/, /^企业属性$/, /^单位性质$/, /^公司性质$/, /^性质$/,
  ],
  industry: [
    /^行业$/, /^行业大类$/, /^行业分类$/, /^所属行业$/, /^所在行业$/,
  ],
  title: [
    /^招聘岗位$/, /^招聘职位$/, /^公告标题$/, /^岗位$/, /^职位$/,
  ],
  cohort: [
    /^招聘对象$/, /^毕业时间要求$/, /^毕业年份$/, /^招聘人群$/,
  ],
  batch: [
    /^批次$/, /^招聘类型\/批次$/, /^招聘类型$/, /^招聘项目$/, /^类型$/, /^内推类型$/,
  ],
  location: [
    /^工作地点$/, /^地点$/, /^地点可筛选$/, /^base地$/, /^base$/, /^工作地点②?文本格式$/,
  ],
  updated: [
    /^更新时间$/, /^更新\/开启时间$/, /^添加进表格时间$/, /^更新日期$/,
  ],
  deadline: [
    /^截止时间$/, /^网申截止时间$/, /^投递截止时间$/, /^报名截止时间$/,
  ],
  apply: [
    /^投递方式$/, /^投递入口$/, /^投递官网链接$/, /^投递链接$/, /^报名链接$/,
    /内推链接\/官网$/,
  ],
  announcement: [
    /^官方公告$/, /^官方招聘推文$/, /^公告链接$/, /^招聘公告$/, /^招聘推文$/,
  ],
  notes: [
    /内推码/, /备注/, /投递注意事项/, /^状态$/, /^文本$/, /^笔试安排/, /^公司介绍$/,
  ],
});

const AUTUMN_TRACK_RE = /秋招|秋季|提前批|校招|校园招聘|正式批/i;
const SUMMER_INTERNSHIP_RE = /暑期(?:实习)?|暑假(?:实习)?|summer\s*(?:intern|internship)/i;
const ROLLING_DEADLINE_RE = /招满|尽快(?:投递|申请|报名)?|未明确|长期有效|持续招募|招聘中|开放中/i;
const IMAGE_URL_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const URL_RE = /(?:https?:\/\/|mailto:)[^\s<>"'，。；;、）)】\]}]+/giu;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * Parse an RFC 4180 style CSV without adding a dependency. In addition to the
 * record values, keep the first physical line of every logical record so a
 * candidate can always be traced back to its source row, even when quoted
 * cells contain newlines.
 *
 * @param {string} input
 * @returns {{ values: string[], startLine: number }[]}
 */
export function parseRfcCsv(input) {
  if (typeof input !== 'string') throw new TypeError('CSV input must be a string');

  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const finishRecord = () => {
    row.push(field);
    records.push({ values: row, startLine: recordStartLine });
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        field += '\n';
        line++;
      } else if (ch === '\n') {
        field += '\n';
        line++;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRecord();
      line++;
      recordStartLine = line;
    } else {
      field += ch;
    }
  }

  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field');
  if (field !== '' || row.length > 0) finishRecord();
  return records;
}

function cleanCell(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function normalizeHeader(value) {
  return cleanCell(value)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()【】\[\]]/g, '')
    .replace(/[：:]/g, '')
    .toLowerCase();
}

function isBlankRecord(record) {
  return record.values.every((value) => cleanCell(value) === '');
}

function indexesForHeaders(headers) {
  const normalized = headers.map(normalizeHeader);
  const indexes = {};
  for (const [field, matchers] of Object.entries(HEADER_MATCHERS)) {
    indexes[field] = normalized
      .map((header, index) => (matchers.some((matcher) => matcher.test(header)) ? index : -1))
      .filter((index) => index !== -1);
  }
  return indexes;
}

/**
 * Locate a real header by its field names instead of relying on a physical
 * line number. The known header record number is only a defensive fallback
 * for a future source snapshot with an unfamiliar synonym.
 */
function locateHeader(records, sourceConfig) {
  let best = null;
  const limit = Math.min(records.length, 50);
  for (let index = 0; index < limit; index++) {
    const record = records[index];
    if (isBlankRecord(record)) continue;
    const indexes = indexesForHeaders(record.values);
    const score = Object.values(indexes).filter((matched) => matched.length > 0).length;
    const hasCoreFields = indexes.company.length > 0 && indexes.title.length > 0;
    if (!best || score > best.score || (score === best.score && hasCoreFields && !best.hasCoreFields)) {
      best = { index, indexes, score, hasCoreFields };
    }
  }

  if (best?.hasCoreFields && best.score >= 3) return best;

  const fallbackIndex = (sourceConfig.fallbackHeaderRecord ?? 1) - 1;
  const fallback = records[fallbackIndex];
  if (fallback && !isBlankRecord(fallback)) {
    const indexes = indexesForHeaders(fallback.values);
    if (indexes.company.length > 0 && indexes.title.length > 0) {
      return { index: fallbackIndex, indexes, score: Object.values(indexes).filter((matched) => matched.length > 0).length, hasCoreFields: true };
    }
  }

  throw new Error(`Could not identify a company/title header in ${sourceConfig.file}`);
}

function valuesFor(row, indexes) {
  return indexes
    .map((index) => cleanCell(row.values[index]))
    .filter(Boolean);
}

function firstValue(row, indexes) {
  return valuesFor(row, indexes)[0] ?? '';
}

function joinDistinct(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const cleaned = cleanCell(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.join(' | ');
}

function safeDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function inferYearForMonthDay(month, day, asOfDate) {
  let candidate = safeDate(asOfDate.getUTCFullYear(), month, day);
  if (!candidate) return null;
  // A yearless date more than roughly one season ahead is normally from the
  // preceding update cycle (e.g. "12月1日" read in January).
  if (candidate.getTime() > addUtcDays(asOfDate, 183).getTime()) {
    candidate = safeDate(asOfDate.getUTCFullYear() - 1, month, day);
  }
  return candidate;
}

/**
 * Parse well-defined spreadsheet, ISO, dotted/slashed, and Chinese date
 * values. A yearless month/day is anchored to --as-of so it remains
 * deterministic and the original string stays available in *_raw.
 */
export function parseSourceDate(raw, asOfDate) {
  const value = cleanCell(raw);
  if (!value) return null;

  // Excel's 1900-date-system serials. Values below 30000 are deliberately
  // not treated as serials so a bare "2027" can never become a 1905 date.
  if (/^\d{5}(?:\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (serial >= 30000 && serial <= 60000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    }
  }

  let match = value.match(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:$|[^\d])/);
  if (match) return safeDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = value.match(/(?:^|[^\d])(\d{4})\s*[.\/-年]\s*(\d{1,2})\s*(?:[.\/-月])\s*(\d{1,2})(?:日)?/);
  if (match) return safeDate(Number(match[1]), Number(match[2]), Number(match[3]));

  // Some spreadsheets encode an explicit two-digit year, such as 26.1.31.
  match = value.match(/(?:^|[^\d])(\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})(?:$|[^\d])/);
  if (match) return safeDate(2000 + Number(match[1]), Number(match[2]), Number(match[3]));

  match = value.match(/(?:^|[^\d])(\d{1,2})\s*(?:月|[.\/])\s*(\d{1,2})(?:日)?/);
  if (match) return inferYearForMonthDay(Number(match[1]), Number(match[2]), asOfDate);

  return null;
}

function deadlineInfo(raw, asOfDate) {
  const deadlineAt = parseSourceDate(raw, asOfDate);
  if (deadlineAt) return { deadlineAt: isoDate(deadlineAt), status: 'dated' };
  if (ROLLING_DEADLINE_RE.test(cleanCell(raw))) return { deadlineAt: null, status: 'rolling' };
  return { deadlineAt: null, status: 'unknown' };
}

/**
 * Returns a source-visible link and a conservative normalized key. The key is
 * only used for exact URL deduplication; the candidate retains the original
 * source-visible URL and no claim is made that it is official or live.
 */
export function normalizeUrl(raw) {
  const value = cleanCell(raw).replace(/[，。；;、）)】\]}]+$/u, '');
  if (!value) return null;
  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    if (!['http:', 'https:', 'mailto:'].includes(protocol)) return null;

    if (protocol === 'mailto:') {
      const address = url.pathname;
      if (!address) return null;
      // Domains are case-insensitive. Keep the local part intact in output,
      // while using a case-stable dedupe key for normal email workflows.
      const at = address.lastIndexOf('@');
      const normalizedAddress = at === -1
        ? address
        : `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
      return { raw: value, normalized: `mailto:${normalizedAddress}${url.search}` };
    }

    url.protocol = protocol;
    url.hostname = url.hostname.toLowerCase();
    if ((protocol === 'http:' && url.port === '80') || (protocol === 'https:' && url.port === '443')) url.port = '';
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return { raw: value, normalized: url.toString() };
  } catch {
    return null;
  }
}

function allUrlMatches(value) {
  return cleanCell(value).match(URL_RE) ?? [];
}

function extractLink(values, { allowBareEmail = false, rejectImageUrls = false } = {}) {
  for (const value of values) {
    for (const match of allUrlMatches(value)) {
      const normalized = normalizeUrl(match);
      if (!normalized) continue;
      if (rejectImageUrls && normalized.normalized.startsWith('http') && IMAGE_URL_RE.test(normalized.normalized)) continue;
      return normalized;
    }
  }

  if (allowBareEmail) {
    for (const value of values) {
      const email = cleanCell(value).match(EMAIL_RE)?.[0];
      if (!email) continue;
      const normalized = normalizeUrl(`mailto:${email}`);
      if (normalized) return normalized;
    }
  }
  return null;
}

function isCohort2027(record) {
  // Keep graduation-date ranges (for example "2026年9月-2027年8月")
  // from being mistaken for a cohort label. A source needs an explicit 27届
  // / 2027届-style eligibility signal, not merely a calendar year.
  const text = [record.cohort, record.batch, record.title].join(' ');
  return /27\s*届|2027\s*(?:届|级|毕业|年\s*(?:毕业|应届))/i.test(text);
}

function isRecent(updatedAt, asOfDate) {
  if (!updatedAt) return false;
  const updated = safeDate(...updatedAt.split('-').map(Number));
  if (!updated) return false;
  const age = Math.round((asOfDate.getTime() - updated.getTime()) / 86400000);
  return age >= 0 && age <= RECENT_UPDATE_DAYS;
}

function blankExclusionCounter() {
  return Object.fromEntries(EXCLUSION_KEYS.map((key) => [key, 0]));
}

function createSourceStats(config, sourceFile) {
  return {
    source_file: sourceFile,
    source_priority: config.priority,
    header_row: null,
    records_read: 0,
    blank_rows: 0,
    included_before_dedup: 0,
    excluded_rows: 0,
    excluded_by_reason: blankExclusionCounter(),
  };
}

function incrementReasons(stats, reasons) {
  if (reasons.length === 0) return;
  stats.excluded_rows++;
  for (const reason of reasons) stats.excluded_by_reason[reason]++;
}

function chooseSourcePath(sourceDir, config) {
  for (const file of [config.file, ...(config.aliases ?? [])]) {
    const candidate = resolve(sourceDir, file);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing required job-source CSV: ${resolve(sourceDir, config.file)}`);
}

function buildRecord(row, indexes, config, sourceFile, asOfDate) {
  const updatedRaw = firstValue(row, indexes.updated);
  const deadlineRaw = firstValue(row, indexes.deadline);
  const updatedDate = parseSourceDate(updatedRaw, asOfDate);
  const deadline = deadlineInfo(deadlineRaw, asOfDate);
  const apply = extractLink(valuesFor(row, indexes.apply), { allowBareEmail: true, rejectImageUrls: true });
  const announcement = extractLink(valuesFor(row, indexes.announcement));

  return {
    source_file: sourceFile,
    source_row: row.startLine,
    source_priority: config.priority,
    company: firstValue(row, indexes.company),
    employer_type: firstValue(row, indexes.employer_type),
    industry: firstValue(row, indexes.industry),
    title: firstValue(row, indexes.title),
    cohort: firstValue(row, indexes.cohort),
    batch: firstValue(row, indexes.batch),
    location: firstValue(row, indexes.location),
    updated_raw: updatedRaw,
    updated_at: updatedDate ? isoDate(updatedDate) : null,
    deadline_raw: deadlineRaw,
    deadline_at: deadline.deadlineAt,
    deadline_status: deadline.status,
    apply_url: apply?.raw ?? null,
    announcement_url: announcement?.raw ?? null,
    notes: joinDistinct(valuesFor(row, indexes.notes)),
    verification_status: 'unverified',
    _dedupe_key: apply?.normalized ?? null,
  };
}

function candidateExclusions(record, asOfDate) {
  const reasons = [];
  if (!isCohort2027(record)) reasons.push('not_2027_cohort');

  const trackText = `${record.batch} ${record.title}`;
  const isAutumn = AUTUMN_TRACK_RE.test(trackText);
  const isSummer = SUMMER_INTERNSHIP_RE.test(trackText);
  if (!isAutumn && !isSummer) reasons.push('unsupported_track');

  if (record.deadline_at && record.deadline_at < isoDate(asOfDate)) reasons.push('expired_deadline');

  // An open-ended summer role is only a useful discovery candidate when the
  // source itself was refreshed recently. Unknown deadlines do not get the
  // same benefit of the doubt. Autumn records may be retained with an unknown
  // deadline, notably the referral-only 遠哥 table.
  if (isSummer && !record.deadline_at) {
    if (record.deadline_status === 'rolling') {
      if (!isRecent(record.updated_at, asOfDate)) reasons.push('summer_rolling_not_recent');
    } else {
      reasons.push('summer_unknown_deadline');
    }
  }

  if (!record.apply_url || !record._dedupe_key) reasons.push('no_apply_url');
  if (!record.company || !record.title) reasons.push('missing_company_or_title');
  return reasons;
}

function sourceProvenance(record) {
  const { _dedupe_key, ...provenance } = record;
  return provenance;
}

function dedupeCandidates(records) {
  const groups = new Map();
  for (const record of records) {
    const provenance = sourceProvenance(record);
    const existing = groups.get(record._dedupe_key);
    if (existing) {
      existing.sources.push(provenance);
      existing.source_chain.push({
        source_file: provenance.source_file,
        source_row: provenance.source_row,
        source_priority: provenance.source_priority,
      });
      continue;
    }
    groups.set(record._dedupe_key, {
      ...provenance,
      sources: [provenance],
      source_chain: [{
        source_file: provenance.source_file,
        source_row: provenance.source_row,
        source_priority: provenance.source_priority,
      }],
    });
  }
  return [...groups.values()];
}

function validateAsOf(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new Error('--as-of must use YYYY-MM-DD');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = safeDate(year, month, day);
  if (!date) throw new Error('--as-of must be a real calendar date');
  return date;
}

function todayAsOf() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function assertSafeOutput(outputPath) {
  const blocked = new Set([
    resolve(ROOT, 'data', 'pipeline.md'),
    resolve(ROOT, 'data', 'applications.md'),
    resolve(ROOT, 'pipeline.md'),
    resolve(ROOT, 'applications.md'),
  ]);
  if (blocked.has(resolve(outputPath))) {
    throw new Error('Refusing to write pipeline.md or applications.md; this importer only writes a candidate-pool JSON file');
  }
}

/**
 * Import the six curated source files. This function is also exported so tests
 * and future read-only UI code can call it without invoking the CLI.
 */
export function importJobSources({
  sourceDir = DEFAULT_SOURCE_DIR,
  asOf = todayAsOf(),
  sourceConfigs = SOURCE_CONFIGS,
} = {}) {
  const asOfDate = validateAsOf(asOf);
  const resolvedSourceDir = resolve(sourceDir);
  const stats = {
    source_files_expected: sourceConfigs.length,
    source_files_read: 0,
    records_read: 0,
    blank_rows: 0,
    candidates_before_dedup: 0,
    candidates_after_dedup: 0,
    deduplicated_records: 0,
    excluded_rows: 0,
    excluded_by_reason: blankExclusionCounter(),
    sources: [],
  };
  const accepted = [];

  for (const config of sourceConfigs) {
    const sourcePath = chooseSourcePath(resolvedSourceDir, config);
    const sourceFile = basename(sourcePath);
    const sourceStats = createSourceStats(config, sourceFile);
    const records = parseRfcCsv(readFileSync(sourcePath, 'utf8'));
    const header = locateHeader(records, config);
    sourceStats.header_row = records[header.index].startLine;
    stats.source_files_read++;

    for (let index = header.index + 1; index < records.length; index++) {
      const row = records[index];
      if (isBlankRecord(row)) {
        sourceStats.blank_rows++;
        stats.blank_rows++;
        continue;
      }

      sourceStats.records_read++;
      stats.records_read++;
      const record = buildRecord(row, header.indexes, config, sourceFile, asOfDate);
      const reasons = candidateExclusions(record, asOfDate);
      if (reasons.length > 0) {
        incrementReasons(sourceStats, reasons);
        incrementReasons(stats, reasons);
        continue;
      }
      accepted.push(record);
      sourceStats.included_before_dedup++;
    }
    stats.sources.push(sourceStats);
  }

  accepted.sort((a, b) => (
    a.source_priority - b.source_priority
    || a.source_row - b.source_row
    || a.company.localeCompare(b.company, 'zh-Hans-CN')
  ));
  const records = dedupeCandidates(accepted);
  stats.candidates_before_dedup = accepted.length;
  stats.candidates_after_dedup = records.length;
  stats.deduplicated_records = accepted.length - records.length;

  const generatedAt = new Date().toISOString();

  return {
    // Keep both spellings while external consumers migrate. `generated_at` is
    // the stable data-contract spelling; `generatedAt` preserves the initial
    // JSON proposal without duplicating the (potentially large) records list.
    generated_at: generatedAt,
    generatedAt,
    asOf: isoDate(asOfDate),
    source_count: stats.source_files_read,
    raw_record_count: stats.records_read,
    scope: {
      cohort: '27届 / 2027届',
      included_tracks: ['秋招', '提前批', '校招', '正式批', '暑期实习'],
      summer_internship_rule: `已知截止日期未过，或“招满即止/尽快投递”等滚动截止且 ${RECENT_UPDATE_DAYS} 天内更新`,
      recent_update_days: RECENT_UPDATE_DAYS,
      deduplication: '仅按规范化投递 URL 去重；不做公司或岗位名称模糊去重。',
      verification: '所有 URL 仅为源表可见入口，均为 unverified；未核验是否官方或仍有效。',
    },
    sources: stats.sources,
    stats,
    candidates_count: records.length,
    records,
  };
}

function writeJsonAtomically(outputPath, result) {
  assertSafeOutput(outputPath);
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    renameSync(temporary, resolved);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function parseCliArgs(argv) {
  const options = {
    dryRun: false,
    output: DEFAULT_OUTPUT,
    sourceDir: DEFAULT_SOURCE_DIR,
    asOf: todayAsOf(),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--output' || arg === '--as-of' || arg === '--source-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--output') options.output = resolve(ROOT, value);
      if (arg === '--as-of') options.asOf = value;
      if (arg === '--source-dir') options.sourceDir = resolve(ROOT, value);
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
  console.log(`Usage: node job-source-import.mjs [options]

Options:
  --dry-run              Parse and report stats without writing a file
  --output <path>        Candidate-pool JSON output (default: data/candidate-pool.json)
  --as-of YYYY-MM-DD     Cutoff date used for deadline checks
  --source-dir <path>    Source CSV directory (default: data/job-sources)
  --help                 Show this help

Safety: this importer never writes data/pipeline.md or data/applications.md,
does not evaluate roles, and does not generate or submit applications.`);
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
      const result = importJobSources({ sourceDir: options.sourceDir, asOf: options.asOf });
      if (!options.dryRun) writeJsonAtomically(options.output, result);
      console.log(JSON.stringify({
        dryRun: options.dryRun,
        output: options.output,
        asOf: result.asOf,
        source_count: result.source_count,
        raw_record_count: result.raw_record_count,
        records_count: result.candidates_count,
        stats: result.stats,
      }, null, 2));
    }
  } catch (error) {
    console.error(`job-source-import: ${error.message}`);
    process.exitCode = 1;
  }
}
