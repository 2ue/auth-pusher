import type { DataProfile } from '../../../shared/types/data-profile.js';
import db from './db.js';

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  multiFile: number;
  recordsPath: string;
  fieldMapping: string;
  fingerprint: string;
  builtin: number;
  createdAt: string;
  updatedAt: string;
}

const BUILTIN_PROFILES: DataProfile[] = [
  {
    id: 'dp-auth-raw',
    name: '原始 Token 文件',
    description: 'auth-data 目录下的单账号 JSON 文件（每个文件一条记录）',
    multiFile: true,
    recordsPath: '',
    fieldMapping: {
      email: 'email',
      access_token: 'access_token',
      refresh_token: 'refresh_token',
      id_token: 'id_token',
      account_id: 'account_id',
    },
    fingerprint: ['email', 'access_token', 'refresh_token', 'id_token', 'meta'],
    builtin: true,
    createdAt: '2026-04-05T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z',
  },
  {
    id: 'dp-sub2api-export',
    name: 'SUB2API 导出',
    description: 'SUB2API 平台导出的 accounts JSON 文件',
    multiFile: false,
    recordsPath: 'accounts',
    fieldMapping: {
      email: 'extra.email',
      access_token: 'credentials.access_token',
      refresh_token: 'credentials.refresh_token',
      id_token: 'credentials.id_token',
      plan_type: 'credentials.plan_type',
      account_id: 'credentials.chatgpt_account_id',
      organization_id: 'credentials.organization_id',
    },
    fingerprint: ['credentials.access_token', 'credentials.plan_type', 'extra.email', 'concurrency'],
    builtin: true,
    createdAt: '2026-04-05T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z',
  },
];

function rowToProfile(row: ProfileRow): DataProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    multiFile: row.multiFile === 1,
    recordsPath: row.recordsPath,
    fieldMapping: JSON.parse(row.fieldMapping),
    fingerprint: JSON.parse(row.fingerprint),
    builtin: row.builtin === 1 ? true : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const stmtAll = db.prepare<[], ProfileRow>('SELECT * FROM profiles');
const stmtById = db.prepare<[string], ProfileRow>('SELECT * FROM profiles WHERE id = ?');
const stmtUpsert = db.prepare<[string, string, string, number, string, string, string, number, string, string]>(
  `INSERT INTO profiles (id, name, description, multiFile, recordsPath, fieldMapping, fingerprint, builtin, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     description = excluded.description,
     multiFile = excluded.multiFile,
     recordsPath = excluded.recordsPath,
     fieldMapping = excluded.fieldMapping,
     fingerprint = excluded.fingerprint,
     builtin = excluded.builtin,
     createdAt = excluded.createdAt,
     updatedAt = excluded.updatedAt`,
);
const stmtDelete = db.prepare<[string]>('DELETE FROM profiles WHERE id = ?');

function ensureBuiltins(): void {
  const insertBuiltins = db.transaction(() => {
    for (const p of BUILTIN_PROFILES) {
      const existing = stmtById.get(p.id);
      if (!existing) {
        stmtUpsert.run(
          p.id, p.name, p.description, p.multiFile ? 1 : 0,
          p.recordsPath, JSON.stringify(p.fieldMapping), JSON.stringify(p.fingerprint),
          p.builtin ? 1 : 0, p.createdAt, p.updatedAt,
        );
      }
    }
  });
  insertBuiltins();
}

// Run once at module load
ensureBuiltins();

export function loadProfiles(): DataProfile[] {
  return stmtAll.all().map(rowToProfile);
}

export function findProfile(id: string): DataProfile | undefined {
  const row = stmtById.get(id);
  return row ? rowToProfile(row) : undefined;
}

export function upsertProfile(profile: DataProfile): void {
  stmtUpsert.run(
    profile.id, profile.name, profile.description, profile.multiFile ? 1 : 0,
    profile.recordsPath, JSON.stringify(profile.fieldMapping), JSON.stringify(profile.fingerprint),
    profile.builtin ? 1 : 0, profile.createdAt, profile.updatedAt,
  );
}

export function removeProfile(id: string): boolean {
  const row = stmtById.get(id);
  if (!row) return false;
  if (row.builtin === 1) return false; // 不允许删除内置模板
  const result = stmtDelete.run(id);
  return result.changes > 0;
}

/**
 * 根据检测到的字段自动匹配最佳 DataProfile
 * 返回匹配度最高且 >= 60% 的 Profile
 */
export function matchProfile(detectedFields: string[]): DataProfile | null {
  const profiles = loadProfiles();
  const fieldSet = new Set(detectedFields);

  let bestProfile: DataProfile | null = null;
  let bestScore = 0;

  for (const profile of profiles) {
    if (profile.fingerprint.length === 0) continue;
    const matched = profile.fingerprint.filter((f) => fieldSet.has(f)).length;
    const score = matched / profile.fingerprint.length;
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }

  // 至少 60% 指纹匹配才算有效
  return bestScore >= 0.6 ? bestProfile : null;
}
