import type { Account, AccountQuery, AccountStats } from '../../../shared/types/account.js';
import db from './db.js';
import * as settingsStore from './settings.store.js';

interface AccountRow {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  organizationId: string;
  planType: string;
  tags: string;
  disabled: number;
  expiredAt: string;
  sourceType: string;
  source: string;
  importedAt: string;
  pushHistory: string;
  lastProbe: string | null;
  deletedAt: string | null;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    idToken: row.idToken,
    accountId: row.accountId,
    organizationId: row.organizationId,
    planType: row.planType,
    tags: JSON.parse(row.tags),
    disabled: row.disabled === 1,
    expiredAt: row.expiredAt,
    sourceType: (row.sourceType || 'local') as Account['sourceType'],
    source: row.source,
    importedAt: row.importedAt,
    pushHistory: JSON.parse(row.pushHistory),
    lastProbe: row.lastProbe ? JSON.parse(row.lastProbe) : null,
    deletedAt: row.deletedAt ?? undefined,
  };
}

// ── Prepared statements ─────────────────────────────────────────

const stmtAll = db.prepare<[], AccountRow>('SELECT * FROM accounts WHERE deletedAt IS NULL');
const stmtAllIncludeDeleted = db.prepare<[], AccountRow>('SELECT * FROM accounts');
const stmtById = db.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE id = ?');
const stmtByEmail = db.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE email = ?');
const stmtDeleteById = db.prepare<[string]>('DELETE FROM accounts WHERE id = ?');
const stmtUpsertByEmail = db.prepare<[string, string, string, string, string, string, string, string, string, number, string, string, string, string, string, string | null]>(
  `INSERT INTO accounts (id, email, accessToken, refreshToken, idToken, accountId, organizationId, planType, tags, disabled, expiredAt, sourceType, source, importedAt, pushHistory, lastProbe)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(email) DO UPDATE SET
     accessToken = CASE WHEN excluded.accessToken != '' THEN excluded.accessToken ELSE accounts.accessToken END,
     refreshToken = CASE WHEN excluded.refreshToken != '' THEN excluded.refreshToken ELSE accounts.refreshToken END,
     idToken = CASE WHEN excluded.idToken != '' THEN excluded.idToken ELSE accounts.idToken END,
     accountId = CASE WHEN excluded.accountId != '' THEN excluded.accountId ELSE accounts.accountId END,
     organizationId = CASE WHEN excluded.organizationId != '' THEN excluded.organizationId ELSE accounts.organizationId END,
     planType = CASE WHEN excluded.planType != '' THEN excluded.planType ELSE accounts.planType END,
     disabled = excluded.disabled,
     expiredAt = CASE WHEN excluded.expiredAt != '' THEN excluded.expiredAt ELSE accounts.expiredAt END,
     sourceType = COALESCE(NULLIF(excluded.sourceType, ''), accounts.sourceType),
     source = accounts.source,
     importedAt = accounts.importedAt,
     deletedAt = NULL`,
);
const stmtInsert = db.prepare<[string, string, string, string, string, string, string, string, string, number, string, string, string, string, string, string | null]>(
  `INSERT OR IGNORE INTO accounts (id, email, accessToken, refreshToken, idToken, accountId, organizationId, planType, tags, disabled, expiredAt, sourceType, source, importedAt, pushHistory, lastProbe)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const stmtUpdateProbe = db.prepare<[string | null, string]>('UPDATE accounts SET lastProbe = ? WHERE id = ?');
const stmtUpdatePushHistory = db.prepare<[string, string]>('UPDATE accounts SET pushHistory = ? WHERE email = ?');

// ── Public API ──────────────────────────────────────────────────

export function loadAll(includeDeleted = false): Account[] {
  const stmt = includeDeleted ? stmtAllIncludeDeleted : stmtAll;
  return stmt.all().map(rowToAccount);
}

export function save(accounts: Account[]): void {
  const stmtSaveInsert = db.prepare(
    `INSERT OR IGNORE INTO accounts (id, email, accessToken, refreshToken, idToken, accountId, organizationId, planType, tags, disabled, expiredAt, sourceType, source, importedAt, pushHistory, lastProbe, deletedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const doSave = db.transaction(() => {
    db.exec('DELETE FROM accounts');
    for (const a of accounts) {
      stmtSaveInsert.run(
        a.id, a.email, a.accessToken, a.refreshToken, a.idToken,
        a.accountId, a.organizationId, a.planType,
        JSON.stringify(a.tags ?? []), a.disabled ? 1 : 0,
        a.expiredAt, a.sourceType ?? inferSourceType(a.source), a.source,
        a.importedAt, JSON.stringify(a.pushHistory),
        a.lastProbe ? JSON.stringify(a.lastProbe) : null,
        a.deletedAt ?? null,
      );
    }
  });
  doSave();
}

export function findByEmail(email: string): Account | undefined {
  const row = stmtByEmail.get(email);
  return row ? rowToAccount(row) : undefined;
}

export function findById(id: string): Account | undefined {
  const row = stmtById.get(id);
  return row ? rowToAccount(row) : undefined;
}

/** 批量 upsert: 按 email 去重，已存在则更新 token，保留 pushHistory */
export function upsertBatch(incoming: Account[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;

  const doUpsert = db.transaction(() => {
    for (const item of incoming) {
      const existing = stmtByEmail.get(item.email);
      if (existing) {
        // Merge tags
        const existingTags: string[] = JSON.parse(existing.tags);
        const mergedTags = [...new Set([...existingTags, ...(item.tags ?? [])])];
        // Merge probe
        const mergedProbe = item.lastProbe
          ? JSON.stringify(item.lastProbe)
          : existing.lastProbe;

        stmtUpsertByEmail.run(
          item.id, item.email,
          item.accessToken || '', item.refreshToken || '',
          item.idToken || '', item.accountId || '',
          item.organizationId || '', item.planType || '',
          JSON.stringify(mergedTags), item.disabled ? 1 : 0,
          item.expiredAt || '', item.sourceType ?? '',
          item.source, item.importedAt,
          existing.pushHistory, // keep existing pushHistory
          mergedProbe,
        );
        // Update tags separately since upsert ON CONFLICT doesn't merge JSON arrays
        db.prepare('UPDATE accounts SET tags = ?, lastProbe = ? WHERE email = ?').run(
          JSON.stringify(mergedTags), mergedProbe, item.email,
        );
        updated++;
      } else {
        stmtInsert.run(
          item.id, item.email, item.accessToken, item.refreshToken,
          item.idToken, item.accountId, item.organizationId, item.planType,
          JSON.stringify(item.tags ?? []), item.disabled ? 1 : 0,
          item.expiredAt, item.sourceType ?? inferSourceType(item.source),
          item.source, item.importedAt,
          JSON.stringify(item.pushHistory ?? []),
          item.lastProbe ? JSON.stringify(item.lastProbe) : null,
        );
        added++;
      }
    }
  });
  doUpsert();
  return { added, updated };
}

export function remove(id: string): boolean {
  const result = stmtDeleteById.run(id);
  return result.changes > 0;
}

export function removeBatch(ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`);
  const result = stmt.run(...ids);
  return result.changes;
}

// ── Soft delete ────────────────────────────────────────────────

export function softDelete(id: string): boolean {
  const result = db.prepare('UPDATE accounts SET deletedAt = ? WHERE id = ?').run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function softDeleteBatch(ids: string[]): number {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`UPDATE accounts SET deletedAt = ? WHERE id IN (${placeholders})`);
  const result = stmt.run(now, ...ids);
  return result.changes;
}

export function restore(id: string): boolean {
  const result = db.prepare('UPDATE accounts SET deletedAt = NULL WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateTags(id: string, tags: string[]): void {
  db.prepare('UPDATE accounts SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
}

// ── Query helpers ───────────────────────────────────────────────

interface FilterResult {
  whereClause: string;
  params: unknown[];
}

function buildFilters(q: Omit<AccountQuery, 'limit' | 'offset'>): FilterResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Soft delete filter: exclude deleted by default
  if (!q.includeDeleted) {
    conditions.push('deletedAt IS NULL');
  }

  if (q.planType) {
    conditions.push('planType = ?');
    params.push(q.planType);
  }
  if (q.expired === true) {
    conditions.push("expiredAt != '' AND expiredAt < ?");
    params.push(new Date().toISOString());
  } else if (q.expired === false) {
    conditions.push("(expiredAt = '' OR expiredAt >= ?)");
    params.push(new Date().toISOString());
  }
  if (q.disabled === true) {
    conditions.push('disabled = 1');
  } else if (q.disabled === false) {
    conditions.push('disabled = 0');
  }
  if (q.sourceType) {
    conditions.push('sourceType = ?');
    params.push(q.sourceType);
  }
  if (q.source) {
    conditions.push('LOWER(source) LIKE ?');
    params.push(`%${q.source.toLowerCase()}%`);
  }
  if (q.importDateFrom) {
    conditions.push('importedAt >= ?');
    params.push(q.importDateFrom);
  }
  if (q.importDateTo) {
    conditions.push('importedAt <= ?');
    params.push(q.importDateTo);
  }
  if (q.search) {
    conditions.push('LOWER(email) LIKE ?');
    params.push(`%${q.search.toLowerCase()}%`);
  }

  // notPushedTo and tags require JS-level filtering on JSON columns,
  // but we can still apply SQL-level filters first to reduce the dataset.
  // These are handled post-query.

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

/**
 * Apply JS-level filters that can't be done in SQL (JSON array operations).
 * These are: notPushedTo, tags
 */
function applyJsFilters(accounts: Account[], q: Omit<AccountQuery, 'limit' | 'offset'>): Account[] {
  let result = accounts;

  if (q.notPushedTo) {
    const channelId = q.notPushedTo;
    result = result.filter((a) =>
      !a.pushHistory.some((h) => h.channelId === channelId && h.status === 'success'),
    );
  }
  if (q.tags && q.tags.length > 0) {
    result = result.filter((a) =>
      q.tags!.every((tag) => (a.tags ?? []).includes(tag)),
    );
  }

  return result;
}

export function query(q: AccountQuery): Account[] {
  const { whereClause, params } = buildFilters(q);
  const sql = `SELECT * FROM accounts ${whereClause}`;
  const rows = db.prepare(sql).all(...params) as AccountRow[];
  let accounts = rows.map(rowToAccount);
  accounts = applyJsFilters(accounts, q);

  const offset = q.offset ?? 0;
  const limit = q.limit ?? 500;
  return accounts.slice(offset, offset + limit);
}

/** 过滤 + 分页，返回总数 */
export function queryWithCount(q: AccountQuery): { data: Account[]; total: number } {
  const { whereClause, params } = buildFilters(q);
  const sql = `SELECT * FROM accounts ${whereClause}`;
  const rows = db.prepare(sql).all(...params) as AccountRow[];
  let accounts = rows.map(rowToAccount);
  accounts = applyJsFilters(accounts, q);

  const total = accounts.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 500;
  return { data: accounts.slice(offset, offset + limit), total };
}

/** 仅返回过滤后的 id 列表 */
export function queryIds(q: Omit<AccountQuery, 'limit' | 'offset'>): string[] {
  const { whereClause, params } = buildFilters(q);
  const sql = `SELECT * FROM accounts ${whereClause}`;
  const rows = db.prepare(sql).all(...params) as AccountRow[];
  let accounts = rows.map(rowToAccount);
  accounts = applyJsFilters(accounts, q);
  return accounts.map((a) => a.id);
}

/** 按过滤条件统计 */
export function getFilteredStats(q: Omit<AccountQuery, 'limit' | 'offset'>): AccountStats {
  const { whereClause, params } = buildFilters(q);
  const sql = `SELECT * FROM accounts ${whereClause}`;
  const rows = db.prepare(sql).all(...params) as AccountRow[];
  let accounts = rows.map(rowToAccount);
  accounts = applyJsFilters(accounts, q);
  return buildStats(accounts);
}

export function getStats(): AccountStats {
  return buildStats(loadAll(false));
}

function buildStats(accounts: Account[]): AccountStats {
  const nowStr = new Date().toISOString();
  const nowMs = Date.now();
  const soonThreshold = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const oneHourLater = nowMs + 60 * 60 * 1000;
  const today = nowStr.slice(0, 10);
  const byPlanType: Record<string, number> = {};
  const bySourceType: Record<string, number> = {};
  let expired = 0, expiringSoon = 0, disabled = 0, recentImported = 0;

  // quota 聚合
  const settings = settingsStore.load();
  const quotas: Record<string, { fiveHourUnits: number; sevenDayUnits: number; knivesPerUnit: number }> = settings.planQuotas ?? {};
  let qTotal = 0, qAvailable = 0, qOneHour = 0, qFiveHour = 0, qSevenDay = 0;

  for (const a of accounts) {
    byPlanType[a.planType || 'unknown'] = (byPlanType[a.planType || 'unknown'] ?? 0) + 1;
    bySourceType[a.sourceType || 'local'] = (bySourceType[a.sourceType || 'local'] ?? 0) + 1;
    if (a.expiredAt && a.expiredAt < nowStr) expired++;
    else if (a.expiredAt && a.expiredAt < soonThreshold) expiringSoon++;
    if (a.disabled) disabled++;
    if (a.importedAt && a.importedAt.startsWith(today)) recentImported++;

    // 有 probe 数据的账号计入 quota
    if (a.lastProbe?.usage) {
      qTotal++;
      const cfg = quotas[a.planType] ?? quotas['free'] ?? { fiveHourUnits: 50, sevenDayUnits: 500, knivesPerUnit: 1 };
      const k = cfg.knivesPerUnit || 1;
      const rem5h = Math.max(0, Math.round(cfg.fiveHourUnits * (100 - a.lastProbe.usage.fiveHourUsed) / 100));
      const rem7d = Math.max(0, Math.round(cfg.sevenDayUnits * (100 - a.lastProbe.usage.sevenDayUsed) / 100));
      const resetAt = a.lastProbe.usage.fiveHourResetAt ? new Date(a.lastProbe.usage.fiveHourResetAt).getTime() : 0;
      const willReset = resetAt > 0 && resetAt <= oneHourLater;
      qAvailable += Math.round(Math.min(rem5h, rem7d) * k);
      qOneHour += Math.round(Math.min(willReset ? cfg.fiveHourUnits : rem5h, rem7d) * k);
      qFiveHour += Math.round(Math.min(cfg.fiveHourUnits, rem7d) * k);
      qSevenDay += Math.round(rem7d * k);
    }
  }

  return {
    total: accounts.length, byPlanType, bySourceType, expired, expiringSoon, disabled, recentImported,
    quota: {
      totalAccounts: qTotal, availableNow: qAvailable, oneHour: qOneHour,
      fiveHour: qFiveHour, sevenDay: qSevenDay, oneWeek: qSevenDay,
      oneMonth: Math.round(qSevenDay * (30 / 7)),
    },
  };
}

export function updateProbeState(
  accountId: string,
  probe: Account['lastProbe'],
): Account | undefined {
  stmtUpdateProbe.run(probe ? JSON.stringify(probe) : null, accountId);
  return findById(accountId);
}

/**
 * 批量更新 probe 状态，只读写一次事务
 */
export function batchUpdateProbeStates(
  updates: Array<{ accountId: string; probe: Account['lastProbe'] }>,
): number {
  if (updates.length === 0) return 0;
  let count = 0;
  const doUpdate = db.transaction(() => {
    for (const { accountId, probe } of updates) {
      const result = stmtUpdateProbe.run(
        probe ? JSON.stringify(probe) : null,
        accountId,
      );
      if (result.changes > 0) count++;
    }
  });
  doUpdate();
  return count;
}

function inferSourceType(source: string | undefined): Account['sourceType'] {
  return String(source ?? '').startsWith('sync:') ? 'remote' : 'local';
}

// ── Token 更新 ────────────────────────────────────────────────

export interface TokenUpdate {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiredAt?: string;
  planType?: string;
  accountId?: string;
  organizationId?: string;
}

const stmtUpdateTokens = db.prepare<[string, string, string, string, string, string, string, string]>(
  `UPDATE accounts SET
     accessToken = CASE WHEN ? != '' THEN ? ELSE accessToken END,
     refreshToken = CASE WHEN ? != '' THEN ? ELSE refreshToken END,
     idToken = CASE WHEN ? != '' THEN ? ELSE idToken END,
     expiredAt = CASE WHEN ? != '' THEN ? ELSE expiredAt END,
     planType = CASE WHEN ? != '' THEN ? ELSE planType END,
     accountId = CASE WHEN ? != '' THEN ? ELSE accountId END,
     organizationId = CASE WHEN ? != '' THEN ? ELSE organizationId END
   WHERE id = ?`,
);

export function updateTokens(id: string, update: TokenUpdate): Account | undefined {
  const at = update.accessToken ?? '';
  const rt = update.refreshToken ?? '';
  const it = update.idToken ?? '';
  const exp = update.expiredAt ?? '';
  const plan = update.planType ?? '';
  const accId = update.accountId ?? '';
  const orgId = update.organizationId ?? '';
  stmtUpdateTokens.run(at, at, rt, rt, it, it, exp, exp, plan, plan, accId, accId, orgId, orgId, id);
  return findById(id);
}

export function batchUpdateTokens(updates: Array<{ id: string; tokens: TokenUpdate }>): number {
  if (updates.length === 0) return 0;
  let count = 0;
  const doUpdate = db.transaction(() => {
    for (const { id, tokens } of updates) {
      const at = tokens.accessToken ?? '';
      const rt = tokens.refreshToken ?? '';
      const it = tokens.idToken ?? '';
      const exp = tokens.expiredAt ?? '';
      const plan = tokens.planType ?? '';
      const accId = tokens.accountId ?? '';
      const orgId = tokens.organizationId ?? '';
      const result = stmtUpdateTokens.run(at, at, rt, rt, it, it, exp, exp, plan, plan, accId, accId, orgId, orgId, id);
      if (result.changes > 0) count++;
    }
  });
  doUpdate();
  return count;
}

/** 记录推送结果到账号的 pushHistory */
export function recordPushResult(
  email: string,
  entry: { channelId: string; channelName: string; taskId: string; status: 'success' | 'failed' },
): void {
  const row = stmtByEmail.get(email);
  if (!row) return;
  const history = JSON.parse(row.pushHistory) as Account['pushHistory'];
  history.push({ ...entry, at: new Date().toISOString() });
  stmtUpdatePushHistory.run(JSON.stringify(history), email);
}
