import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * A candidate is discovery data only. It is intentionally separate from the
 * pipeline and application-tracker types so this reader cannot promote a role
 * into either workflow.
 */
export type CandidatePoolCandidate = {
  id: string;
  company: string;
  title: string;
  cohort?: string;
  batch?: string;
  location?: string;
  updated_raw?: string;
  updated_at?: string;
  deadline_raw?: string;
  deadline_at?: string;
  deadline_status?: string;
  apply_url?: string;
  announcement_url?: string;
  notes?: string;
  verification_status?: string;
  eligibility?: string;
  source_priority?: number;
  sources: string[];
};

export type CandidatePool = {
  state: "ready" | "missing" | "invalid";
  version?: string;
  generatedAt?: string;
  asOf?: string;
  scope?: string;
  stats?: { total?: number };
  candidates: CandidatePoolCandidate[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find(Array.isArray) as unknown[] | undefined;
}

function scopeText(value: unknown): string | undefined {
  return text(value) ?? (isRecord(value) ? firstText(value.cohort) : undefined);
}

function cleanSourceName(value: string): string {
  return value
    .replace(/^.*[\\/]/, "")
    .replace(/^\d+_?/, "")
    .replace(/\.csv$/i, "")
    .trim();
}

/** Current rows use sources objects; older snapshots used names directly. */
function sourceNames(value: unknown, fallback: unknown[]): string[] {
  const values = Array.isArray(value) ? value : value == null ? fallback : [value];
  const names: string[] = [];
  for (const item of values) {
    const name = isRecord(item)
      ? firstText(item.name, item.label, item.source_name, item.source, item.source_file, item.title)
      : text(item);
    const clean = name ? cleanSourceName(name) : undefined;
    if (clean && !names.some((existing) => existing.toLocaleLowerCase() === clean.toLocaleLowerCase())) names.push(clean);
  }
  return names;
}

function candidateFrom(value: unknown, index: number): CandidatePoolCandidate | null {
  if (!isRecord(value)) return null;
  const company = firstText(value.company, value.company_name, value.employer) ?? "未提供公司";
  const title = firstText(value.title, value.role, value.position, value.job_title) ?? "未提供岗位";
  const location = firstText(value.location, value.city, value.locations);
  const id = firstText(value.id, value.key, value.job_id) ?? [company, title, location ?? "", String(index)].join("|");

  return {
    id,
    company,
    title,
    cohort: firstText(value.cohort, value.graduation_cohort, value.graduationYear),
    batch: firstText(value.batch, value.recruitment_batch, value.recruiting_batch, value.type),
    location,
    updated_raw: firstText(value.updated_raw, value.updatedRaw, value.update_raw, value.updated),
    updated_at: firstText(value.updated_at, value.updatedAt, value.update_at),
    deadline_raw: firstText(value.deadline_raw, value.deadlineRaw, value.deadline),
    deadline_at: firstText(value.deadline_at, value.deadlineAt),
    deadline_status: firstText(value.deadline_status, value.deadlineStatus),
    apply_url: firstText(value.apply_url, value.applyUrl, value.job_url, value.url, value.link),
    announcement_url: firstText(value.announcement_url, value.announcementUrl, value.notice_url, value.source_url),
    notes: firstText(value.notes, value.note, value.remark, value.remarks),
    verification_status: firstText(value.verification_status, value.verificationStatus, value.status),
    eligibility: firstText(value.eligibility, value.eligible, value.requirements),
    source_priority: numberValue(value.source_priority ?? value.sourcePriority ?? value.priority),
    sources: sourceNames(value.sources ?? value.source_chain, [value.source_name, value.source, value.source_file]),
  };
}

function poolFrom(value: unknown): CandidatePool | null {
  const root = Array.isArray(value) ? undefined : isRecord(value) ? value : undefined;
  if (!root && !Array.isArray(value)) return null;
  // Records is the importer contract. Candidates remains a read-only fallback
  // for snapshots made before that contract was finalized.
  const records = Array.isArray(value)
    ? value
    : firstArray(root?.records, root?.candidates, root?.items, root?.jobs) ?? [];
  const candidates = records
    .map(candidateFrom)
    .filter((candidate): candidate is CandidatePoolCandidate => candidate !== null);
  const stats = isRecord(root?.stats) ? { total: numberValue(root.stats.total ?? root.stats.count ?? root.stats.candidates_after_dedup) } : undefined;

  return {
    state: "ready",
    version: firstText(root?.version),
    generatedAt: firstText(root?.generatedAt, root?.generated_at),
    asOf: firstText(root?.asOf, root?.as_of, root?.date),
    scope: scopeText(root?.scope),
    stats,
    candidates,
  };
}

/**
 * Read the importer output locally. A missing/malformed file is a normal
 * transition while the importer runs, so no exception escapes into the page.
 */
export function readCandidatePool(): CandidatePool {
  const file = path.join(careerOpsRoot(), "data", "candidate-pool.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "missing", candidates: [] };
  }
  try {
    return poolFrom(JSON.parse(raw)) ?? { state: "invalid", candidates: [] };
  } catch {
    return { state: "invalid", candidates: [] };
  }
}
