import db from './db.js';

export interface ScheduledTask {
  id: string;
  channelId: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed';
  lastRunError?: string;
  lastTaskId?: string;
  createdAt: string;
}

interface ScheduledTaskRow {
  id: string;
  channelId: string;
  cronExpression: string;
  enabled: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastTaskId: string | null;
  createdAt: string;
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    channelId: row.channelId,
    cronExpression: row.cronExpression,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt ?? undefined,
    lastRunStatus: (row.lastRunStatus as ScheduledTask['lastRunStatus']) ?? undefined,
    lastRunError: row.lastRunError ?? undefined,
    lastTaskId: row.lastTaskId ?? undefined,
    createdAt: row.createdAt,
  };
}

const stmtAll = db.prepare<[], ScheduledTaskRow>('SELECT * FROM scheduled_tasks');
const stmtById = db.prepare<[string], ScheduledTaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?');
const stmtInsert = db.prepare<[string, string, string, number, string]>(
  `INSERT INTO scheduled_tasks (id, channelId, cronExpression, enabled, createdAt) VALUES (?, ?, ?, ?, ?)`,
);
const stmtUpdate = db.prepare<[string, number, string | null, string | null, string | null, string | null, string]>(
  `UPDATE scheduled_tasks SET cronExpression = ?, enabled = ?, lastRunAt = ?, lastRunStatus = ?, lastRunError = ?, lastTaskId = ? WHERE id = ?`,
);
const stmtDelete = db.prepare<[string]>('DELETE FROM scheduled_tasks WHERE id = ?');

export function loadAll(): ScheduledTask[] {
  return stmtAll.all().map(rowToTask);
}

export function find(id: string): ScheduledTask | undefined {
  const row = stmtById.get(id);
  return row ? rowToTask(row) : undefined;
}

export function insert(task: ScheduledTask): void {
  stmtInsert.run(task.id, task.channelId, task.cronExpression, task.enabled ? 1 : 0, task.createdAt);
}

export function update(task: ScheduledTask): void {
  stmtUpdate.run(
    task.cronExpression, task.enabled ? 1 : 0,
    task.lastRunAt ?? null, task.lastRunStatus ?? null,
    task.lastRunError ?? null, task.lastTaskId ?? null,
    task.id,
  );
}

export function remove(id: string): boolean {
  const result = stmtDelete.run(id);
  return result.changes > 0;
}
