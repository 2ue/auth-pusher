import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import archiver from 'archiver';
import { getDataDir } from '../persistence/json-store.js';
import * as fileStore from '../persistence/file.store.js';

export const fileRoutes: ReturnType<typeof Router> = Router();

/** 文件列表（可按 taskId 或 batchId 筛选） */
fileRoutes.get('/', (req, res) => {
  const taskId = req.query.taskId as string | undefined;
  const batchId = req.query.batchId as string | undefined;
  let records = fileStore.loadAll();
  if (taskId) {
    records = records.filter((r) => r.associatedTaskIds.includes(taskId));
  }
  if (batchId) {
    records = records.filter((r) => r.batchId === batchId);
  }
  records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json(records);
});

/** 单个文件下载 */
fileRoutes.get('/:id/download', (req, res) => {
  const record = fileStore.find(req.params.id);
  if (!record) {
    res.status(404).json({ error: '文件记录不存在' });
    return;
  }
  const filePath = path.join(getDataDir(), 'uploads', record.storedName);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: '文件已被删除' });
    return;
  }
  res.download(filePath, record.originalName);
});

/** 按批次打包下载（zip） */
fileRoutes.get('/batch/:batchId/download', (req, res) => {
  const records = fileStore.findByBatch(req.params.batchId);
  if (records.length === 0) {
    res.status(404).json({ error: '批次不存在或无文件' });
    return;
  }

  const uploadsDir = path.join(getDataDir(), 'uploads');
  const existingFiles = records.filter((r) => fs.existsSync(path.join(uploadsDir, r.storedName)));

  if (existingFiles.length === 0) {
    res.status(404).json({ error: '文件已被删除' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="batch-${req.params.batchId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => res.status(500).json({ error: err.message }));
  archive.pipe(res);

  for (const record of existingFiles) {
    const filePath = path.join(uploadsDir, record.storedName);
    archive.file(filePath, { name: record.originalName });
  }

  archive.finalize();
});

/** 删除单个文件 */
fileRoutes.delete('/:id', (req, res) => {
  const record = fileStore.find(req.params.id);
  if (!record) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  const filePath = path.join(getDataDir(), 'uploads', record.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fileStore.remove(req.params.id);
  res.json({ ok: true });
});
