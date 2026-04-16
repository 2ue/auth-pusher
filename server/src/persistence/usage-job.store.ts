import type { QuotaArchiveScope, QuotaSummary } from '../../../shared/types/quota.js';
import db from './db.js';

const MAX_JOBS = 300;

export type PersistedUsageJobMode = 'probe' | 'quota';
export type PersistedUsageJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PersistedUsageJobRecord {
  id: string;
  mode: PersistedUsageJobMode;
  scope: QuotaArchiveScope;
  scopeKey: string;
  status: PersistedUsageJobStatus;
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  quota: QuotaSummary;
  errorMessage?: string;
}

interface JobRow {
  id: string;
  mode: string;
  status: string;
  scopeKey: string;
  scope: string;
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  quota: string;
}

function rowToJob(row: JobRow): PersistedUsageJobRecord {
  const quota = JSON.parse(row.quota);
  if (quota.availableNow === undefined) {
    quota.availableNow = 0;
  }
  return {
    id: row.id,
    mode: row.mode as PersistedUsageJobMode,
    status: row.status as PersistedUsageJobStatus,
    scopeKey: row.scopeKey,
    scope: JSON.parse(row.scope),
    total: row.total,
    processed: row.processed,
    successCount: row.successCount,
    errorCount: row.errorCount,
    tokenInvalidCount: row.tokenInvalidCount,
    rateLimitedCount: row.rateLimitedCount,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
    quota,
    errorMessage: row.errorMessage ?? undefined,
  };
}

const stmtAll = db.prepare<[], JobRow>(
  'SELECT * FROM usage_jobs ORDER BY COALESCE(startedAt, updatedAt) DESC',
);
const stmtById = db.prepare<[string], JobRow>('SELECT * FROM usage_jobs WHERE id = ?');
const stmtUpsert = db.prepare<[string, string, string, string, string, number, number, number, number, number, number, string, string, string | null, string | null, string]>(
  `INSERT INTO usage_jobs (id, mode, status, scopeKey, scope, total, processed, successCount, errorCount, tokenInvalidCount, rateLimitedCount, startedAt, updatedAt, completedAt, errorMessage, quota)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     mode = excluded.mode,
     status = excluded.status,
     scopeKey = excluded.scopeKey,
     scope = excluded.scope,
     total = excluded.total,
     processed = excluded.processed,
     successCount = excluded.successCount,
     errorCount = excluded.errorCount,
     tokenInvalidCount = excluded.tokenInvalidCount,
     rateLimitedCount = excluded.rateLimitedCount,
     startedAt = excluded.startedAt,
     updatedAt = excluded.updatedAt,
     completedAt = excluded.completedAt,
     errorMessage = excluded.errorMessage,
     quota = excluded.quota`,
);
const stmtCount = db.prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM usage_jobs');
const stmtPruneOldest = db.prepare<[number]>(
  `DELETE FROM usage_jobs WHERE id NOT IN (SELECT id FROM usage_jobs ORDER BY COALESCE(startedAt, updatedAt) DESC LIMIT ?)`,
);
const stmtByScopeKey = db.prepare<[string], JobRow>(
  'SELECT * FROM usage_jobs WHERE scopeKey = ? ORDER BY COALESCE(startedAt, updatedAt) DESC LIMIT 1',
);
const stmtByScopeKeyMode = db.prepare<[string, string], JobRow>(
  'SELECT * FROM usage_jobs WHERE scopeKey = ? AND mode = ? ORDER BY COALESCE(startedAt, updatedAt) DESC LIMIT 1',
);
const stmtRunningByScopeKey = db.prepare<[string], JobRow>(
  `SELECT * FROM usage_jobs WHERE scopeKey = ? AND status IN ('pending', 'running') ORDER BY COALESCE(startedAt, updatedAt) DESC LIMIT 1`,
);
const stmtRunningByScopeKeyMode = db.prepare<[string, string], JobRow>(
  `SELECT * FROM usage_jobs WHERE scopeKey = ? AND mode = ? AND status IN ('pending', 'running') ORDER BY COALESCE(startedAt, updatedAt) DESC LIMIT 1`,
);
const stmtMarkUnfinished = db.prepare<[string, string, string]>(
  `UPDATE usage_jobs SET status = 'failed', updatedAt = ?, completedAt = ?, errorMessage = ? WHERE status IN ('pending', 'running')`,
);

export function loadJobs(): PersistedUsageJobRecord[] {
  return stmtAll.all().map(rowToJob);
}

export function saveJobs(jobs: PersistedUsageJobRecord[]) {
  const doSave = db.transaction(() => {
    db.exec('DELETE FROM usage_jobs');
    for (const job of jobs.slice(0, MAX_JOBS)) {
      stmtUpsert.run(
        job.id, job.mode, job.status, job.scopeKey,
        JSON.stringify(job.scope), job.total, job.processed,
        job.successCount, job.errorCount, job.tokenInvalidCount, job.rateLimitedCount,
        job.startedAt, job.updatedAt, job.completedAt ?? null,
        job.errorMessage ?? null, JSON.stringify(job.quota),
      );
    }
  });
  doSave();
}

export function upsertJob(job: PersistedUsageJobRecord) {
  const doUpsert = db.transaction(() => {
    stmtUpsert.run(
      job.id, job.mode, job.status, job.scopeKey,
      JSON.stringify(job.scope), job.total, job.processed,
      job.successCount, job.errorCount, job.tokenInvalidCount, job.rateLimitedCount,
      job.startedAt, job.updatedAt, job.completedAt ?? null,
      job.errorMessage ?? null, JSON.stringify(job.quota),
    );
    // Prune to keep MAX_JOBS
    const { cnt } = stmtCount.get()!;
    if (cnt > MAX_JOBS) {
      stmtPruneOldest.run(MAX_JOBS);
    }
  });
  doUpsert();
}

export function findJob(id: string): PersistedUsageJobRecord | undefined {
  const row = stmtById.get(id);
  return row ? rowToJob(row) : undefined;
}

export function findLatestByScope(scopeKey: string, mode?: PersistedUsageJobMode): PersistedUsageJobRecord | undefined {
  const row = mode
    ? stmtByScopeKeyMode.get(scopeKey, mode)
    : stmtByScopeKey.get(scopeKey);
  return row ? rowToJob(row) : undefined;
}

export function findRunningByScope(scopeKey: string, mode?: PersistedUsageJobMode): PersistedUsageJobRecord | undefined {
  const row = mode
    ? stmtRunningByScopeKeyMode.get(scopeKey, mode)
    : stmtRunningByScopeKey.get(scopeKey);
  return row ? rowToJob(row) : undefined;
}

export function markUnfinishedAsFailed(message: string) {
  const now = new Date().toISOString();
  stmtMarkUnfinished.run(now, now, message);
}
