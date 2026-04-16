import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import archiver from 'archiver';
import { nanoid } from 'nanoid';
import { getDataDir } from '../persistence/json-store.js';
import { parseFileContent, detectFileType, extractFieldNames, parseMultipleFiles } from '../adapters/data-parser.js';
import { detectFieldMapping } from '../adapters/field-detector.js';
import { defaultRegistry } from '../pushers/index.js';
import { matchProfile } from '../persistence/profile.store.js';
import * as fileStore from '../persistence/file.store.js';
import type { ParsedData, ParsedRecordPage, RawRecord } from '../../../shared/types/data.js';

const uploadDir = path.join(getDataDir(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.json';
    cb(null, `${nanoid(12)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.json', '.csv', '.tsv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JSON 和 CSV 文件'));
    }
  },
});

/** 根据解析结果构建响应，合并数据写入临时文件 */
function buildParseResponse(
  records: RawRecord[],
  warnings: string[],
  fileType: 'json' | 'csv',
  pusherType: string | undefined,
): ParsedData {
  const detectedFields = extractFieldNames(records);

  // 尝试自动匹配 DataProfile
  const matched = matchProfile(detectedFields);
  let suggestedMapping: Record<string, string> = {};

  if (matched) {
    // 有匹配的模板，直接用模板的映射
    suggestedMapping = { ...matched.fieldMapping };
  } else if (pusherType && defaultRegistry.has(String(pusherType))) {
    // 无匹配，走字段检测器
    const pusher = defaultRegistry.get(String(pusherType));
    suggestedMapping = detectFieldMapping(
      detectedFields,
      pusher.schema.requiredDataFields,
      pusher.schema.optionalDataFields,
    );
  }

  // 将合并后的数据写入单个临时文件（供后续推送使用）
  const mergedId = `${nanoid(12)}.json`;
  const mergedPath = path.join(uploadDir, mergedId);
  const mergedContent = records.map((r) => r.fields);
  fs.writeFileSync(mergedPath, JSON.stringify(mergedContent, null, 2), 'utf-8');

  return {
    fileId: mergedId,
    totalRecords: records.length,
    sampleRecords: records.slice(0, 10),
    detectedFields,
    suggestedMapping,
    fileType,
    parseWarnings: warnings,
    matchedProfileId: matched?.id,
    matchedProfileName: matched?.name,
  };
}

function readMergedRecords(fileId: string): RawRecord[] {
  const safeFileId = path.basename(fileId);
  const mergedPath = path.join(uploadDir, safeFileId);
  if (!fs.existsSync(mergedPath)) {
    throw new Error('解析文件不存在');
  }

  const content = fs.readFileSync(mergedPath, 'utf-8');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('解析文件格式无效');
  }

  return parsed.map((fields, index) => ({
    index,
    fields: fields && typeof fields === 'object' && !Array.isArray(fields)
      ? fields as Record<string, unknown>
      : {},
  }));
}

function sanitizeExportName(input: string, fallback: string): string {
  const trimmed = input.trim();
  const base = (trimmed || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  const named = base || fallback;
  return named.toLowerCase().endsWith('.json') ? named : `${named}.json`;
}

function applyExportOverrides(
  fields: Record<string, unknown>,
  overrides: { planType?: string; planField?: string },
): Record<string, unknown> {
  const planType = String(overrides.planType ?? '').trim();
  if (!planType) return { ...fields };

  const next: Record<string, unknown> = { ...fields, plan_type: planType };
  const planField = String(overrides.planField ?? '').trim();
  if (planField && planField !== 'plan_type') {
    next[planField] = planType;
  }
  return next;
}

export const dataRoutes = Router();

/** 按 fileId 分页读取解析后的完整记录 */
dataRoutes.get('/records/:fileId', (req, res) => {
  try {
    const records = readMergedRecords(req.params.fileId);
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100) || 100));
    const page: ParsedRecordPage = {
      totalRecords: records.length,
      records: records.slice(offset, offset + limit),
    };
    res.json(page);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 按选中记录导出 zip，每条记录一个 json 文件 */
dataRoutes.post('/export-zip', (req, res) => {
  try {
    const fileId = String(req.body?.fileId ?? '').trim();
    const items = Array.isArray(req.body?.items)
      ? req.body.items as Array<{ index?: number; filename?: string; planType?: string; planField?: string }>
      : [];

    if (!fileId) {
      return res.status(400).json({ error: '缺少 fileId' });
    }
    if (items.length === 0) {
      return res.status(400).json({ error: '缺少导出项' });
    }

    const records = readMergedRecords(fileId);
    const picked = items
      .map((item, order) => {
        const index = Number(item.index);
        if (!Number.isInteger(index) || index < 0 || index >= records.length) return null;
        return {
          index,
          order,
          filename: String(item.filename ?? '').trim(),
          fields: applyExportOverrides(records[index].fields, {
            planType: item.planType,
            planField: item.planField,
          }),
        };
      })
      .filter((item): item is { index: number; order: number; filename: string; fields: Record<string, unknown> } => Boolean(item));

    if (picked.length === 0) {
      return res.status(400).json({ error: '没有有效的导出记录' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="detected-records-${new Date().toISOString().slice(0, 10)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    });
    archive.pipe(res);

    const usedNames = new Set<string>();
    for (const item of picked) {
      const fallback = `record-${String(item.index + 1).padStart(4, '0')}.json`;
      let filename = sanitizeExportName(item.filename, fallback);
      if (usedNames.has(filename)) {
        const ext = path.extname(filename) || '.json';
        const name = filename.slice(0, -ext.length);
        let suffix = 2;
        while (usedNames.has(`${name}-${suffix}${ext}`)) suffix++;
        filename = `${name}-${suffix}${ext}`;
      }
      usedNames.add(filename);
      archive.append(JSON.stringify(item.fields, null, 2), { name: filename });
    }

    void archive.finalize();
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 单文件上传解析 */
dataRoutes.post('/parse', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '请上传文件' });

    const content = fs.readFileSync(file.path, 'utf-8');
    const fileType = detectFileType(file.originalname);
    const { records, warnings } = parseFileContent(content, fileType);

    if (records.length === 0) {
      return res.status(400).json({ error: '文件中没有有效记录', warnings });
    }

    const pusherType = req.body?.pusherType ?? req.query?.pusherType;
    const result = buildParseResponse(records, warnings, fileType, pusherType as string);

    // 记录原始文件（单文件 batchId 就是 fileId）
    const batchId = result.fileId.replace(/\.\w+$/, '');
    fileStore.upsert({
      id: nanoid(12),
      batchId,
      originalName: file.originalname,
      storedName: file.filename,
      size: file.size,
      mimeType: file.mimetype,
      uploadedAt: new Date().toISOString(),
      associatedTaskIds: [],
    });

    res.json({ ...result, batchId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 多文件上传解析（每个文件作为一条或多条记录） */
dataRoutes.post('/parse-multi', upload.array('files', 500), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const fileItems = files.map((f) => ({
      filename: f.originalname,
      content: fs.readFileSync(f.path, 'utf-8'),
    }));

    const { records, warnings } = parseMultipleFiles(fileItems);

    if (records.length === 0) {
      return res.status(400).json({ error: '所有文件中没有有效记录', warnings });
    }

    const pusherType = req.body?.pusherType ?? req.query?.pusherType;
    const result = buildParseResponse(records, warnings, 'json', pusherType as string);

    // 为每个原始文件创建 FileRecord，共享同一个 batchId
    const batchId = nanoid(12);
    const now = new Date().toISOString();
    const fileRecords = files.map((f) => ({
      id: nanoid(12),
      batchId,
      originalName: f.originalname,
      storedName: f.filename,
      size: f.size,
      mimeType: f.mimetype,
      uploadedAt: now,
      associatedTaskIds: [] as string[],
    }));
    fileStore.upsertMany(fileRecords);

    res.json({ ...result, batchId, fileCount: files.length });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
