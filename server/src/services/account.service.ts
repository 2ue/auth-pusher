import { nanoid } from 'nanoid';
import type { Account, AccountQuery, AccountStats } from '../../../shared/types/account.js';
import type { RawRecord, FieldMapping } from '../../../shared/types/data.js';
import * as store from '../persistence/account.store.js';
import * as tagStore from '../persistence/tag.store.js';
import { decodeOpenAiJwt, decodeIdTokenOrg, resolvePlanTypeFromTokens } from '../utils/jwt.js';
import { parseFileContent, detectFileType, extractFieldNames } from '../adapters/data-parser.js';
import { applyFieldMapping } from '../adapters/field-mapper.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../persistence/json-store.js';

/** 从上传的文件导入账号到池子 */
export function importFromFile(
  fileId: string,
  fieldMapping: FieldMapping,
  source: string,
): { added: number; updated: number; skipped: number } {
  const filePath = path.join(getDataDir(), 'uploads', fileId);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${fileId}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const fileType = detectFileType(fileId);
  const { records } = parseFileContent(content, fileType);

  // email 是导入必填字段
  const requiredFields = ['email'];
  const mapped = applyFieldMapping(records, fieldMapping, requiredFields);
  const valid = mapped.filter((m) => m.valid);

  const accounts = valid.map((item) => buildAccount(item.fields, source));
  const result = store.upsertBatch(accounts);

  return { added: result.added, updated: result.updated, skipped: mapped.length - valid.length };
}

export interface ImportOptions {
  planTypeOverride?: string;
  tags?: string[];
}

/** 从解析好的记录导入 */
export function importFromRecords(
  records: RawRecord[],
  fieldMapping: FieldMapping,
  source: string,
  options?: ImportOptions,
): { added: number; updated: number; skipped: number } {
  const mapped = applyFieldMapping(records, fieldMapping, ['email']);
  const valid = mapped.filter((m) => m.valid);
  const tags = options?.tags ?? [];
  const accounts = valid.map((item) => {
    const account = buildAccount(item.fields, source);
    if (options?.planTypeOverride) account.planType = options.planTypeOverride;
    if (tags.length > 0) account.tags = [...new Set([...account.tags, ...tags])];
    return account;
  });
  const result = store.upsertBatch(accounts);
  // 自动收集标签
  if (tags.length > 0) tagStore.addAutoCollected(tags);
  return { added: result.added, updated: result.updated, skipped: mapped.length - valid.length };
}

function buildAccount(fields: Record<string, unknown>, source: string): Account {
  const accessToken = String(fields.access_token ?? '');
  const idToken = String(fields.id_token ?? '');

  // 从 JWT 解码补充信息
  const atClaims = decodeOpenAiJwt(accessToken);
  const orgId = decodeIdTokenOrg(idToken) || atClaims.organizationId;

  const email = String(fields.email ?? atClaims.email ?? '');
  let planType = String(fields.plan_type ?? '');
  if (!planType) planType = resolvePlanTypeFromTokens(accessToken, idToken);
  const accountId = String(fields.account_id ?? atClaims.accountId ?? '');
  const expiredAt = atClaims.exp > 0 ? new Date(atClaims.exp * 1000).toISOString() : String(fields.expired ?? '');
  const disabled = fields.disabled === true || fields.disabled === 'true';

  return {
    id: nanoid(12),
    email,
    accessToken,
    refreshToken: String(fields.refresh_token ?? ''),
    idToken,
    accountId,
    organizationId: orgId || String(fields.organization_id ?? ''),
    planType,
    tags: [],
    disabled,
    expiredAt,
    sourceType: 'local',
    source,
    importedAt: new Date().toISOString(),
    pushHistory: [],
    lastProbe: null,
  };
}

export function queryAccounts(q: AccountQuery): Account[] {
  return store.query(q);
}

export function queryAccountsWithCount(q: AccountQuery): { data: Account[]; total: number } {
  return store.queryWithCount(q);
}

export function queryIds(q: Omit<AccountQuery, 'limit' | 'offset'>): string[] {
  return store.queryIds(q);
}

export function getStats(): AccountStats {
  return store.getStats();
}

export function getFilteredStats(q: Omit<AccountQuery, 'limit' | 'offset'>): AccountStats {
  return store.getFilteredStats(q);
}

export function removeAccount(id: string): boolean {
  return store.remove(id);
}

export function removeAccounts(ids: string[]): number {
  return store.removeBatch(ids);
}

export function getAllAccounts(): Account[] {
  return store.loadAll();
}
