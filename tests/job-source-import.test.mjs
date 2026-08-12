// tests/job-source-import.test.mjs — CSV discovery import stays read-only.
//
// The fixture is created in the OS temp directory so the suite never touches
// the user's real job-source snapshots, candidate pool, pipeline, or tracker.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { pass, fail } from './helpers.mjs';
import {
  importJobSources,
  parseRfcCsv,
  parseSourceDate,
} from '../job-source-import.mjs';

function expect(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function writeCsv(dir, file, rows) {
  writeFileSync(join(dir, file), `\uFEFF${rows.map(csvRow).join('\r\n')}\r\n`, 'utf8');
}

console.log('\njob-source-import.mjs — six-source discovery-only import');

// RFC parsing must preserve a source row's physical starting line even when a
// quoted cell is multiline. This is the provenance contract the UI relies on.
const parsed = parseRfcCsv('\uFEFFa,b\r\n"multi\nline",x\r\nc,d\r\n');
expect('RFC CSV parser strips BOM and reads three records', parsed.length === 3 && parsed[0].values[0] === 'a');
expect('RFC CSV parser preserves quoted embedded newline', parsed[1].values[0] === 'multi\nline');
expect('RFC CSV parser reports physical start lines', parsed[1].startLine === 2 && parsed[2].startLine === 4);

const asOfDate = new Date('2026-07-24T00:00:00Z');
expect('Excel serial 46226 resolves to 2026-07-23', parseSourceDate('46226', asOfDate)?.toISOString().slice(0, 10) === '2026-07-23');
expect('Chinese date resolves against --as-of year', parseSourceDate('8月1日 19:00', asOfDate)?.toISOString().slice(0, 10) === '2026-08-01');
expect('invalid calendar date is rejected', parseSourceDate('2026-02-31', asOfDate) === null);

const fixtureDir = mkdtempSync(join(tmpdir(), 'career-ops-job-source-import-'));
const outputPath = join(fixtureDir, 'candidate-pool.json');

try {
  // 01/02 have two explanatory rows before the header. 01 also exercises a
  // trailing blank-column shape used by the real CSV.
  writeCsv(fixtureDir, '01_阿七.csv', [
    ['2027届实习+校招招聘信息表'],
    ['说明行'],
    ['序号', '公司名称', '行业大类', '企业性质', '批次', '招聘岗位', '招聘对象', '工作地点', '更新时间', '截止时间', '官方公告', '投递方式', '内推码/备注', ''],
    ['1', '阿七公司', '金融', '央国企', '秋招', '风险分析师', '2027届\n本科及以上', '上海', '2026.07.23', '招满即止', '公告 (https://notice.example/aqi)', '申请 (https://apply.example/job-one/)', '', ''],
  ]);

  writeCsv(fixtureDir, '02_毕业帮.csv', [
    ['', '', '说明行'],
    ['', '', '第二说明行'],
    ['更新/开启时间', '企业/招聘单位名称', '企业/单位性质', '行业分类', '招聘类型/批次', '招聘对象', '招聘岗位', '工作地点', '网申截止时间', '投递方式', '官方招聘推文', '备注'],
    ['46226', '重复来源公司', '民营', '互联网', '秋招', '27届', '风险分析师', '上海', '招满即止', '申请 (https://APPLY.example:443/job-one#fragment)', 'https://notice.example/duplicate', ''],
    ['46226', '邮件暑期公司', '民营', '互联网', '暑期实习', '27届', '暑期风控实习生', '成都', '尽快投递，招满即止', '请投递至 summer@example.com', 'https://notice.example/summer-mail', ''],
    ['46226', '已过期公司', '民营', '互联网', '秋招', '27届', '过期岗位', '上海', '2026.07.23', 'https://apply.example/expired', 'https://notice.example/expired', ''],
  ]);

  writeCsv(fixtureDir, '03_小师姐Emma.csv', [
    ['说明', '', '', ''],
    ['状态', '更新时间', '行业', '企业属性', '投递截止时间', '企业', '招聘项目', '招聘对象', 'base地', '招聘职位', '投递入口', '备注/提醒', ''],
    ['投递入口正常', '7月22日', '金融', '民营', '2026年8月1日', 'Emma公司', '暑期实习', '27届', '成都', '暑期风险实习生', 'https://apply.example/emma', '可申请', ''],
  ]);

  writeCsv(fixtureDir, '04_熬夜波比.csv', [
    ['公司名称', '公告标题', '所属行业', '类型', '地点（可筛选）', '网申开始时间', '投递截止时间', '公告链接', '投递官网链接', '添加进表格时间', '内推码'],
    ['无投递渠道公司', '2027届校园招聘', '金融', '27届校招含提前批', '上海', '2026-07-13', '2026-08-31', 'https://notice.example/no-apply', '', '2026-07-23', ''],
    ['波比邮件公司', '2027届暑期实习', '金融', '27届暑期实习', '北京', '2026-07-13', '未明确，尽快投', 'https://notice.example/bobi-mail', '投递邮箱 jobs@example.com', '2026-07-23', ''],
  ]);

  writeCsv(fixtureDir, '05_小林.csv', [
    ['公司名称', '企业性质', '行业大类', '批次', '招聘对象', '工作地点', '招聘岗位', '更新时间', '截止时间', '官方公告', '投递方式', '是否需要笔试', '备注/提示', '工作地点②-文本格式'],
    ['日常实习公司', '民营', '互联网', '日常实习', '2027届', '上海', '日常岗位', '2026/07/23', '招满即止', 'https://notice.example/daily', 'https://apply.example/daily', '', '', ''],
    ['小林秋招公司', '民营', '金融', '秋招', '2027届', '成都', '信用分析师', '2026/07/23', '2026/08/01', 'https://notice.example/xiaolin', 'https://apply.example/xiaolin', '', '', ''],
  ]);

  writeCsv(fixtureDir, '06_远哥.csv', [
    ['企业名称', '所在行业', '内推类型', '招聘岗位', '工作地点', '（跳转之后复制到浏览器打开）内推链接/官网', '内推码（区分大小码）', '投递注意事项', '笔试安排&校招日历', '毕业时间要求', '公司介绍', '对接人', '文本'],
    ['远哥提前批公司', '金融', '27届提前批', '风险策略岗', '上海', 'https://apply.example/yuange', 'CODE', '注意事项', '', '2026年9月-2027年8月毕业', '', '', '27届提前批'],
    ['远哥暑期公司', '金融', '27届暑期实习', '暑期策略岗', '上海', 'https://apply.example/yuange-summer', 'CODE', '注意事项', '', '2026年9月-2027年8月毕业', '', '', '暑期实习日更'],
  ]);

  const result = importJobSources({ sourceDir: fixtureDir, asOf: '2026-07-24' });
  expect('all six source files are read', result.source_count === 6 && result.stats.source_files_read === 6);
  expect('raw_record_count covers all nonblank fixture rows', result.raw_record_count === 11 && result.stats.records_read === 11);
  expect('real headers are discovered at 3/3/2/1/1/1', JSON.stringify(result.sources.map((source) => source.header_row)) === JSON.stringify([3, 3, 2, 1, 1, 1]));
  expect('records is the only full candidate array', Array.isArray(result.records) && !Object.hasOwn(result, 'candidates'));
  expect('all candidate and provenance records remain unverified', result.records.every((record) => record.verification_status === 'unverified' && record.sources.every((source) => source.verification_status === 'unverified')));
  expect('industry and employer type stay attached to the candidate evidence', result.records.find((record) => record.company === '阿七公司')?.employer_type === '央国企'
    && result.records.find((record) => record.company === '阿七公司')?.industry === '金融');
  expect('normalized URL dedup retains both source provenance records', result.records.find((record) => record.apply_url.includes('job-one'))?.source_chain.length === 2);
  expect('bare email in an apply field is normalized to mailto', result.records.some((record) => record.apply_url === 'mailto:summer@example.com'));
  expect('recent rolling summer internship is retained', result.records.some((record) => record.company === '邮件暑期公司'));
  expect('future dated summer internship is retained', result.records.some((record) => record.company === 'Emma公司'));
  expect('远哥 autumn record is retained with an unknown deadline', result.records.some((record) => record.company === '远哥提前批公司' && record.deadline_status === 'unknown' && record.deadline_at === null));
  expect('unsupported/expired/no-apply/summer-unknown cases are excluded and counted',
    !result.records.some((record) => ['日常实习公司', '已过期公司', '无投递渠道公司', '远哥暑期公司'].includes(record.company))
      && result.stats.excluded_by_reason.unsupported_track >= 1
      && result.stats.excluded_by_reason.expired_deadline >= 1
      && result.stats.excluded_by_reason.no_apply_url >= 1
      && result.stats.excluded_by_reason.summer_unknown_deadline >= 1
  );

  // A real CLI dry run receives an alternate source directory and output path
  // but must still leave that output path untouched.
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'job-source-import.mjs');
  const cli = spawnSync(process.execPath, [
    script,
    '--dry-run',
    '--source-dir', fixtureDir,
    '--output', outputPath,
    '--as-of', '2026-07-24',
  ], { encoding: 'utf8', timeout: 15000 });
  expect('--dry-run exits successfully', cli.status === 0);
  expect('--dry-run does not create its requested output file', !existsSync(outputPath));
  try {
    const summary = JSON.parse(cli.stdout);
    expect('--dry-run summary reports records and raw records', summary.dryRun === true && summary.raw_record_count === 11 && summary.records_count === result.records.length);
  } catch {
    fail('--dry-run summary is valid JSON');
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
