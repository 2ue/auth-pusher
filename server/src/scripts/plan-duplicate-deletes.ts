import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';

const DB_PATH = path.resolve(process.cwd(), '../data/auth-pusher.db');
const OUTPUT_ROOT = path.resolve(process.cwd(), '../data/duplicate-delete-plans');
const execFileAsync = promisify(execFile);

type ChannelRow = {
  id: string;
  name: string;
  pusherType: string;
  pusherConfig: string;
};

type ChannelConfig = {
  base_url: string;
  token: string;
  auth_mode?: string;
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

type PoolDef = {
  key: 'pool1' | 'pool2';
  channelName: '号池1' | '号池2';
};

type DeletePlanLine = {
  email: string;
  groupSize: number;
  uniqueTokenHashes: number;
  keepId: number;
  keepCurrentConcurrency: number;
  keepLastUsedAt: string;
  deleteId: number;
  deleteCurrentConcurrency: number;
  deleteLastUsedAt: string;
  action: 'delete_now' | 'defer_in_use' | 'review_token_mismatch';
  note: string;
};

const POOLS: PoolDef[] = [
  { key: 'pool1', channelName: '号池1' },
  { key: 'pool2', channelName: '号池2' },
];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sha256(value: string): string {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
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

async function sqliteJsonQuery<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', DB_PATH, sql], {
    maxBuffer: 1024 * 1024 * 16,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as T[];
}

function buildHeaders(cfg: ChannelConfig): Record<string, string> {
  const authMode = String(cfg.auth_mode ?? 'admin_api_key').trim().toLowerCase();
  if (authMode === 'admin_jwt' || authMode === 'jwt' || authMode === 'bearer') {
    return { Accept: 'application/json', Authorization: `Bearer ${cfg.token}` };
  }
  return { Accept: 'application/json', 'x-api-key': cfg.token };
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
      throw new Error(`fetch remote accounts failed: ${response.status}`);
    }
    const body = response.data as {
      code?: number;
      message?: string;
      data?: { items?: RemoteAccount[]; total?: number; page?: number; pages?: number };
    };
    if (body.code !== undefined && body.code !== 0 && body.code !== 200) {
      throw new Error(`fetch remote accounts failed: ${body.message ?? 'unknown error'}`);
    }

    const data = body.data ?? {};
    const items = data.items ?? [];
    results.push(
      ...items.filter((item) => {
        const creds = item.credentials ?? {};
        return item.platform === 'openai'
          && item.type === 'oauth'
          && stringOrEmpty(creds.access_token) !== ''
          && normalizeEmail(String(item.extra?.email ?? item.name ?? '')) !== '';
      }),
    );

    const totalPages = Number(data.pages ?? 0);
    const currentPage = Number(data.page ?? page);
    if (totalPages > 0 && currentPage >= totalPages) break;
    if (items.length === 0) break;
    page += 1;
  }

  return results;
}

function chooseKeepRecord(records: RemoteAccount[]): RemoteAccount {
  return [...records].sort((a, b) => {
    const aConcurrency = a.current_concurrency ?? 0;
    const bConcurrency = b.current_concurrency ?? 0;
    if (aConcurrency !== bConcurrency) return bConcurrency - aConcurrency;

    const aUsed = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bUsed = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    if (aUsed !== bUsed) return bUsed - aUsed;

    return a.id - b.id;
  })[0];
}

function planDuplicates(accounts: RemoteAccount[]): {
  lines: DeletePlanLine[];
  duplicateGroups: number;
  extraRecords: number;
  deleteNow: number;
  deferInUse: number;
  review: number;
} {
  const grouped = new Map<string, RemoteAccount[]>();
  for (const account of accounts) {
    const email = normalizeEmail(String(account.extra?.email ?? account.name ?? ''));
    const list = grouped.get(email) ?? [];
    list.push(account);
    grouped.set(email, list);
  }

  const lines: DeletePlanLine[] = [];
  let duplicateGroups = 0;
  let extraRecords = 0;

  for (const [email, records] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    if (records.length <= 1) continue;
    duplicateGroups += 1;
    extraRecords += records.length - 1;

    const keep = chooseKeepRecord(records);
    const uniqueTokenHashes = new Set(records.map((record) => sha256(stringOrEmpty(record.credentials?.access_token)))).size;

    for (const record of records) {
      if (record.id === keep.id) continue;
      let action: DeletePlanLine['action'] = 'delete_now';
      let note = 'same_email_duplicate';

      if (uniqueTokenHashes > 1) {
        action = 'review_token_mismatch';
        note = 'duplicate_email_but_token_hash_differs';
      } else if ((record.current_concurrency ?? 0) > 0) {
        action = 'defer_in_use';
        note = 'current_concurrency_gt_0';
      }

      lines.push({
        email,
        groupSize: records.length,
        uniqueTokenHashes,
        keepId: keep.id,
        keepCurrentConcurrency: keep.current_concurrency ?? 0,
        keepLastUsedAt: keep.last_used_at ?? '',
        deleteId: record.id,
        deleteCurrentConcurrency: record.current_concurrency ?? 0,
        deleteLastUsedAt: record.last_used_at ?? '',
        action,
        note,
      });
    }
  }

  return {
    lines,
    duplicateGroups,
    extraRecords,
    deleteNow: lines.filter((line) => line.action === 'delete_now').length,
    deferInUse: lines.filter((line) => line.action === 'defer_in_use').length,
    review: lines.filter((line) => line.action === 'review_token_mismatch').length,
  };
}

function formatPlanTxt(poolName: string, generatedAt: string, summary: ReturnType<typeof planDuplicates>): string {
  const header = [
    `# ${poolName} 重复账号删除计划`,
    `# generated_at=${generatedAt}`,
    `# duplicate_groups=${summary.duplicateGroups}`,
    `# extra_records=${summary.extraRecords}`,
    `# delete_now=${summary.deleteNow}`,
    `# defer_in_use=${summary.deferInUse}`,
    `# review=${summary.review}`,
    '# fields=email\tgroup_size\tunique_token_hashes\tkeep_id\tkeep_current_concurrency\tkeep_last_used_at\tdelete_id\tdelete_current_concurrency\tdelete_last_used_at\taction\tnote',
    '',
  ].join('\n');

  const body = summary.lines.map((line) => (
    `${line.email}\t${line.groupSize}\t${line.uniqueTokenHashes}\t${line.keepId}\t${line.keepCurrentConcurrency}\t${line.keepLastUsedAt}\t${line.deleteId}\t${line.deleteCurrentConcurrency}\t${line.deleteLastUsedAt}\t${line.action}\t${line.note}`
  )).join('\n');

  return `${header}${body}${body ? '\n' : ''}`;
}

function formatExecutionLogTxt(poolName: string, generatedAt: string): string {
  return [
    `# ${poolName} 重复账号删除执行日志`,
    `# generated_at=${generatedAt}`,
    '# 执行删除时逐条追加',
    '# fields=executed_at\temail\tkeep_id\tdelete_id\tdelete_current_concurrency\tresult\tnote',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const channelRows = await sqliteJsonQuery<ChannelRow>('SELECT id, name, pusherType, pusherConfig FROM channels');
  const channels = new Map(
    channelRows
      .filter((row) => row.pusherType === 'sub2api')
      .map((row) => [row.name, parseJsonObject(row.pusherConfig) as unknown as ChannelConfig]),
  );

  const summaries: Array<{
    poolKey: string;
    poolName: string;
    summary: ReturnType<typeof planDuplicates>;
  }> = [];

  for (const pool of POOLS) {
    const config = channels.get(pool.channelName);
    if (!config) throw new Error(`channel not found: ${pool.channelName}`);
    const accounts = await fetchRemoteAccounts(config);
    const summary = planDuplicates(accounts);
    summaries.push({ poolKey: pool.key, poolName: pool.channelName, summary });

    await fs.writeFile(
      path.join(outputDir, `${pool.key}.duplicate-delete.plan.txt`),
      formatPlanTxt(pool.channelName, timestamp, summary),
    );
    await fs.writeFile(
      path.join(outputDir, `${pool.key}.duplicate-delete.execution.log.txt`),
      formatExecutionLogTxt(pool.channelName, timestamp),
    );
  }

  const md = [
    '# 远端重复账号删除前分析',
    '',
    `生成目录：\`${outputDir}\``,
    '',
    '## 说明',
    '',
    '- 本次只做实时读取和删除前判断，没有执行任何删除。',
    '- 只分析各自号池内部的重复记录，不处理跨池重复。',
    '- 删除优先级规则：优先删除 `current_concurrency = 0` 的重复记录。',
    '- 如果重复组内 token 指纹不一致，则标记为人工复核，不进入自动删除。',
    '',
    '## 汇总',
    '',
    ...summaries.flatMap(({ poolName, summary }) => [
      `### ${poolName}`,
      '',
      `- 重复组数：${summary.duplicateGroups}`,
      `- 多余重复记录数：${summary.extraRecords}`,
      `- 现在可删：${summary.deleteNow}`,
      `- 正在被调用，暂缓：${summary.deferInUse}`,
      `- 需人工复核：${summary.review}`,
      '',
    ]),
    '## 文件',
    '',
    '- 每个池各生成 2 个独立 txt 文件：',
    '- `*.duplicate-delete.plan.txt`：删除计划',
    '- `*.duplicate-delete.execution.log.txt`：执行日志，后续真正删除时逐条追加',
    '',
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'summary.md'), `${md}\n`);

  console.log(JSON.stringify({
    outputDir,
    pools: summaries.map(({ poolKey, poolName, summary }) => ({
      poolKey,
      poolName,
      duplicateGroups: summary.duplicateGroups,
      extraRecords: summary.extraRecords,
      deleteNow: summary.deleteNow,
      deferInUse: summary.deferInUse,
      review: summary.review,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
