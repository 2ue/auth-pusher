import db from './db.js';

export interface OpenAiOAuthFileState {
  path: string;
  email: string;
  contentHash: string;
  matchedAccountId?: string;
  matchedChannelId?: string;
  matchedChannelName?: string;
  matchedRemoteId?: string;
  matchStatus?: string;
  matchError?: string;
  lastMatchedAt?: string;
  lastRemoteUpdateHash?: string;
  lastRemoteUpdatedAt?: string;
  lastRemoteUpdateStatus?: string;
  lastRemoteUpdateError?: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenAiOAuthFileStateRow {
  path: string;
  email: string;
  contentHash: string;
  matchedAccountId: string;
  matchedChannelId: string;
  matchedChannelName: string;
  matchedRemoteId: string;
  matchStatus: string;
  matchError: string;
  lastMatchedAt: string;
  lastRemoteUpdateHash: string;
  lastRemoteUpdatedAt: string;
  lastRemoteUpdateStatus: string;
  lastRemoteUpdateError: string;
  createdAt: string;
  updatedAt: string;
}

function rowToState(row: OpenAiOAuthFileStateRow): OpenAiOAuthFileState {
  return {
    path: row.path,
    email: row.email,
    contentHash: row.contentHash,
    matchedAccountId: row.matchedAccountId || undefined,
    matchedChannelId: row.matchedChannelId || undefined,
    matchedChannelName: row.matchedChannelName || undefined,
    matchedRemoteId: row.matchedRemoteId || undefined,
    matchStatus: row.matchStatus || undefined,
    matchError: row.matchError || undefined,
    lastMatchedAt: row.lastMatchedAt || undefined,
    lastRemoteUpdateHash: row.lastRemoteUpdateHash || undefined,
    lastRemoteUpdatedAt: row.lastRemoteUpdatedAt || undefined,
    lastRemoteUpdateStatus: row.lastRemoteUpdateStatus || undefined,
    lastRemoteUpdateError: row.lastRemoteUpdateError || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const stmtAll = db.prepare<[], OpenAiOAuthFileStateRow>('SELECT * FROM openai_oauth_file_states');
const stmtByPath = db.prepare<[string], OpenAiOAuthFileStateRow>('SELECT * FROM openai_oauth_file_states WHERE path = ?');
const stmtUpsert = db.prepare(
  `INSERT INTO openai_oauth_file_states (
      path, email, contentHash, matchedAccountId, matchedChannelId, matchedChannelName, matchedRemoteId,
      matchStatus, matchError, lastMatchedAt, lastRemoteUpdateHash, lastRemoteUpdatedAt,
      lastRemoteUpdateStatus, lastRemoteUpdateError, createdAt, updatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      email = excluded.email,
      contentHash = excluded.contentHash,
      matchedAccountId = excluded.matchedAccountId,
      matchedChannelId = excluded.matchedChannelId,
      matchedChannelName = excluded.matchedChannelName,
      matchedRemoteId = excluded.matchedRemoteId,
      matchStatus = excluded.matchStatus,
      matchError = excluded.matchError,
      lastMatchedAt = excluded.lastMatchedAt,
      lastRemoteUpdateHash = excluded.lastRemoteUpdateHash,
      lastRemoteUpdatedAt = excluded.lastRemoteUpdatedAt,
      lastRemoteUpdateStatus = excluded.lastRemoteUpdateStatus,
      lastRemoteUpdateError = excluded.lastRemoteUpdateError,
      updatedAt = excluded.updatedAt`,
);

export function loadAll(): OpenAiOAuthFileState[] {
  return stmtAll.all().map(rowToState);
}

export function findByPath(filePath: string): OpenAiOAuthFileState | undefined {
  const row = stmtByPath.get(filePath);
  return row ? rowToState(row) : undefined;
}

export function upsert(input: {
  path: string;
  email: string;
  contentHash: string;
  matchedAccountId?: string;
  matchedChannelId?: string;
  matchedChannelName?: string;
  matchedRemoteId?: string;
  matchStatus?: string;
  matchError?: string;
  lastMatchedAt?: string;
  lastRemoteUpdateHash?: string;
  lastRemoteUpdatedAt?: string;
  lastRemoteUpdateStatus?: string;
  lastRemoteUpdateError?: string;
}): OpenAiOAuthFileState {
  const now = new Date().toISOString();
  const existing = findByPath(input.path);
  stmtUpsert.run(
    input.path,
    input.email,
    input.contentHash,
    input.matchedAccountId ?? '',
    input.matchedChannelId ?? '',
    input.matchedChannelName ?? '',
    input.matchedRemoteId ?? '',
    input.matchStatus ?? '',
    input.matchError ?? '',
    input.lastMatchedAt ?? existing?.lastMatchedAt ?? '',
    input.lastRemoteUpdateHash ?? existing?.lastRemoteUpdateHash ?? '',
    input.lastRemoteUpdatedAt ?? existing?.lastRemoteUpdatedAt ?? '',
    input.lastRemoteUpdateStatus ?? existing?.lastRemoteUpdateStatus ?? '',
    input.lastRemoteUpdateError ?? existing?.lastRemoteUpdateError ?? '',
    existing?.createdAt ?? now,
    now,
  );
  return findByPath(input.path)!;
}

export function remove(filePath: string): boolean {
  const result = db.prepare('DELETE FROM openai_oauth_file_states WHERE path = ?').run(filePath);
  return result.changes > 0;
}
