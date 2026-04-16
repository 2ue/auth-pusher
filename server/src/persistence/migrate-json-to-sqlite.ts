/**
 * One-time migration script: JSON files -> SQLite
 *
 * Migrates config data (settings, channels, profiles, tags, scheduled-tasks)
 * from JSON files to the SQLite database.
 * Transient data (accounts, tasks, etc.) is not migrated -- start fresh.
 *
 * Usage: npx tsx src/persistence/migrate-json-to-sqlite.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(currentDir, '../../../data');

function readJson<T>(file: string, fallback: T): T {
  const filePath = path.join(DATA_DIR, file);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function migrate() {
  console.log('Starting JSON -> SQLite migration...');
  console.log(`Data directory: ${DATA_DIR}`);

  // ── Settings ────────────────────────────────────────────────
  const settingsRaw = readJson<Record<string, unknown>>('settings.json', {});
  if (Object.keys(settingsRaw).length > 0) {
    const stmtUpsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const insertSettings = db.transaction(() => {
      for (const [key, value] of Object.entries(settingsRaw)) {
        stmtUpsert.run(key, JSON.stringify(value));
      }
    });
    insertSettings();
    console.log(`  Settings: migrated ${Object.keys(settingsRaw).length} keys`);
  } else {
    console.log('  Settings: no data to migrate');
  }

  // ── Channels ────────────────────────────────────────────────
  interface ChannelJson {
    id: string; name: string; pusherType: string; enabled: boolean;
    pusherConfig: Record<string, unknown>; fieldMapping: Record<string, string>;
    pushIntervalMs?: number; pushConcurrency?: number;
    createdAt: string; updatedAt: string;
  }
  const channels = readJson<ChannelJson[]>('channels.json', []);
  if (channels.length > 0) {
    const stmtUpsert = db.prepare(
      `INSERT INTO channels (id, name, pusherType, enabled, pusherConfig, fieldMapping, pushIntervalMs, pushConcurrency, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, pusherType = excluded.pusherType, enabled = excluded.enabled,
         pusherConfig = excluded.pusherConfig, fieldMapping = excluded.fieldMapping,
         pushIntervalMs = excluded.pushIntervalMs, pushConcurrency = excluded.pushConcurrency,
         createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
    );
    const insertChannels = db.transaction(() => {
      for (const c of channels) {
        const pt = String(c.pusherType) === 'cpa_upload' ? 'cliproxycli' : c.pusherType;
        stmtUpsert.run(
          c.id, c.name, pt, c.enabled ? 1 : 0,
          JSON.stringify(c.pusherConfig), JSON.stringify(c.fieldMapping),
          c.pushIntervalMs ?? null, c.pushConcurrency ?? null,
          c.createdAt, c.updatedAt,
        );
      }
    });
    insertChannels();
    console.log(`  Channels: migrated ${channels.length} records`);
  } else {
    console.log('  Channels: no data to migrate');
  }

  // ── Profiles ────────────────────────────────────────────────
  interface ProfileJson {
    id: string; name: string; description: string; multiFile: boolean;
    recordsPath: string; fieldMapping: Record<string, string>;
    fingerprint: string[]; builtin?: boolean; createdAt: string; updatedAt: string;
  }
  const profiles = readJson<ProfileJson[]>('profiles.json', []);
  if (profiles.length > 0) {
    const stmtUpsert = db.prepare(
      `INSERT INTO profiles (id, name, description, multiFile, recordsPath, fieldMapping, fingerprint, builtin, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description, multiFile = excluded.multiFile,
         recordsPath = excluded.recordsPath, fieldMapping = excluded.fieldMapping,
         fingerprint = excluded.fingerprint, builtin = excluded.builtin,
         createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
    );
    const insertProfiles = db.transaction(() => {
      for (const p of profiles) {
        stmtUpsert.run(
          p.id, p.name, p.description, p.multiFile ? 1 : 0,
          p.recordsPath, JSON.stringify(p.fieldMapping), JSON.stringify(p.fingerprint),
          p.builtin ? 1 : 0, p.createdAt, p.updatedAt,
        );
      }
    });
    insertProfiles();
    console.log(`  Profiles: migrated ${profiles.length} records`);
  } else {
    console.log('  Profiles: no data to migrate');
  }

  // ── Tags ────────────────────────────────────────────────────
  interface TagJson { predefined: string[]; autoCollected: string[] }
  const tags = readJson<TagJson>('tags.json', { predefined: [], autoCollected: [] });
  const totalTags = tags.predefined.length + tags.autoCollected.length;
  if (totalTags > 0) {
    const stmtInsert = db.prepare('INSERT OR IGNORE INTO tags (tag, type) VALUES (?, ?)');
    const insertTags = db.transaction(() => {
      for (const t of tags.predefined) stmtInsert.run(t, 'predefined');
      for (const t of tags.autoCollected) stmtInsert.run(t, 'auto');
    });
    insertTags();
    console.log(`  Tags: migrated ${totalTags} records (${tags.predefined.length} predefined, ${tags.autoCollected.length} auto)`);
  } else {
    console.log('  Tags: no data to migrate');
  }

  // ── Scheduled Tasks ─────────────────────────────────────────
  interface ScheduledTaskJson {
    id: string; channelId: string; cronExpression: string; enabled: boolean;
    lastRunAt?: string; lastRunStatus?: string; lastRunError?: string;
    lastTaskId?: string; createdAt: string;
  }
  const scheduledTasks = readJson<ScheduledTaskJson[]>('scheduled-tasks.json', []);
  if (scheduledTasks.length > 0) {
    const stmtUpsert = db.prepare(
      `INSERT INTO scheduled_tasks (id, channelId, cronExpression, enabled, lastRunAt, lastRunStatus, lastRunError, lastTaskId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         channelId = excluded.channelId, cronExpression = excluded.cronExpression,
         enabled = excluded.enabled, lastRunAt = excluded.lastRunAt,
         lastRunStatus = excluded.lastRunStatus, lastRunError = excluded.lastRunError,
         lastTaskId = excluded.lastTaskId, createdAt = excluded.createdAt`,
    );
    const insertScheduled = db.transaction(() => {
      for (const s of scheduledTasks) {
        stmtUpsert.run(
          s.id, s.channelId, s.cronExpression, s.enabled ? 1 : 0,
          s.lastRunAt ?? null, s.lastRunStatus ?? null,
          s.lastRunError ?? null, s.lastTaskId ?? null, s.createdAt,
        );
      }
    });
    insertScheduled();
    console.log(`  Scheduled Tasks: migrated ${scheduledTasks.length} records`);
  } else {
    console.log('  Scheduled Tasks: no data to migrate');
  }

  console.log('\nMigration complete!');
  console.log('You can now safely rename/archive the old JSON files if desired.');
}

migrate();
