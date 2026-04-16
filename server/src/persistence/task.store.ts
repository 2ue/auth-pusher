import type { PushTask } from '../../../shared/types/task.js';
import db from './db.js';

interface TaskRow {
  id: string;
  channelId: string;
  channelName: string;
  pusherType: string;
  status: string;
  totalItems: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
  items: string;
}

function rowToTask(row: TaskRow): PushTask {
  return {
    id: row.id,
    channelId: row.channelId,
    channelName: row.channelName,
    pusherType: row.pusherType,
    status: row.status as PushTask['status'],
    totalItems: row.totalItems,
    successCount: row.successCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
    items: JSON.parse(row.items),
  };
}

const stmtUpsert = db.prepare<[string, string, string, string, string, number, number, number, string, string | null, string]>(
  `INSERT INTO push_tasks (id, channelId, channelName, pusherType, status, totalItems, successCount, failedCount, createdAt, completedAt, items)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     channelId = excluded.channelId,
     channelName = excluded.channelName,
     pusherType = excluded.pusherType,
     status = excluded.status,
     totalItems = excluded.totalItems,
     successCount = excluded.successCount,
     failedCount = excluded.failedCount,
     createdAt = excluded.createdAt,
     completedAt = excluded.completedAt,
     items = excluded.items`,
);
const stmtById = db.prepare<[string], TaskRow>('SELECT * FROM push_tasks WHERE id = ?');
const stmtAll = db.prepare<[], TaskRow>('SELECT * FROM push_tasks ORDER BY createdAt DESC');
const stmtDelete = db.prepare<[string]>('DELETE FROM push_tasks WHERE id = ?');

export function saveTask(task: PushTask): void {
  stmtUpsert.run(
    task.id, task.channelId, task.channelName, task.pusherType,
    task.status, task.totalItems, task.successCount, task.failedCount,
    task.createdAt, task.completedAt ?? null,
    JSON.stringify(task.items),
  );
}

export function loadTask(id: string): PushTask | null {
  const row = stmtById.get(id);
  return row ? rowToTask(row) : null;
}

export function listTasks(): PushTask[] {
  return stmtAll.all().map(rowToTask);
}

export function deleteTask(id: string): boolean {
  const result = stmtDelete.run(id);
  return result.changes > 0;
}
