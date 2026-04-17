import { nanoid } from 'nanoid';
import db from './db.js';

export interface ImportBatch {
  id: string;
  source: string;
  sourceType: string;
  channelId: string;
  totalCount: number;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  files: string[];
  createdAt: string;
}

interface BatchRow {
  id: string;
  source: string;
  sourceType: string;
  channelId: string;
  totalCount: number;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  files: string;
  createdAt: string;
}

function rowToBatch(row: BatchRow): ImportBatch {
  return {
    ...row,
    files: JSON.parse(row.files),
  };
}

const stmtInsert = db.prepare<[string, string, string, string, number, number, number, number, string, string]>(
  `INSERT INTO import_batches (id, source, sourceType, channelId, totalCount, addedCount, updatedCount, skippedCount, files, createdAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const stmtAll = db.prepare<[], BatchRow>('SELECT * FROM import_batches ORDER BY createdAt DESC');
const stmtById = db.prepare<[string], BatchRow>('SELECT * FROM import_batches WHERE id = ?');
const stmtRecent = db.prepare<[number], BatchRow>('SELECT * FROM import_batches ORDER BY createdAt DESC LIMIT ?');

export function create(params: {
  source: string;
  sourceType: string;
  channelId?: string;
  totalCount: number;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  files?: string[];
}): ImportBatch {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  stmtInsert.run(
    id, params.source, params.sourceType, params.channelId ?? '',
    params.totalCount, params.addedCount, params.updatedCount, params.skippedCount,
    JSON.stringify(params.files ?? []), createdAt,
  );
  return { id, createdAt, channelId: params.channelId ?? '', files: params.files ?? [], ...params };
}

export function findAll(): ImportBatch[] {
  return stmtAll.all().map(rowToBatch);
}

export function findById(id: string): ImportBatch | undefined {
  const row = stmtById.get(id);
  return row ? rowToBatch(row) : undefined;
}

export function findRecent(limit = 20): ImportBatch[] {
  return stmtRecent.all(limit).map(rowToBatch);
}

/** 更新批次中某个账号的 batchId */
export function setAccountBatchId(accountId: string, batchId: string): void {
  db.prepare('UPDATE accounts SET batchId = ? WHERE id = ?').run(batchId, accountId);
}

export function setAccountsBatchId(accountIds: string[], batchId: string): void {
  if (accountIds.length === 0) return;
  const doUpdate = db.transaction(() => {
    const stmt = db.prepare('UPDATE accounts SET batchId = ? WHERE id = ?');
    for (const id of accountIds) {
      stmt.run(batchId, id);
    }
  });
  doUpdate();
}
