import { nanoid } from 'nanoid';
import db from './db.js';

export type AccountEventType = 'import' | 'probe' | 'refresh' | 'push' | 'delete' | 'restore' | 'transfer' | 'sync';

export interface AccountEvent {
  id: string;
  accountId: string;
  email: string;
  eventType: AccountEventType;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  id: string;
  accountId: string;
  email: string;
  eventType: string;
  detail: string;
  createdAt: string;
}

function rowToEvent(row: EventRow): AccountEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email,
    eventType: row.eventType as AccountEventType,
    detail: JSON.parse(row.detail),
    createdAt: row.createdAt,
  };
}

const stmtInsert = db.prepare<[string, string, string, string, string, string]>(
  `INSERT INTO account_events (id, accountId, email, eventType, detail, createdAt)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const stmtByAccountId = db.prepare<[string, number, number], EventRow>(
  `SELECT * FROM account_events WHERE accountId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
);

const stmtByAccountIdAndType = db.prepare<[string, string, number, number], EventRow>(
  `SELECT * FROM account_events WHERE accountId = ? AND eventType = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
);

const stmtCountByAccountId = db.prepare<[string], { count: number }>(
  `SELECT COUNT(*) as count FROM account_events WHERE accountId = ?`,
);

export function addEvent(
  accountId: string,
  email: string,
  eventType: AccountEventType,
  detail: Record<string, unknown> = {},
): AccountEvent {
  const id = nanoid(12);
  const createdAt = new Date().toISOString();
  stmtInsert.run(id, accountId, email, eventType, JSON.stringify(detail), createdAt);
  return { id, accountId, email, eventType, detail, createdAt };
}

export function addBatchEvents(
  events: Array<{ accountId: string; email: string; eventType: AccountEventType; detail?: Record<string, unknown> }>,
): number {
  if (events.length === 0) return 0;
  const now = new Date().toISOString();
  const doInsert = db.transaction(() => {
    for (const e of events) {
      stmtInsert.run(nanoid(12), e.accountId, e.email, e.eventType, JSON.stringify(e.detail ?? {}), now);
    }
  });
  doInsert();
  return events.length;
}

export function getByAccountId(
  accountId: string,
  limit = 50,
  offset = 0,
): { events: AccountEvent[]; total: number } {
  const rows = stmtByAccountId.all(accountId, limit, offset);
  const total = stmtCountByAccountId.get(accountId)?.count ?? 0;
  return { events: rows.map(rowToEvent), total };
}

export function getByAccountIdAndType(
  accountId: string,
  eventType: AccountEventType,
  limit = 50,
  offset = 0,
): AccountEvent[] {
  return stmtByAccountIdAndType.all(accountId, eventType, limit, offset).map(rowToEvent);
}
