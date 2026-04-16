import db from './db.js';

const stmtAll = db.prepare<[], { tag: string; type: string }>('SELECT tag, type FROM tags ORDER BY tag');
const stmtInsert = db.prepare<[string, string]>('INSERT OR IGNORE INTO tags (tag, type) VALUES (?, ?)');
const stmtDelete = db.prepare<[string]>('DELETE FROM tags WHERE tag = ? AND type = ?');
const stmtDeletePredefined = db.prepare<[string]>('DELETE FROM tags WHERE tag = ? AND type = \'predefined\'');
const stmtExists = db.prepare<[string], { tag: string }>('SELECT tag FROM tags WHERE tag = ?');

/** 获取所有唯一标签（预定义 + 自动收集） */
export function getAllUnique(): string[] {
  return stmtAll.all().map((row) => row.tag);
}

export function addPredefined(tag: string): void {
  stmtInsert.run(tag, 'predefined');
}

export function removePredefined(tag: string): void {
  stmtDeletePredefined.run(tag);
}

/** 自动收集标签（仅添加不存在的） */
export function addAutoCollected(tags: string[]): void {
  if (tags.length === 0) return;
  const insertMany = db.transaction(() => {
    for (const tag of tags) {
      if (!tag) continue;
      const existing = stmtExists.get(tag);
      if (!existing) {
        stmtInsert.run(tag, 'auto');
      }
    }
  });
  insertMany();
}
