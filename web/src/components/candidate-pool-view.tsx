"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, Search, X } from "lucide-react";
import type { CandidatePool, CandidatePoolCandidate } from "@/lib/candidate-pool";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

const PAGE_SIZE = 50;

type PrimaryType = "all" | "autumn-27" | "summer" | "other";
type DeadlineFilter = "all" | "open" | "today" | "expired" | "unknown";
type DeadlineState = Exclude<DeadlineFilter, "all">;

const PRIMARY_TYPE_LABEL: Record<PrimaryType, string> = {
  all: "全部类型",
  "autumn-27": "27届秋招 / 提前批",
  summer: "暑期实习",
  other: "其他",
};

const DEADLINE_LABEL: Record<DeadlineState, string> = {
  open: "仍可能有效",
  today: "今日截止",
  expired: "已过截止日",
  unknown: "截止日未知",
};

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return String(date.getFullYear()) + "-" + month + "-" + day;
}

/** Preserve a date-only value instead of letting Date() move it across zones. */
function dateKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
}

function displayDate(value: string | undefined, fallback: string | undefined): string {
  return dateKey(value) ?? fallback?.trim() ?? "—";
}

function deadlineState(candidate: CandidatePoolCandidate, today: string): DeadlineState {
  if (candidate.deadline_status === "rolling") return "open";
  if (candidate.deadline_status === "unknown") return "unknown";
  const date = dateKey(candidate.deadline_at);
  if (date) {
    if (date < today) return "expired";
    if (date === today) return "today";
    return "open";
  }
  if (/(已截止|已结束|expired|closed)/i.test(candidate.deadline_raw ?? "")) return "expired";
  return "unknown";
}

function primaryType(candidate: CandidatePoolCandidate): Exclude<PrimaryType, "all"> {
  const batch = (candidate.batch ?? "") + " " + candidate.title;
  const cohort = (candidate.cohort ?? "") + " " + (candidate.batch ?? "");
  if (/(暑期|暑假|summer|intern|实习)/i.test(batch)) return "summer";
  if (/(27届|2027|秋招|提前批|fall|autumn)/i.test(cohort)) return "autumn-27";
  return "other";
}

function verification(candidate: CandidatePoolCandidate): { label: string; tone: "good" | "warn" | "bad" | "muted" } {
  const raw = candidate.verification_status?.trim();
  if (!raw || /(unverified|pending|未核验|待核验|unknown)/i.test(raw)) return { label: "未核验", tone: "warn" };
  if (/(invalid|expired|closed|失效|关闭|已截止)/i.test(raw)) return { label: raw, tone: "bad" };
  if (/(verified|active|有效|已核验)/i.test(raw)) return { label: raw, tone: "good" };
  return { label: raw, tone: "muted" };
}

function externalHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function CandidatePoolView({ pool }: { pool: CandidatePool }) {
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<PrimaryType>("all");
  const [source, setSource] = useState("");
  const [location, setLocation] = useState("");
  const [deadline, setDeadline] = useState<DeadlineFilter>("all");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const today = useMemo(() => localDateKey(new Date()), []);

  const sources = useMemo(() => uniqueSorted(pool.candidates.flatMap((candidate) => candidate.sources)), [pool.candidates]);
  const hasFilters = keyword.trim() !== "" || type !== "all" || source !== "" || location.trim() !== "" || deadline !== "all";

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase();
    const locationNeedle = location.trim().toLocaleLowerCase();
    return pool.candidates.filter((candidate) => {
      if (type !== "all" && primaryType(candidate) !== type) return false;
      if (source && !candidate.sources.includes(source)) return false;
      if (deadline !== "all" && deadlineState(candidate, today) !== deadline) return false;
      if (locationNeedle && !(candidate.location ?? "").toLocaleLowerCase().includes(locationNeedle)) return false;
      if (!needle) return true;
      const haystack = [
        candidate.company,
        candidate.title,
        candidate.cohort,
        candidate.batch,
        candidate.location,
        candidate.eligibility,
        candidate.notes,
        ...candidate.sources,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [deadline, keyword, location, pool.candidates, source, today, type]);

  useEffect(() => {
    setPage(0);
    setExpanded(null);
  }, [deadline, keyword, location, source, type]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filtered.length, (currentPage + 1) * PAGE_SIZE);

  const clearFilters = () => {
    setKeyword("");
    setType("all");
    setSource("");
    setLocation("");
    setDeadline("all");
  };

  const copy = async (value: string, id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        textarea.remove();
      }
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1800);
    } catch {
      const failed = id + ":failed";
      setCopied(failed);
      window.setTimeout(() => setCopied((current) => current === failed ? null : current), 2200);
    }
  };

  if (pool.state !== "ready") {
    return <PoolUnavailable pool={pool} />;
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-8 max-sm:pb-24">
      <PoolHeading pool={pool} />
      <ReadOnlyNotice />

      <section className="mt-5 rounded-2xl border border-border bg-surface/40 p-4 sm:p-5" aria-label="候选池筛选">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(10rem,0.9fr)_minmax(10rem,0.9fr)_minmax(9rem,0.8fr)_minmax(10rem,0.9fr)_auto]">
          <label className="relative block">
            <span className="sr-only">搜索候选岗位</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索公司、岗位、来源…"
              className="min-h-10 w-full rounded-md border border-border bg-surface/70 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
          <SelectFilter label="主类型" value={type} onChange={(value) => setType(value as PrimaryType)}>
            {Object.entries(PRIMARY_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectFilter>
          <SelectFilter label="来源" value={source} onChange={setSource}>
            <option value="">全部来源</option>
            {sources.map((item) => <option key={item} value={item}>{item}</option>)}
          </SelectFilter>
          <label className="block">
            <span className="sr-only">地点筛选</span>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="地点筛选"
              className="min-h-10 w-full rounded-md border border-border bg-surface/70 px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
          <SelectFilter label="截止状态" value={deadline} onChange={(value) => setDeadline(value as DeadlineFilter)}>
            <option value="all">全部截止状态</option>
            {Object.entries(DEADLINE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectFilter>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm text-muted transition-colors hover:border-brand/40 hover:text-foreground"
            >
              <X className="size-4" /> 清除
            </button>
          )}
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-muted">
          显示 <span className="font-medium tabular-nums text-foreground">{filtered.length}</span> / {pool.candidates.length} 个候选岗位
        </p>
        {filtered.length > 0 && <p className="text-xs text-faint tabular-nums">第 {rangeStart}–{rangeEnd} 条，共 {pageCount} 页</p>}
      </div>

      {pool.candidates.length === 0 ? (
        <EmptyPool />
      ) : filtered.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
          <p className="font-display text-lg text-landing">没有符合当前筛选的岗位</p>
          <button type="button" onClick={clearFilters} className="mt-3 text-sm font-medium text-brand-text hover:text-brand">清除筛选</button>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface/40">
          <div className="overflow-x-auto">
            <table className="min-w-[1110px] w-full text-sm">
              <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-4 py-3 font-medium">公司 / 岗位</th>
                  <th className="px-4 py-3 font-medium">届别 / 批次</th>
                  <th className="px-4 py-3 font-medium">地点</th>
                  <th className="px-4 py-3 font-medium">截止</th>
                  <th className="px-4 py-3 font-medium">更新时间</th>
                  <th className="px-4 py-3 font-medium">来源</th>
                  <th className="px-4 py-3 font-medium">核验</th>
                  <th className="px-4 py-3 font-medium"><span className="sr-only">来源链接</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((candidate, index) => (
                  <CandidateRow
                    key={candidate.id + "-" + String(currentPage * PAGE_SIZE + index)}
                    candidate={candidate}
                    today={today}
                    expanded={expanded === candidate.id}
                    onToggle={() => setExpanded((current) => current === candidate.id ? null : candidate.id)}
                    copied={copied}
                    onCopy={copy}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length > PAGE_SIZE && (
        <nav className="mt-4 flex items-center justify-end gap-2" aria-label="候选池分页">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={currentPage === 0}
            className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ChevronLeft className="size-4" /> 上一页
          </button>
          <span className="text-xs text-faint tabular-nums">{currentPage + 1} / {pageCount}</span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={currentPage >= pageCount - 1}
            className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            下一页 <ChevronRight className="size-4" />
          </button>
        </nav>
      )}
    </main>
  );
}

function PoolHeading({ pool }: { pool: CandidatePool }) {
  const snapshot = displayDate(pool.asOf ?? pool.generatedAt, undefined);
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-landing">候选池</h1>
        <p className="mt-1 text-sm text-muted">从已整理的职位表中浏览和初筛；不进入投递流程。</p>
      </div>
      {(snapshot !== "—" || pool.version || pool.scope) && (
        <p className="max-w-md text-right text-xs text-faint">
          {snapshot !== "—" && <>数据截至 <span className="tabular-nums">{snapshot}</span></>}
          {pool.version && <>{snapshot !== "—" ? " · " : ""}v{pool.version}</>}
          {pool.scope && <><br />{pool.scope}</>}
        </p>
      )}
    </header>
  );
}

function ReadOnlyNotice() {
  return (
    <div className="mt-5 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
      <p className="text-muted">
        <span className="font-medium text-amber-800 dark:text-amber-300">链接未核验，不能直接投递。</span>
        {" "}本页只读取本地候选数据；打开或复制链接不会写入 Pipeline、运行评估或提交申请。
      </p>
    </div>
  );
}

function PoolUnavailable({ pool }: { pool: CandidatePool }) {
  const malformed = pool.state === "invalid";
  return (
    <main className="mx-auto max-w-5xl px-6 py-8 max-sm:pb-24">
      <PoolHeading pool={pool} />
      <ReadOnlyNotice />
      <div className="mt-5 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
        <p className="font-display text-lg text-landing">{malformed ? "候选池暂时无法读取" : "候选池尚未生成"}</p>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
          {malformed
            ? "data/candidate-pool.json 的格式暂不受支持。请等待导入完成后刷新此页。"
            : <>请先在项目根目录运行 <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-foreground">node job-source-import.mjs</code>，它会生成 data/candidate-pool.json；随后刷新此页即可浏览。</>}
        </p>
      </div>
    </main>
  );
}

function EmptyPool() {
  return (
    <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
      <p className="font-display text-lg text-landing">候选池里还没有可显示的岗位</p>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted">请等待 CSV 导入完成，或检查导入器是否输出了有效候选记录。</p>
    </div>
  );
}

function SelectFilter({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-10 w-full appearance-none rounded-md border border-border bg-surface/70 px-3 py-2 pr-8 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {children}
      </select>
    </label>
  );
}

function CandidateRow({
  candidate,
  today,
  expanded,
  onToggle,
  copied,
  onCopy,
}: {
  candidate: CandidatePoolCandidate;
  today: string;
  expanded: boolean;
  onToggle: () => void;
  copied: string | null;
  onCopy: (value: string, id: string) => void;
}) {
  const deadline = deadlineState(candidate, today);
  const verify = verification(candidate);
  const names = candidate.sources.length > 0 ? candidate.sources.join(" · ") : "未标注来源";
  const links = [
    { label: "岗位详情链接", href: externalHref(candidate.apply_url), key: "role" },
    { label: "公告链接", href: externalHref(candidate.announcement_url), key: "announcement" },
  ].filter((link): link is { label: string; href: string; key: string } => Boolean(link.href));

  return (
    <>
      <tr className="align-top transition-colors hover:bg-surface/40">
        <td className="max-w-[280px] px-4 py-3">
          <p className="font-medium text-foreground">{candidate.company}</p>
          <p className="mt-0.5 leading-5 text-muted">{candidate.title}</p>
          {candidate.eligibility && <p className="mt-1 text-xs leading-4 text-faint">{candidate.eligibility}</p>}
        </td>
        <td className="px-4 py-3 text-muted">
          <p>{candidate.cohort ?? "—"}</p>
          <p className="mt-0.5 text-xs text-faint">{candidate.batch ?? "—"}</p>
        </td>
        <td className="max-w-[145px] px-4 py-3 text-muted">{candidate.location ?? "—"}</td>
        <td className="px-4 py-3">
          <Badge tone={deadline === "expired" ? "bad" : deadline === "today" ? "warn" : "muted"}>{DEADLINE_LABEL[deadline]}</Badge>
          <p className="mt-1 whitespace-nowrap text-xs text-faint tabular-nums">{displayDate(candidate.deadline_at, candidate.deadline_raw)}</p>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">{displayDate(candidate.updated_at, candidate.updated_raw)}</td>
        <td className="max-w-[210px] px-4 py-3">
          <p className="font-medium tabular-nums text-foreground">{candidate.sources.length} 个来源</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-faint" title={names}>{names}</p>
        </td>
        <td className="px-4 py-3"><Badge tone={verify.tone}>{verify.label}</Badge></td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
              expanded ? "border-brand/40 bg-brand-soft text-brand-text" : "border-border bg-surface text-muted hover:border-brand/40 hover:text-foreground",
            )}
          >
            <Link2 className="size-3.5" /> 来源链接
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface/30">
          <td colSpan={8} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <p className="mr-1 text-xs text-faint">链接未核验，不能直接投递。</p>
              {links.length > 0 ? links.map((link) => {
                const copyId = candidate.id + ":" + link.key;
                return (
                  <span key={link.key} className="inline-flex items-center gap-1.5">
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-foreground"
                    >
                      <ExternalLink className="size-3.5" /> 打开{link.label}
                    </a>
                    <button
                      type="button"
                      onClick={() => onCopy(link.href, copyId)}
                      className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      {copied === copyId ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
                      {copied === copyId ? "已复制" : copied === copyId + ":failed" ? "复制失败" : "复制"}
                    </button>
                  </span>
                );
              }) : <span className="text-xs text-faint">此记录没有可打开的来源链接。</span>}
              <p className="basis-full pt-1 text-xs leading-5 text-faint">来源链：{names}</p>
              {candidate.notes && <p className="basis-full pt-1 text-xs leading-5 text-muted">备注：{candidate.notes}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
