import type { ChannelConfig } from '../../../shared/types/channel.js';
import db from './db.js';

interface ChannelRow {
  id: string;
  name: string;
  pusherType: string;
  enabled: number;
  pusherConfig: string;
  fieldMapping: string;
  pushIntervalMs: number | null;
  pushConcurrency: number | null;
  defaultAccountFilter: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToChannel(row: ChannelRow): ChannelConfig {
  return normalizeChannel({
    id: row.id,
    name: row.name,
    pusherType: row.pusherType as ChannelConfig['pusherType'],
    enabled: row.enabled === 1,
    pusherConfig: JSON.parse(row.pusherConfig),
    fieldMapping: JSON.parse(row.fieldMapping),
    pushIntervalMs: row.pushIntervalMs ?? undefined,
    pushConcurrency: row.pushConcurrency ?? undefined,
    defaultAccountFilter: row.defaultAccountFilter ? JSON.parse(row.defaultAccountFilter) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

const stmtAll = db.prepare<[], ChannelRow>('SELECT * FROM channels');
const stmtById = db.prepare<[string], ChannelRow>('SELECT * FROM channels WHERE id = ?');
const stmtUpsert = db.prepare<[string, string, string, number, string, string, number | null, number | null, string | null, string, string]>(
  `INSERT INTO channels (id, name, pusherType, enabled, pusherConfig, fieldMapping, pushIntervalMs, pushConcurrency, defaultAccountFilter, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     pusherType = excluded.pusherType,
     enabled = excluded.enabled,
     pusherConfig = excluded.pusherConfig,
     fieldMapping = excluded.fieldMapping,
     pushIntervalMs = excluded.pushIntervalMs,
     pushConcurrency = excluded.pushConcurrency,
     defaultAccountFilter = excluded.defaultAccountFilter,
     createdAt = excluded.createdAt,
     updatedAt = excluded.updatedAt`,
);
const stmtDelete = db.prepare<[string]>('DELETE FROM channels WHERE id = ?');

export function loadChannels(): ChannelConfig[] {
  return stmtAll.all().map(rowToChannel);
}

export function saveChannels(channels: ChannelConfig[]): void {
  const upsertMany = db.transaction(() => {
    db.exec('DELETE FROM channels');
    for (const ch of channels) {
      const c = normalizeChannel(ch);
      stmtUpsert.run(
        c.id, c.name, c.pusherType, c.enabled ? 1 : 0,
        JSON.stringify(c.pusherConfig), JSON.stringify(c.fieldMapping),
        c.pushIntervalMs ?? null, c.pushConcurrency ?? null,
        c.defaultAccountFilter ? JSON.stringify(c.defaultAccountFilter) : null,
        c.createdAt, c.updatedAt,
      );
    }
  });
  upsertMany();
}

export function findChannel(id: string): ChannelConfig | undefined {
  const row = stmtById.get(id);
  return row ? rowToChannel(row) : undefined;
}

export function upsertChannel(channel: ChannelConfig): void {
  const c = normalizeChannel(channel);
  stmtUpsert.run(
    c.id, c.name, c.pusherType, c.enabled ? 1 : 0,
    JSON.stringify(c.pusherConfig), JSON.stringify(c.fieldMapping),
    c.pushIntervalMs ?? null, c.pushConcurrency ?? null,
    c.defaultAccountFilter ? JSON.stringify(c.defaultAccountFilter) : null,
    c.createdAt, c.updatedAt,
  );
}

export function removeChannel(id: string): boolean {
  const result = stmtDelete.run(id);
  return result.changes > 0;
}

function normalizeChannel(channel: ChannelConfig): ChannelConfig {
  return String(channel.pusherType) === 'cpa_upload'
    ? { ...channel, pusherType: 'cliproxycli' as ChannelConfig['pusherType'] }
    : channel;
}
