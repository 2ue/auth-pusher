import type { FileRecord } from '../../../shared/types/file-record.js';
import db from './db.js';

interface FileRow {
  id: string;
  batchId: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  associatedTaskIds: string;
}

function rowToRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    originalName: row.originalName,
    storedName: row.storedName,
    size: row.size,
    mimeType: row.mimeType,
    uploadedAt: row.uploadedAt,
    associatedTaskIds: JSON.parse(row.associatedTaskIds),
  };
}

const stmtAll = db.prepare<[], FileRow>('SELECT * FROM file_records');
const stmtById = db.prepare<[string], FileRow>('SELECT * FROM file_records WHERE id = ?');
const stmtByBatch = db.prepare<[string], FileRow>('SELECT * FROM file_records WHERE batchId = ?');
const stmtByStoredName = db.prepare<[string], FileRow>('SELECT * FROM file_records WHERE storedName = ?');
const stmtUpsert = db.prepare<[string, string, string, string, number, string, string, string]>(
  `INSERT INTO file_records (id, batchId, originalName, storedName, size, mimeType, uploadedAt, associatedTaskIds)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     batchId = excluded.batchId,
     originalName = excluded.originalName,
     storedName = excluded.storedName,
     size = excluded.size,
     mimeType = excluded.mimeType,
     uploadedAt = excluded.uploadedAt,
     associatedTaskIds = excluded.associatedTaskIds`,
);
const stmtDelete = db.prepare<[string]>('DELETE FROM file_records WHERE id = ?');
const stmtUpdateTaskIds = db.prepare<[string, string]>('UPDATE file_records SET associatedTaskIds = ? WHERE id = ?');

export function loadAll(): FileRecord[] {
  return stmtAll.all().map(rowToRecord);
}

export function find(id: string): FileRecord | undefined {
  const row = stmtById.get(id);
  return row ? rowToRecord(row) : undefined;
}

export function findByBatch(batchId: string): FileRecord[] {
  return stmtByBatch.all(batchId).map(rowToRecord);
}

export function upsert(record: FileRecord): void {
  stmtUpsert.run(
    record.id, record.batchId, record.originalName, record.storedName,
    record.size, record.mimeType, record.uploadedAt,
    JSON.stringify(record.associatedTaskIds),
  );
}

export function upsertMany(incoming: FileRecord[]): void {
  const insertMany = db.transaction(() => {
    for (const record of incoming) {
      stmtUpsert.run(
        record.id, record.batchId, record.originalName, record.storedName,
        record.size, record.mimeType, record.uploadedAt,
        JSON.stringify(record.associatedTaskIds),
      );
    }
  });
  insertMany();
}

export function remove(id: string): boolean {
  const result = stmtDelete.run(id);
  return result.changes > 0;
}

export function addTaskAssociation(batchId: string, taskId: string): void {
  const records = stmtByBatch.all(batchId);
  if (records.length === 0) return;
  const updateMany = db.transaction(() => {
    for (const row of records) {
      const taskIds: string[] = JSON.parse(row.associatedTaskIds);
      if (!taskIds.includes(taskId)) {
        taskIds.push(taskId);
        stmtUpdateTaskIds.run(JSON.stringify(taskIds), row.id);
      }
    }
  });
  updateMany();
}

export function findByStoredName(storedName: string): FileRecord | undefined {
  const row = stmtByStoredName.get(storedName);
  return row ? rowToRecord(row) : undefined;
}
