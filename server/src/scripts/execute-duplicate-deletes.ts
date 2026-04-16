import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';

const DB_PATH = path.resolve(process.cwd(), '../data/auth-pusher.db');
const OUTPUT_ROOT = path.resolve(process.cwd(), '../data/duplicate-delete-executions');
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

type PoolDef = {
  key: 'pool1' | 'pool2';
  channelName: '号池1' | '号池2';
  sourceFile: string;
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

const POOLS: PoolDef[] = [
  { key: 'pool1', channelName: '号池1', sourceFile: 'remote.pool1.internal-duplicate-records.to-delete.txt' },
  { key: 'pool2', channelName: '号池2', sourceFile: 'pool2.duplicate-records.to-delete.txt' },
];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

function latestAuditDir(root: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  throw new Error('audit directory path is required');
}

async function readDuplicateEmails(filePath: string): Promise<string[]> {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.split('\t')[0]?.trim())
    .filter(Boolean)
    .map((email) => normalizeEmail(email))
    .filter((email, index, arr) => arr.indexOf(email) === index);
}

async function searchAccountsByEmail(config: ChannelConfig, email: string): Promise<RemoteAccount[]> {
  const baseUrl = String(config.base_url).replace(/\/+$/, '');
  const response = await axios.get(`${baseUrl}/api/v1/admin/accounts`, {
    headers: buildHeaders(config),
    timeout: 30000,
    params: {
      page: 1,
      page_size: 100,
      platform: 'openai',
      type: 'oauth',
      search: email,
    },
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`search failed: ${response.status}`);
  }
  const body = response.data as { code?: number; message?: string; data?: { items?: RemoteAccount[] } };
  if (body.code !== undefined && body.code !== 0 && body.code !== 200) {
    throw new Error(`search failed: ${body.message ?? 'unknown error'}`);
  }
  const items = body.data?.items ?? [];
  return items.filter((item) => {
    const resolvedEmail = normalizeEmail(String(item.extra?.email ?? item.name ?? ''));
    return resolvedEmail === email
      && item.platform === 'openai'
      && item.type === 'oauth'
      && stringOrEmpty(item.credentials?.access_token) !== '';
  });
}

async function getAccountById(config: ChannelConfig, id: number): Promise<RemoteAccount | null> {
  const baseUrl = String(config.base_url).replace(/\/+$/, '');
  const response = await axios.get(`${baseUrl}/api/v1/admin/accounts/${id}`, {
    headers: buildHeaders(config),
    timeout: 30000,
    validateStatus: () => true,
  });
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`get by id failed: ${response.status}`);
  }
  const body = response.data as { code?: number; message?: string; data?: RemoteAccount };
  if (body.code !== undefined && body.code !== 0 && body.code !== 200) {
    throw new Error(`get by id failed: ${body.message ?? 'unknown error'}`);
  }
  return body.data ?? null;
}

async function deleteAccount(config: ChannelConfig, id: number): Promise<void> {
  const baseUrl = String(config.base_url).replace(/\/+$/, '');
  const response = await axios.delete(`${baseUrl}/api/v1/admin/accounts/${id}`, {
    headers: buildHeaders(config),
    timeout: 30000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`delete failed: ${response.status}`);
  }
  const body = response.data as { code?: number; message?: string };
  if (body.code !== undefined && body.code !== 0 && body.code !== 200) {
    throw new Error(`delete failed: ${body.message ?? 'unknown error'}`);
  }
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.appendFile(filePath, `${line}\n`);
}

async function main(): Promise<void> {
  const auditDirArg = process.argv[2];
  if (!auditDirArg) {
    throw new Error('usage: npx tsx src/scripts/execute-duplicate-deletes.ts <audit-dir>');
  }
  const auditDir = latestAuditDir('', auditDirArg);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const channelRows = await sqliteJsonQuery<ChannelRow>('SELECT id, name, pusherType, pusherConfig FROM channels');
  const channels = new Map(
    channelRows
      .filter((row) => row.pusherType === 'sub2api')
      .map((row) => [row.name, parseJsonObject(row.pusherConfig) as unknown as ChannelConfig]),
  );

  const summaryLines: string[] = [
    '# 重复账号逐组删除执行摘要',
    `# generated_at=${timestamp}`,
    `# audit_dir=${auditDir}`,
    '',
  ];

  for (const pool of POOLS) {
    const config = channels.get(pool.channelName);
    if (!config) throw new Error(`channel not found: ${pool.channelName}`);

    const sourceFile = path.join(auditDir, pool.sourceFile);
    const emails = await readDuplicateEmails(sourceFile);
    const deletedLog = path.join(outputDir, `${pool.key}.deleted.log.txt`);
    const skippedLog = path.join(outputDir, `${pool.key}.skipped.log.txt`);

    await fs.writeFile(
      deletedLog,
      `# ${pool.channelName} 删除日志\n# fields=executed_at\temail\tkeep_id\tdelete_id\tdelete_current_concurrency\tresult\tnote\n\n`,
    );
    await fs.writeFile(
      skippedLog,
      `# ${pool.channelName} 跳过日志\n# fields=executed_at\temail\trecord_ids\tresult\tnote\n\n`,
    );

    let deletedCount = 0;
    let skippedCount = 0;

    for (const email of emails) {
      const now = new Date().toISOString();
      const live = await searchAccountsByEmail(config, email);

      if (live.length !== 2) {
        skippedCount += 1;
        await appendLine(
          skippedLog,
          `${now}\t${email}\t${live.map((item) => item.id).join(',')}\tskip\tnot_exactly_two_live_duplicates`,
        );
        continue;
      }

      const keep = chooseKeepRecord(live);
      const candidate = live.find((item) => item.id !== keep.id);
      if (!candidate) {
        skippedCount += 1;
        await appendLine(
          skippedLog,
          `${now}\t${email}\t${live.map((item) => item.id).join(',')}\tskip\tno_delete_candidate`,
        );
        continue;
      }

      const keepBusy = (keep.current_concurrency ?? 0) > 0;
      const candidateBusy = (candidate.current_concurrency ?? 0) > 0;

      if (keepBusy && candidateBusy) {
        skippedCount += 1;
        await appendLine(
          skippedLog,
          `${now}\t${email}\t${keep.id},${candidate.id}\tskip\tboth_in_use`,
        );
        continue;
      }

      const recheck = await getAccountById(config, candidate.id);
      if (!recheck) {
        skippedCount += 1;
        await appendLine(
          skippedLog,
          `${now}\t${email}\t${keep.id},${candidate.id}\tskip\tdelete_candidate_missing_before_delete`,
        );
        continue;
      }

      if ((recheck.current_concurrency ?? 0) > 0) {
        skippedCount += 1;
        await appendLine(
          skippedLog,
          `${now}\t${email}\t${keep.id},${candidate.id}\tskip\tdelete_candidate_became_in_use`,
        );
        continue;
      }

      await deleteAccount(config, candidate.id);
      deletedCount += 1;
      await appendLine(
        deletedLog,
        `${now}\t${email}\t${keep.id}\t${candidate.id}\t${recheck.current_concurrency ?? 0}\tdeleted\tduplicate_same_email`,
      );
    }

    summaryLines.push(`## ${pool.channelName}`);
    summaryLines.push('');
    summaryLines.push(`- source_file=${sourceFile}`);
    summaryLines.push(`- deleted_log=${deletedLog}`);
    summaryLines.push(`- skipped_log=${skippedLog}`);
    summaryLines.push(`- deleted=${deletedCount}`);
    summaryLines.push(`- skipped=${skippedCount}`);
    summaryLines.push('');
  }

  const summaryPath = path.join(outputDir, 'summary.md');
  await fs.writeFile(summaryPath, `${summaryLines.join('\n')}\n`);

  console.log(JSON.stringify({ outputDir, summaryPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
