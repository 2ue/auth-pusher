import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DB_PATH = path.resolve(process.cwd(), '../data/auth-pusher.db');
const OUTPUT_ROOT = path.resolve(process.cwd(), '../data/pool-audits');
const execFileAsync = promisify(execFile);

type ChannelRow = {
  id: string;
  name: string;
  pusherType: string;
  pusherConfig: string;
};

type AccountRow = {
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
};

type ChannelConfig = {
  base_url: string;
  token: string;
  auth_mode?: string;
};

type PoolDef = {
  key: 'pool1' | 'pool2';
  channelName: '号池1' | '号池2';
};

type LocalAccount = {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  organizationId: string;
  planType: string;
  tags: string[];
  disabled: boolean;
  expiredAt: string;
  sourceType: string;
  source: string;
  importedAt: string;
  lastProbe: unknown | null;
};

type RemoteAccount = {
  id: number;
  name: string;
  platform: string;
  type: string;
  credentials: Record<string, unknown>;
  extra: Record<string, unknown>;
  status: string;
  error_message: string;
  schedulable: boolean;
  last_used_at: string | null;
  current_concurrency: number;
};

type RecoveryAccount = {
  name: string;
  platform: 'openai';
  type: 'oauth';
  credentials: Record<string, unknown>;
};

type SnapshotAccount = {
  id?: number | string;
  email: string;
  name: string;
  platform: string;
  type: string;
  status: string;
  schedulable?: boolean;
  disabled?: boolean;
  last_used_at?: string | null;
  current_concurrency?: number;
  account_id?: string;
  organization_id?: string;
  plan_type?: string;
  access_token_sha256: string;
  refresh_token_present: boolean;
  id_token_present: boolean;
};

type CleanupCandidate = SnapshotAccount & {
  reason: string;
  in_local_pool2: boolean;
  duplicate_group?: string[];
};

const POOLS: PoolDef[] = [
  { key: 'pool1', channelName: '号池1' },
  { key: 'pool2', channelName: '号池2' },
];

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildHeaders(cfg: ChannelConfig): Record<string, string> {
  const authMode = String(cfg.auth_mode ?? 'admin_api_key').trim().toLowerCase();
  if (authMode === 'admin_jwt' || authMode === 'jwt' || authMode === 'bearer') {
    return { Accept: 'application/json', Authorization: `Bearer ${cfg.token}` };
  }
  return { Accept: 'application/json', 'x-api-key': cfg.token };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildRecoveryCredentials(input: {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
  email?: string;
  accountId?: string;
  userId?: string;
  organizationId?: string;
  planType?: string;
  clientId?: string;
}): Record<string, unknown> {
  const credentials: Record<string, unknown> = {};
  if (input.accessToken) credentials.access_token = input.accessToken;
  if (input.refreshToken) credentials.refresh_token = input.refreshToken;
  if (input.idToken) credentials.id_token = input.idToken;
  if (input.expiresAt) credentials.expires_at = input.expiresAt;
  if (input.email) credentials.email = input.email;
  if (input.accountId) credentials.chatgpt_account_id = input.accountId;
  if (input.userId) credentials.chatgpt_user_id = input.userId;
  if (input.organizationId) credentials.organization_id = input.organizationId;
  if (input.planType) credentials.plan_type = input.planType;
  credentials.client_id = input.clientId || OPENAI_OAUTH_CLIENT_ID;
  return credentials;
}

function localToRecovery(account: LocalAccount): RecoveryAccount {
  return {
    name: account.email,
    platform: 'openai',
    type: 'oauth',
    credentials: buildRecoveryCredentials({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
      email: account.email,
      accountId: account.accountId,
      organizationId: account.organizationId,
      planType: account.planType,
    }),
  };
}

function localToSnapshot(account: LocalAccount): SnapshotAccount {
  return {
    id: account.id,
    email: account.email,
    name: account.email,
    platform: 'openai',
    type: 'oauth',
    status: account.disabled ? 'inactive' : 'active',
    disabled: account.disabled,
    account_id: account.accountId || undefined,
    organization_id: account.organizationId || undefined,
    plan_type: account.planType || undefined,
    access_token_sha256: sha256(account.accessToken),
    refresh_token_present: Boolean(account.refreshToken),
    id_token_present: Boolean(account.idToken),
  };
}

function remoteToRecovery(account: RemoteAccount): RecoveryAccount {
  const credentials = account.credentials ?? {};
  return {
    name: String(account.extra?.email ?? account.name ?? ''),
    platform: 'openai',
    type: 'oauth',
    credentials: buildRecoveryCredentials({
      accessToken: stringOrEmpty(credentials.access_token),
      refreshToken: stringOrEmpty(credentials.refresh_token),
      idToken: stringOrEmpty(credentials.id_token),
      expiresAt: stringOrEmpty(credentials.expires_at),
      email: stringOrEmpty(credentials.email) || String(account.extra?.email ?? account.name ?? ''),
      accountId: stringOrEmpty(credentials.chatgpt_account_id),
      userId: stringOrEmpty(credentials.chatgpt_user_id),
      organizationId: stringOrEmpty(credentials.organization_id),
      planType: stringOrEmpty(credentials.plan_type),
      clientId: stringOrEmpty(credentials.client_id) || OPENAI_OAUTH_CLIENT_ID,
    }),
  };
}

function remoteToSnapshot(account: RemoteAccount): SnapshotAccount {
  const credentials = account.credentials ?? {};
  const email = String(account.extra?.email ?? account.name ?? '');
  return {
    id: account.id,
    email,
    name: account.name,
    platform: account.platform,
    type: account.type,
    status: account.status,
    schedulable: account.schedulable,
    last_used_at: account.last_used_at,
    current_concurrency: account.current_concurrency,
    account_id: stringOrEmpty(credentials.chatgpt_account_id) || undefined,
    organization_id: stringOrEmpty(credentials.organization_id) || undefined,
    plan_type: stringOrEmpty(credentials.plan_type) || undefined,
    access_token_sha256: sha256(stringOrEmpty(credentials.access_token)),
    refresh_token_present: Boolean(stringOrEmpty(credentials.refresh_token)),
    id_token_present: Boolean(stringOrEmpty(credentials.id_token)),
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function fetchRemoteAccounts(config: ChannelConfig): Promise<RemoteAccount[]> {
  const baseUrl = String(config.base_url).replace(/\/+$/, '');
  const headers = buildHeaders(config);
  const results: RemoteAccount[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const url = `${baseUrl}/api/v1/admin/accounts?page=${page}&page_size=${pageSize}&platform=openai&type=oauth`;
    const response = await axios.get(url, {
      headers,
      timeout: 30000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`fetch remote accounts failed: ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`);
    }
    const body = response.data as {
      code?: number;
      message?: string;
      data?: { items?: RemoteAccount[]; total?: number; page?: number; page_size?: number; pages?: number } | RemoteAccount[];
    };
    if (body.code !== undefined && body.code !== 0 && body.code !== 200) {
      throw new Error(`fetch remote accounts failed: ${body.message ?? 'unknown error'}`);
    }

    const data = body.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    const filtered = items.filter((item) => {
      const creds = item.credentials ?? {};
      return item.platform === 'openai'
        && item.type === 'oauth'
        && stringOrEmpty(creds.access_token) !== '';
        });
    results.push(...filtered);

    if (Array.isArray(data)) {
      if (items.length < pageSize) break;
    } else {
      const currentPage = Number(data?.page ?? page);
      const totalPages = Number(data?.pages ?? 0);
      const total = Number(data?.total ?? 0);
      if (totalPages > 0) {
        if (currentPage >= totalPages) break;
      } else if (items.length === 0 || results.length >= total) {
        break;
      }
    }
    page += 1;
  }

  return results;
}

async function sqliteJsonQuery<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', DB_PATH, sql], {
    maxBuffer: 1024 * 1024 * 64,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as T[];
}

function groupByEmail(accounts: SnapshotAccount[]): Map<string, SnapshotAccount[]> {
  const map = new Map<string, SnapshotAccount[]>();
  for (const account of accounts) {
    const key = normalizeEmail(account.email);
    const arr = map.get(key) ?? [];
    arr.push(account);
    map.set(key, arr);
  }
  return map;
}

function sortByEmail<T extends { email?: string; name?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const left = a.email || a.name || '';
    const right = b.email || b.name || '';
    return left.localeCompare(right, 'en');
  });
}

function uniqueEmails(items: { email: string }[]): string[] {
  return [...new Set(items.map((item) => normalizeEmail(item.email)))].sort();
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const channelRows = await sqliteJsonQuery<ChannelRow>('SELECT id, name, pusherType, pusherConfig FROM channels');
  const accountRows = await sqliteJsonQuery<AccountRow>('SELECT * FROM accounts');

  const channelsByName = new Map(
    channelRows
      .filter((row) => row.pusherType === 'sub2api')
      .map((row) => [row.name, { ...row, parsedConfig: parseJsonObject(row.pusherConfig) as unknown as ChannelConfig }]),
  );

  const localAccounts: LocalAccount[] = accountRows.map((row) => ({
    id: row.id,
    email: row.email,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    idToken: row.idToken,
    accountId: row.accountId,
    organizationId: row.organizationId,
    planType: row.planType,
    tags: ensureArray(row.tags),
    disabled: row.disabled === 1,
    expiredAt: row.expiredAt,
    sourceType: row.sourceType,
    source: row.source,
    importedAt: row.importedAt,
    lastProbe: row.lastProbe ? parseJsonObject(row.lastProbe) : null,
  }));

  const poolOutputs: Record<string, unknown> = {};

  for (const pool of POOLS) {
    const channel = channelsByName.get(pool.channelName);
    if (!channel) throw new Error(`channel not found: ${pool.channelName}`);

    const syncTag = `sync:${pool.channelName}`;
    const deletedTag = `deleted:${pool.channelName}`;

    const localPoolAccounts = localAccounts.filter((account) =>
      account.tags.includes(syncTag)
      && !account.tags.includes(deletedTag)
      && account.accessToken.trim() !== '',
    );

    const localRecovery = sortByEmail(localPoolAccounts).map(localToRecovery);
    const localSnapshot = sortByEmail(localPoolAccounts).map(localToSnapshot);

    const remoteAccounts = await fetchRemoteAccounts(channel.parsedConfig);
    const remoteRecovery = sortByEmail(
      remoteAccounts
        .map(remoteToRecovery)
        .filter((item) => String(item.name || '').trim() !== ''),
    );
    const remoteSnapshot = sortByEmail(remoteAccounts.map(remoteToSnapshot));

    await fs.writeFile(
      path.join(outputDir, `${pool.key}.local.recovery.json`),
      `${JSON.stringify(localRecovery, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(outputDir, `${pool.key}.local.snapshot.json`),
      `${JSON.stringify(localSnapshot, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(outputDir, `${pool.key}.remote.recovery.json`),
      `${JSON.stringify(remoteRecovery, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(outputDir, `${pool.key}.remote.snapshot.json`),
      `${JSON.stringify(remoteSnapshot, null, 2)}\n`,
    );

    poolOutputs[pool.key] = {
      channel: {
        id: channel.id,
        name: channel.name,
        pusherType: channel.pusherType,
        base_url: channel.parsedConfig.base_url,
      },
      local_count: localSnapshot.length,
      remote_count: remoteSnapshot.length,
      local_unique_emails: uniqueEmails(localSnapshot).length,
      remote_unique_emails: uniqueEmails(remoteSnapshot).length,
    };

    if (pool.key === 'pool1') {
      const localPool1EmailSet = new Set(localSnapshot.map((item) => normalizeEmail(item.email)));
      const localPool1TokenSet = new Set(localSnapshot.map((item) => `${normalizeEmail(item.email)}:${item.access_token_sha256}`));

      const pool2LocalSnapshot = sortByEmail(
        localAccounts
          .filter((account) =>
            account.tags.includes('sync:号池2')
            && !account.tags.includes('deleted:号池2')
            && account.accessToken.trim() !== '',
          )
          .map(localToSnapshot),
      );
      const localPool2EmailSet = new Set(pool2LocalSnapshot.map((item) => normalizeEmail(item.email)));

      const remoteGroups = groupByEmail(remoteSnapshot);
      const deleteSafe: CleanupCandidate[] = [];
      const deleteDeferInUse: CleanupCandidate[] = [];
      const reviewManual: CleanupCandidate[] = [];
      const keep: CleanupCandidate[] = [];

      for (const account of remoteSnapshot) {
        const emailKey = normalizeEmail(account.email);
        const tokenKey = `${emailKey}:${account.access_token_sha256}`;
        const duplicates = (remoteGroups.get(emailKey) ?? []).map((item) => String(item.id));
        const inLocalPool1 = localPool1EmailSet.has(emailKey);
        const exactMatch = localPool1TokenSet.has(tokenKey);
        const inLocalPool2 = localPool2EmailSet.has(emailKey);
        const candidateBase: CleanupCandidate = {
          ...account,
          reason: '',
          in_local_pool2: inLocalPool2,
          duplicate_group: duplicates.length > 1 ? duplicates : undefined,
        };

        if (exactMatch || (inLocalPool1 && duplicates.length <= 1)) {
          candidateBase.reason = exactMatch ? 'exact_match_local_pool1' : 'email_exists_local_pool1';
          keep.push(candidateBase);
          continue;
        }

        if (inLocalPool1 && !exactMatch) {
          candidateBase.reason = 'local_pool1_same_email_but_token_mismatch';
          reviewManual.push(candidateBase);
          continue;
        }

        if (inLocalPool2) {
          candidateBase.reason = 'belongs_to_local_pool2';
        } else if (duplicates.length > 1) {
          candidateBase.reason = 'remote_pool1_duplicate_email';
        } else {
          candidateBase.reason = 'missing_from_local_pool1_baseline';
        }

        if ((account.current_concurrency ?? 0) > 0) {
          deleteDeferInUse.push(candidateBase);
        } else {
          deleteSafe.push(candidateBase);
        }
      }

      const report = {
        generated_at: new Date().toISOString(),
        summary: {
          remote_total: remoteSnapshot.length,
          keep: keep.length,
          delete_safe: deleteSafe.length,
          delete_defer_in_use: deleteDeferInUse.length,
          review_manual: reviewManual.length,
        },
        keep,
        delete_safe: deleteSafe,
        delete_defer_in_use: deleteDeferInUse,
        review_manual: reviewManual,
      };

      await fs.writeFile(
        path.join(outputDir, 'pool1.cleanup.report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    db_path: DB_PATH,
    output_dir: outputDir,
    pools: poolOutputs,
    notes: [
      'Only auth+openai accounts are included.',
      'No remote write endpoints were called.',
      'Remote recovery backups are minimal recovery payloads, not full runtime-state backups.',
    ],
  };

  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
