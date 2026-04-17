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
import { decodeOpenAiJwt } from '../utils/jwt.js';
import * as tokenRefreshService from '../services/token-refresh.service.js';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

type ExportFormat = 'raw' | 'cpa' | 'sub2api';
type ExportMode = 'individual' | 'merged';

interface ExportItemInput {
  index?: number;
  filename?: string;
  planType?: string;
  planField?: string;
  email?: string;
  accountId?: string;
}

function pickField(fields: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const direct = fields[key];
    if (direct != null && String(direct).trim()) return String(direct);
    if (key.includes('.')) {
      const parts = key.split('.');
      let current: unknown = fields;
      for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) { current = undefined; break; }
        current = (current as Record<string, unknown>)[part];
      }
      if (current != null && String(current).trim()) return String(current);
    }
  }
  return '';
}

/** 原始 Token 文件格式：扁平 JSON，含 plan_type（与 dp-auth-raw profile 对齐） */
function formatRaw(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const accountId = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);
  const planType = pickField(fields, ['plan_type', 'planType', 'credentials.plan_type']);

  const out: Record<string, unknown> = { email, access_token: accessToken };
  if (refreshToken) out.refresh_token = refreshToken;
  if (idToken) out.id_token = idToken;
  if (accountId) out.account_id = accountId;
  if (planType) out.plan_type = planType;
  return out;
}

/** CPA (CliproxyCLI) 上传格式：与 cpa-upload.pusher.ts 构造的文件一致，不含 plan_type */
function formatCpa(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const sessionToken = pickField(fields, ['session_token', 'sessionToken']);
  const accountId = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);

  const out: Record<string, unknown> = { email, access_token: accessToken };
  if (refreshToken) out.refresh_token = refreshToken;
  if (idToken) out.id_token = idToken;
  if (sessionToken) out.session_token = sessionToken;
  if (accountId) out.account_id = accountId;
  return out;
}

/** SUB2API 导出格式：完整 OAuth account payload（与 Sub2ApiPusher.buildRequest 对齐） */
function formatSub2Api(fields: Record<string, unknown>): Record<string, unknown> {
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  const accessToken = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  const refreshToken = pickField(fields, ['refresh_token', 'refreshToken', 'credentials.refresh_token']);
  const idToken = pickField(fields, ['id_token', 'idToken', 'credentials.id_token']);
  const accountIdField = pickField(fields, ['account_id', 'accountId', 'credentials.chatgpt_account_id']);
  const organizationIdField = pickField(fields, ['organization_id', 'organizationId', 'credentials.organization_id']);
  const planTypeField = pickField(fields, ['plan_type', 'planType', 'credentials.plan_type']);

  const atClaims = decodeOpenAiJwt(accessToken);
  const itClaims = decodeOpenAiJwt(idToken);

  const chatgptAccountId = accountIdField || atClaims.accountId;
  const chatgptUserId = atClaims.userId;
  const organizationId = organizationIdField || itClaims.organizationId;
  const planType = planTypeField || atClaims.planType || itClaims.planType;

  const credentials: Record<string, unknown> = {
    access_token: accessToken,
    client_id: OAUTH_CLIENT_ID,
  };
  if (atClaims.exp > 0) credentials.expires_at = new Date(atClaims.exp * 1000).toISOString();
  if (refreshToken) credentials.refresh_token = refreshToken;
  if (idToken) credentials.id_token = idToken;
  if (chatgptAccountId) credentials.chatgpt_account_id = chatgptAccountId;
  if (chatgptUserId) credentials.chatgpt_user_id = chatgptUserId;
  if (organizationId) credentials.organization_id = organizationId;
  if (planType) credentials.plan_type = planType;

  return {
    name: email,
    platform: 'openai',
    type: 'oauth',
    credentials,
    extra: { email },
  };
}

function formatRecord(format: ExportFormat, fields: Record<string, unknown>): Record<string, unknown> {
  if (format === 'sub2api') return formatSub2Api(fields);
  if (format === 'cpa') return formatCpa(fields);
  return formatRaw(fields);
}

const uploadBaseDir = path.join(getDataDir(), 'uploads');
if (!fs.existsSync(uploadBaseDir)) fs.mkdirSync(uploadBaseDir, { recursive: true });

/** 兼容旧 merged 文件的读取：先在 uploadBaseDir 找，再在子目录找 */
const uploadDir = uploadBaseDir;

function makeTimestampDirName(): string {
  const now = new Date();
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
}

function makeTimestampDir(): string {
  const dirName = makeTimestampDirName();
  const dir = path.join(uploadBaseDir, dirName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, makeTimestampDir());
  },
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

  // 将合并后的数据写入时间戳目录下的临时文件
  const tsDirName = makeTimestampDirName();
  const tsDir = path.join(uploadBaseDir, tsDirName);
  if (!fs.existsSync(tsDir)) fs.mkdirSync(tsDir, { recursive: true });
  const mergedName = `${nanoid(12)}.json`;
  const mergedPath = path.join(tsDir, mergedName);
  const mergedContent = records.map((r) => r.fields);
  fs.writeFileSync(mergedPath, JSON.stringify(mergedContent, null, 2), 'utf-8');

  // fileId = 子目录/文件名
  const mergedId = `${tsDirName}/${mergedName}`;

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

function resolveMergedPath(fileId: string): string {
  // 新格式：相对路径如 "20260417-153000/abc123.json"
  const candidate = path.join(uploadBaseDir, fileId);
  if (fs.existsSync(candidate)) return candidate;
  // 兼容旧格式：扁平文件名如 "abc123.json"
  const legacy = path.join(uploadBaseDir, path.basename(fileId));
  if (fs.existsSync(legacy)) return legacy;
  throw new Error('解析文件不存在');
}

function readMergedRecords(fileId: string): RawRecord[] {
  const mergedPath = resolveMergedPath(fileId);
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

/** 通用账号导出：支持 raw / sub2api 两种格式，individual (zip) / merged (单 JSON) 两种模式 */
dataRoutes.post('/export-accounts', (req, res) => {
  try {
    const fileId = String(req.body?.fileId ?? '').trim();
    const rawFormat = String(req.body?.format ?? 'raw').trim().toLowerCase();
    const format: ExportFormat = rawFormat === 'sub2api' ? 'sub2api' : rawFormat === 'cpa' ? 'cpa' : 'raw';
    const rawMode = String(req.body?.mode ?? 'individual').trim().toLowerCase();
    const mode: ExportMode = rawMode === 'merged' ? 'merged' : 'individual';
    const downloadName = String(req.body?.downloadName ?? '').trim();
    const items = Array.isArray(req.body?.items) ? (req.body.items as ExportItemInput[]) : [];

    if (!fileId) return res.status(400).json({ error: '缺少 fileId' });
    if (items.length === 0) return res.status(400).json({ error: '缺少导出项' });

    const records = readMergedRecords(fileId);
    const picked = items
      .map((item, order) => {
        const index = Number(item.index);
        if (!Number.isInteger(index) || index < 0 || index >= records.length) return null;
        const overridden = applyExportOverrides(records[index].fields, {
          planType: item.planType,
          planField: item.planField,
        });
        return {
          index,
          order,
          filename: String(item.filename ?? '').trim(),
          email: String(item.email ?? '').trim(),
          accountId: String(item.accountId ?? '').trim(),
          fields: overridden,
        };
      })
      .filter((item): item is { index: number; order: number; filename: string; email: string; accountId: string; fields: Record<string, unknown> } => Boolean(item));

    if (picked.length === 0) return res.status(400).json({ error: '没有有效的导出记录' });

    const dateSlug = new Date().toISOString().slice(0, 10);

    if (mode === 'merged') {
      const payloads = picked.map((item) => formatRecord(format, item.fields));
      const body = format === 'sub2api'
        ? JSON.stringify({ accounts: payloads }, null, 2)
        : JSON.stringify(payloads, null, 2);
      const fileName = (downloadName || `detected-${format}-merged-${dateSlug}`).replace(/\.json$/i, '') + '.json';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.end(body);
    }

    const zipName = (downloadName || `detected-${format}-${dateSlug}`).replace(/\.zip$/i, '') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
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
      const payload = formatRecord(format, item.fields);
      archive.append(JSON.stringify(payload, null, 2), { name: filename });
    }

    void archive.finalize();
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** @deprecated 保留兼容，行为等同 raw + individual 的 export-accounts */
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

/** 追加解析：把新文件解析结果按 access_token/email 去重合并到已有 fileId */
function dedupeKey(fields: Record<string, unknown>): string {
  const access = pickField(fields, ['access_token', 'accessToken', 'credentials.access_token']);
  if (access) return `at:${access}`;
  const email = pickField(fields, ['email', 'Email', 'extra.email']);
  if (email) return `em:${email.toLowerCase()}`;
  return '';
}

dataRoutes.post('/append/:fileId', upload.array('files', 500), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) return res.status(400).json({ error: '请上传文件' });

    const rawFileId = String(req.params.fileId ?? '');
    let mergedPath: string;
    try { mergedPath = resolveMergedPath(rawFileId); } catch { return res.status(404).json({ error: '原始文件不存在，请重新上传' }); }

    const existing = readMergedRecords(rawFileId).map((r) => r.fields);
    const keys = new Set<string>();
    for (const fields of existing) {
      const key = dedupeKey(fields);
      if (key) keys.add(key);
    }

    const fileItems = files.map((f) => ({
      filename: f.originalname,
      content: fs.readFileSync(f.path, 'utf-8'),
    }));
    const { records: parsed, warnings } = files.length === 1
      ? (() => {
          const fileType = detectFileType(files[0].originalname);
          const r = parseFileContent(fileItems[0].content, fileType);
          return { records: r.records, warnings: r.warnings };
        })()
      : parseMultipleFiles(fileItems);

    let added = 0;
    let duplicated = 0;
    const merged = [...existing];
    for (const record of parsed) {
      const key = dedupeKey(record.fields);
      if (key && keys.has(key)) {
        duplicated += 1;
        continue;
      }
      if (key) keys.add(key);
      merged.push(record.fields);
      added += 1;
    }

    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2), 'utf-8');

    const now = new Date().toISOString();
    const batchId = safeFileId.replace(/\.\w+$/, '');
    fileStore.upsertMany(files.map((f) => ({
      id: nanoid(12),
      batchId,
      originalName: f.originalname,
      storedName: f.filename,
      size: f.size,
      mimeType: f.mimetype,
      uploadedAt: now,
      associatedTaskIds: [] as string[],
    })));

    const detectedFields = extractFieldNames(merged.map((fields, index) => ({ index, fields })));
    res.json({
      fileId: safeFileId,
      totalRecords: merged.length,
      added,
      duplicated,
      detectedFields,
      parseWarnings: warnings,
    });
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

// ── Token 刷新（文件模式） ─────────────────────────────────

dataRoutes.post('/refresh-tokens', async (req, res) => {
  try {
    const fileId = String(req.body?.fileId ?? '').trim();
    const items = Array.isArray(req.body?.items) ? (req.body.items as Array<{ index: number; refreshToken: string }>) : [];

    if (!fileId) return res.status(400).json({ error: '缺少 fileId' });
    if (items.length === 0) return res.status(400).json({ error: '缺少刷新项' });

    const records = readMergedRecords(fileId);

    const targets: tokenRefreshService.RefreshTarget[] = items
      .filter((item) => {
        const idx = Number(item.index);
        return Number.isInteger(idx) && idx >= 0 && idx < records.length && item.refreshToken;
      })
      .map((item) => {
        const fields = records[item.index].fields;
        const email = String(
          pickField(fields, ['email', 'Email', 'user_email']) || '',
        );
        return { index: item.index, email, refreshToken: item.refreshToken };
      });

    if (targets.length === 0) {
      return res.status(400).json({ error: '没有可刷新的项（均缺少 refresh_token）' });
    }

    // 逐条刷新
    const result = await tokenRefreshService.refreshBatch(targets, {
      concurrency: 3,
    });

    // 刷新成功的写回文件
    const mergedPath = resolveMergedPath(fileId);
    const rawContent = JSON.parse(fs.readFileSync(mergedPath, 'utf-8')) as Record<string, unknown>[];

    let updatedCount = 0;
    for (const r of result.results) {
      if (r.status !== 'ok' || r.index == null) continue;
      const idx = r.index;
      if (idx < 0 || idx >= rawContent.length) continue;

      const fields = rawContent[idx];
      // 更新常见 token 字段
      if (r.accessToken) {
        if ('access_token' in fields) fields['access_token'] = r.accessToken;
        if ('accessToken' in fields) fields['accessToken'] = r.accessToken;
        if ('token' in fields) fields['token'] = r.accessToken;
        // 如果以上都没有，用最通用的 key
        if (!('access_token' in fields) && !('accessToken' in fields) && !('token' in fields)) {
          fields['access_token'] = r.accessToken;
        }
      }
      if (r.refreshToken) {
        if ('refresh_token' in fields) fields['refresh_token'] = r.refreshToken;
        if ('refreshToken' in fields) fields['refreshToken'] = r.refreshToken;
        if (!('refresh_token' in fields) && !('refreshToken' in fields)) {
          fields['refresh_token'] = r.refreshToken;
        }
      }
      if (r.idToken) {
        if ('id_token' in fields) fields['id_token'] = r.idToken;
        if ('idToken' in fields) fields['idToken'] = r.idToken;
      }

      updatedCount++;
    }

    if (updatedCount > 0) {
      fs.writeFileSync(mergedPath, JSON.stringify(rawContent, null, 2), 'utf-8');
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
