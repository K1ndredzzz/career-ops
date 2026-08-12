// tests/candidate-screen.test.mjs — coarse screen stays auditable and local.

import { pass, fail } from './helpers.mjs';
import { screenCandidate, screenCandidatePool } from '../candidate-screen.mjs';

function expect(label, condition) {
  if (condition) pass(label);
  else {
    fail(label);
    throw new Error(label);
  }
}

const policy = {
  schema_version: 1,
  minimum_coarse_score: 38,
  verification_limit: 2,
  review_limit: 2,
  preferred_locations: ['成都', '上海'],
  location_bonus_by_city: { 成都: 15, 上海: 9 },
  batch_verification: {
    primary_tracks: ['提前批', '秋招'],
    source_label_is_confirmation: false,
    required_official_evidence: ['招聘批次名称', '候选人届别兼容性', '岗位当前开放状态'],
  },
  role_families: [
    { id: 'credit_risk', label: '信用风险', score: 36, patterns: ['信用风险', '授信', '信评', '风险管理', '风控'] },
    { id: 'finance', label: '金融财务', score: 34, patterns: ['财务管理', '预算管理', '资金管理'] },
  ],
  strong_role_signal_patterns: ['信评', '授信审批', '预算管理'],
  financial_context_patterns: ['银行', '证券', '金融', '财务'],
  soe_patterns: ['央企', '国企', '国有'],
  low_fit_patterns: ['销售', '教师', '算法工程师'],
  generic_title_patterns: ['^校园招聘$', '^秋季校园招聘$'],
  source_priority_bonus: { '1': 6, '2': 5 },
  rules: {
    preferred_location_bonus: 10,
    financial_context_bonus: 6,
    soe_bonus: 12,
    advance_batch_bonus: 6,
    autumn_batch_bonus: 5,
    campus_batch_bonus: 3,
    summer_batch_bonus: 2,
    recent_update_bonus: { '0-3': 8, '4-7': 6, '8-14': 4, '15-30': 2 },
    future_deadline_bonus: { '20+': 6, '7-19': 4, '1-6': 2, rolling_recent: 3 },
    direct_career_link_bonus: 3,
    broad_listing_penalty: 18,
    generic_title_penalty: 20,
    mixed_low_fit_penalty: 18,
    stale_update_penalty: { '31-60': 12, '61+': 20 },
    manual_channel_penalty: 7,
  },
};

function candidate(overrides = {}) {
  return {
    source_file: 'fixture.csv',
    source_row: 4,
    source_priority: 1,
    company: '示例银行集团',
    employer_type: '央国企',
    industry: '金融',
    title: '授信风险分析实习生',
    cohort: '27届',
    batch: '2027届提前批',
    location: '上海',
    updated_at: '2026-07-23',
    deadline_at: '2026-08-31',
    deadline_status: 'dated',
    apply_url: 'https://careers.example.com/jobs/123',
    notes: '',
    verification_status: 'unverified',
    ...overrides,
  };
}

console.log('\ncandidate-screen.mjs — local coarse-screen safety and ranking');

const highFit = screenCandidate(candidate(), policy, '2026-07-24');
expect('specific credit-risk role becomes verification-ready', highFit.decision === 'verify' && highFit.verification_ready && highFit.coarse_score >= 38);
expect('SOE and financial evidence are kept in the audit trail', highFit.evidence.soe_matches.includes('国企') && highFit.evidence.financial_context_matches.includes('银行'));
expect('source batch label is never treated as an official autumn/early-batch confirmation', highFit.evidence.batch.source_claim === '提前批' && highFit.evidence.batch.official_status === 'unverified_source_claim' && highFit.cautions.some((item) => item.includes('批次尚未由官网确认')));

const chengduFit = screenCandidate(candidate({ location: '成都' }), policy, '2026-07-24');
expect('Chengdu ranks above an otherwise identical Shanghai role', chengduFit.coarse_score > highFit.coarse_score && chengduFit.evidence.preferred_city === '成都' && chengduFit.evidence.preferred_location_bonus === 15);

const conflictingBatch = screenCandidate(candidate({
  batch: '暑期实习',
  sources: [{ batch: '提前批' }],
}), policy, '2026-07-24');
expect('conflicting source batch labels stay ambiguous and receive no autumn/early-batch bonus', conflictingBatch.evidence.batch.track === 'ambiguous_source_claim' && conflictingBatch.evidence.batch.source_claim === null && !conflictingBatch.positive_reasons.some((item) => item.includes('源表标注：提前批')));

const broadMixed = screenCandidate(candidate({ title: '风险管理、财务管理、销售岗' }), policy, '2026-07-24');
expect('mixed multi-role listing is never verification-ready', broadMixed.decision === 'review' && !broadMixed.verification_ready && broadMixed.needs_role_extraction);

const strongButNoisy = screenCandidate(candidate({
  title: '信评岗、销售岗、算法工程师',
  updated_at: '2026-06-16',
}), policy, '2026-07-24');
expect('strong target inside a noisy aggregate is retained only for role extraction', strongButNoisy.decision === 'review' && !strongButNoisy.verification_ready && strongButNoisy.strong_extraction_candidate && strongButNoisy.coarse_score < 38 && strongButNoisy.evidence.primary_strong_role_matches.includes('信评'));

const salesOnly = screenCandidate(candidate({ title: '销售管培生', employer_type: '民营', industry: '零售' }), policy, '2026-07-24');
expect('sales-only listing is excluded despite a preferred city', salesOnly.decision === 'exclude' && salesOnly.exclusion_reasons.length > 0);

const stale = screenCandidate(candidate({ updated_at: '2026-04-01' }), policy, '2026-07-24');
expect('very stale source record is sent to review rather than automatic verification', stale.decision === 'review' && !stale.verification_ready && stale.evidence.update_age_days >= 61);

const result = screenCandidatePool({
  pool: {
    generated_at: '2026-07-24T00:00:00Z',
    source_count: 1,
    records: [
      candidate({ title: '销售管培生', employer_type: '民营', industry: '零售' }),
      candidate(),
      candidate({ title: '风险管理、财务管理、销售岗' }),
    ],
  },
  policy,
  asOf: '2026-07-24',
});
expect('pool returns one verification shortlist item and one review item', result.shortlist.length === 1 && result.review_queue.length === 1);
expect('pool preserves every candidate with a decision', result.records.length === 3 && result.records.every((record) => record.screening?.decision));

const resolved = screenCandidatePool({
  pool: {
    generated_at: '2026-07-24T00:00:00Z',
    source_count: 1,
    records: [candidate(), candidate({ title: '风险管理、财务管理、销售岗' })],
  },
  policy,
  reviewState: {
    schema_version: 1,
    entries: [{
      candidate_id: highFit.candidate_id,
      status: 'entered_pipeline',
      checked: '2026-07-24',
      pipeline: true,
    }],
  },
  asOf: '2026-07-24',
});
expect('processed candidates are removed from fresh verification and review queues', resolved.shortlist.length === 0 && resolved.review_queue.length === 1 && resolved.stats.processed_total === 1);
expect('processed candidates retain their original screen decision for audit', resolved.processed[0].screening.source_decision === 'verify' && resolved.processed[0].screening.review_state.status === 'entered_pipeline');
