import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir(): string {
  const configured = process.env.AUTH_PUSHER_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  let cursor = currentDir;
  while (true) {
    const hasWorkspaceMarkers = ['client', 'server', 'shared'].every((name) =>
      fs.existsSync(path.join(cursor, name)),
    );
    if (hasWorkspaceMarkers) return path.join(cursor, 'data');

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return path.resolve(currentDir, '../../../data');
}

const DATA_DIR = resolveDataDir();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'auth-pusher.db');

const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Table creation ──────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    accessToken TEXT NOT NULL DEFAULT '',
    refreshToken TEXT NOT NULL DEFAULT '',
    idToken TEXT NOT NULL DEFAULT '',
    accountId TEXT NOT NULL DEFAULT '',
    organizationId TEXT NOT NULL DEFAULT '',
    planType TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    disabled INTEGER NOT NULL DEFAULT 0,
    expiredAt TEXT NOT NULL DEFAULT '',
    sourceType TEXT NOT NULL DEFAULT 'local',
    source TEXT NOT NULL DEFAULT '',
    sourceChannelId TEXT NOT NULL DEFAULT '',
    importedAt TEXT NOT NULL DEFAULT '',
    pushHistory TEXT NOT NULL DEFAULT '[]',
    lastProbe TEXT DEFAULT NULL,
    deletedAt TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pusherType TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    pusherConfig TEXT NOT NULL DEFAULT '{}',
    fieldMapping TEXT NOT NULL DEFAULT '{}',
    pushIntervalMs INTEGER DEFAULT NULL,
    pushConcurrency INTEGER DEFAULT NULL,
    defaultAccountFilter TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    multiFile INTEGER NOT NULL DEFAULT 0,
    recordsPath TEXT NOT NULL DEFAULT '',
    fieldMapping TEXT NOT NULL DEFAULT '{}',
    fingerprint TEXT NOT NULL DEFAULT '[]',
    builtin INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    tag TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'predefined'
  );

  CREATE TABLE IF NOT EXISTS push_tasks (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    channelName TEXT NOT NULL DEFAULT '',
    pusherType TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    totalItems INTEGER NOT NULL DEFAULT 0,
    successCount INTEGER NOT NULL DEFAULT 0,
    failedCount INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT '',
    completedAt TEXT DEFAULT NULL,
    items TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS file_records (
    id TEXT PRIMARY KEY,
    batchId TEXT NOT NULL DEFAULT '',
    originalName TEXT NOT NULL DEFAULT '',
    storedName TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    mimeType TEXT NOT NULL DEFAULT '',
    uploadedAt TEXT NOT NULL DEFAULT '',
    associatedTaskIds TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS quota_archives (
    id TEXT PRIMARY KEY,
    scopeKey TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '{}',
    quota TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    successCount INTEGER NOT NULL DEFAULT 0,
    errorCount INTEGER NOT NULL DEFAULT 0,
    tokenInvalidCount INTEGER NOT NULL DEFAULT 0,
    rateLimitedCount INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS usage_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'probe',
    status TEXT NOT NULL DEFAULT 'pending',
    scopeKey TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    successCount INTEGER NOT NULL DEFAULT 0,
    errorCount INTEGER NOT NULL DEFAULT 0,
    tokenInvalidCount INTEGER NOT NULL DEFAULT 0,
    rateLimitedCount INTEGER NOT NULL DEFAULT 0,
    startedAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT '',
    completedAt TEXT DEFAULT NULL,
    errorMessage TEXT DEFAULT NULL,
    quota TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    cronExpression TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    lastRunAt TEXT DEFAULT NULL,
    lastRunStatus TEXT DEFAULT NULL,
    lastRunError TEXT DEFAULT NULL,
    lastTaskId TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS account_events (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    eventType TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT '',
    sourceType TEXT NOT NULL DEFAULT 'local',
    channelId TEXT NOT NULL DEFAULT '',
    totalCount INTEGER NOT NULL DEFAULT 0,
    addedCount INTEGER NOT NULL DEFAULT 0,
    updatedCount INTEGER NOT NULL DEFAULT 0,
    skippedCount INTEGER NOT NULL DEFAULT 0,
    files TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS openai_oauth_file_states (
    path TEXT PRIMARY KEY,
    email TEXT NOT NULL DEFAULT '',
    contentHash TEXT NOT NULL DEFAULT '',
    matchedAccountId TEXT NOT NULL DEFAULT '',
    matchedChannelId TEXT NOT NULL DEFAULT '',
    matchedChannelName TEXT NOT NULL DEFAULT '',
    matchedRemoteId TEXT NOT NULL DEFAULT '',
    matchStatus TEXT NOT NULL DEFAULT '',
    matchError TEXT NOT NULL DEFAULT '',
    lastMatchedAt TEXT NOT NULL DEFAULT '',
    lastRemoteUpdateHash TEXT NOT NULL DEFAULT '',
    lastRemoteUpdatedAt TEXT NOT NULL DEFAULT '',
    lastRemoteUpdateStatus TEXT NOT NULL DEFAULT '',
    lastRemoteUpdateError TEXT NOT NULL DEFAULT '',
    lastRemoteActionType TEXT NOT NULL DEFAULT '',
    lastRemoteActionAt TEXT NOT NULL DEFAULT '',
    lastRemoteActionStatus TEXT NOT NULL DEFAULT '',
    lastRemoteActionError TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT ''
  );
`);

// ── Migrations (must run BEFORE indexes) ──────────────────────

const accountCols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
if (!accountCols.some((c) => c.name === 'deletedAt')) {
  db.exec('ALTER TABLE accounts ADD COLUMN deletedAt TEXT DEFAULT NULL');
}
if (!accountCols.some((c) => c.name === 'deleteReason')) {
  db.exec("ALTER TABLE accounts ADD COLUMN deleteReason TEXT NOT NULL DEFAULT ''");
}
if (!accountCols.some((c) => c.name === 'batchId')) {
  db.exec("ALTER TABLE accounts ADD COLUMN batchId TEXT NOT NULL DEFAULT ''");
}
if (!accountCols.some((c) => c.name === 'sourceChannelId')) {
  db.exec("ALTER TABLE accounts ADD COLUMN sourceChannelId TEXT NOT NULL DEFAULT ''");
}

const openAiOauthFileStateCols = db.prepare("PRAGMA table_info(openai_oauth_file_states)").all() as { name: string }[];
if (!openAiOauthFileStateCols.some((c) => c.name === 'lastRemoteActionType')) {
  db.exec("ALTER TABLE openai_oauth_file_states ADD COLUMN lastRemoteActionType TEXT NOT NULL DEFAULT ''");
}
if (!openAiOauthFileStateCols.some((c) => c.name === 'lastRemoteActionAt')) {
  db.exec("ALTER TABLE openai_oauth_file_states ADD COLUMN lastRemoteActionAt TEXT NOT NULL DEFAULT ''");
}
if (!openAiOauthFileStateCols.some((c) => c.name === 'lastRemoteActionStatus')) {
  db.exec("ALTER TABLE openai_oauth_file_states ADD COLUMN lastRemoteActionStatus TEXT NOT NULL DEFAULT ''");
}
if (!openAiOauthFileStateCols.some((c) => c.name === 'lastRemoteActionError')) {
  db.exec("ALTER TABLE openai_oauth_file_states ADD COLUMN lastRemoteActionError TEXT NOT NULL DEFAULT ''");
}

// ── Indexes ─────────────────────────────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  CREATE INDEX IF NOT EXISTS idx_accounts_planType ON accounts(planType);
  CREATE INDEX IF NOT EXISTS idx_accounts_sourceType ON accounts(sourceType);
  CREATE INDEX IF NOT EXISTS idx_accounts_sourceChannelId ON accounts(sourceChannelId);
  CREATE INDEX IF NOT EXISTS idx_accounts_disabled ON accounts(disabled);
  CREATE INDEX IF NOT EXISTS idx_accounts_expiredAt ON accounts(expiredAt);
  CREATE INDEX IF NOT EXISTS idx_accounts_importedAt ON accounts(importedAt);
  CREATE INDEX IF NOT EXISTS idx_accounts_deletedAt ON accounts(deletedAt);

  CREATE INDEX IF NOT EXISTS idx_channels_pusherType ON channels(pusherType);

  CREATE INDEX IF NOT EXISTS idx_push_tasks_status ON push_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_push_tasks_createdAt ON push_tasks(createdAt);

  CREATE INDEX IF NOT EXISTS idx_file_records_batchId ON file_records(batchId);
  CREATE INDEX IF NOT EXISTS idx_file_records_storedName ON file_records(storedName);

  CREATE INDEX IF NOT EXISTS idx_quota_archives_scopeKey ON quota_archives(scopeKey);
  CREATE INDEX IF NOT EXISTS idx_quota_archives_createdAt ON quota_archives(createdAt);

  CREATE INDEX IF NOT EXISTS idx_usage_jobs_scopeKey ON usage_jobs(scopeKey);
  CREATE INDEX IF NOT EXISTS idx_usage_jobs_status ON usage_jobs(status);

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_channelId ON scheduled_tasks(channelId);

  CREATE INDEX IF NOT EXISTS idx_account_events_accountId ON account_events(accountId);
  CREATE INDEX IF NOT EXISTS idx_account_events_eventType ON account_events(eventType);
  CREATE INDEX IF NOT EXISTS idx_account_events_createdAt ON account_events(createdAt);

  CREATE INDEX IF NOT EXISTS idx_import_batches_createdAt ON import_batches(createdAt);
  CREATE INDEX IF NOT EXISTS idx_accounts_batchId ON accounts(batchId);
  CREATE INDEX IF NOT EXISTS idx_openai_oauth_file_states_email ON openai_oauth_file_states(email);
  CREATE INDEX IF NOT EXISTS idx_openai_oauth_file_states_matchedChannelId ON openai_oauth_file_states(matchedChannelId);
`);

export default db;
