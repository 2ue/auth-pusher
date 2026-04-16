import type { QuotaArchive } from '../../../shared/types/quota.js';
import db from './db.js';

const MAX_ARCHIVES = 300;

interface ArchiveRow {
  id: string;
  scopeKey: string;
  scope: string;
  quota: string;
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  createdAt: string;
}

function rowToArchive(row: ArchiveRow): QuotaArchive {
  const quota = JSON.parse(row.quota);
  if (quota.availableNow === undefined) {
    quota.availableNow = 0;
  }
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    scope: JSON.parse(row.scope),
    quota,
    total: row.total,
    processed: row.processed,
    successCount: row.successCount,
    errorCount: row.errorCount,
    tokenInvalidCount: row.tokenInvalidCount,
    rateLimitedCount: row.rateLimitedCount,
    createdAt: row.createdAt,
  };
}

const stmtAll = db.prepare<[], ArchiveRow>('SELECT * FROM quota_archives ORDER BY createdAt DESC');
const stmtInsert = db.prepare<[string, string, string, string, number, number, number, number, number, number, string]>(
  `INSERT INTO quota_archives (id, scopeKey, scope, quota, total, processed, successCount, errorCount, tokenInvalidCount, rateLimitedCount, createdAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const stmtByScopeKey = db.prepare<[string], ArchiveRow>('SELECT * FROM quota_archives WHERE scopeKey = ? ORDER BY createdAt DESC LIMIT 1');
const stmtCount = db.prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM quota_archives');
const stmtPruneOldest = db.prepare<[number]>(
  `DELETE FROM quota_archives WHERE id NOT IN (SELECT id FROM quota_archives ORDER BY createdAt DESC LIMIT ?)`,
);

export function loadArchives(): QuotaArchive[] {
  return stmtAll.all().map(rowToArchive);
}

export function appendArchive(archive: QuotaArchive) {
  const doAppend = db.transaction(() => {
    stmtInsert.run(
      archive.id, archive.scopeKey,
      JSON.stringify(archive.scope), JSON.stringify(archive.quota),
      archive.total, archive.processed, archive.successCount,
      archive.errorCount, archive.tokenInvalidCount, archive.rateLimitedCount,
      archive.createdAt,
    );
    // Prune to keep MAX_ARCHIVES
    const { cnt } = stmtCount.get()!;
    if (cnt > MAX_ARCHIVES) {
      stmtPruneOldest.run(MAX_ARCHIVES);
    }
  });
  doAppend();
}

export function findLatestByScope(scopeKey: string): QuotaArchive | undefined {
  const row = stmtByScopeKey.get(scopeKey);
  return row ? rowToArchive(row) : undefined;
}
