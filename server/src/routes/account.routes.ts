import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { getDataDir } from '../persistence/json-store.js';
import type { AccountQuery, AccountSourceType } from '../../../shared/types/account.js';
import { parseFileContent, detectFileType, extractFieldNames, parseMultipleFiles } from '../adapters/data-parser.js';
import { detectFieldMapping } from '../adapters/field-detector.js';
import { matchProfile, findProfile } from '../persistence/profile.store.js';
import * as accountService from '../services/account.service.js';
import * as accountUsageJobService from '../services/account-usage-job.service.js';
import * as usageProbeService from '../services/usage-probe.service.js';
import * as accountTestService from '../services/account-test.service.js';
import * as accountStore from '../persistence/account.store.js';
import * as transferService from '../services/transfer.service.js';
import * as tokenRefreshService from '../services/token-refresh.service.js';
import { formatRecord, accountToFields, type ExportFormat } from '../utils/export-formatter.js';
import * as eventStore from '../persistence/event.store.js';
import * as batchStore from '../persistence/batch.store.js';
import { decodeOpenAiJwt } from '../utils/jwt.js';

const uploadBaseDir = path.join(getDataDir(), 'uploads');
if (!fs.existsSync(uploadBaseDir)) fs.mkdirSync(uploadBaseDir, { recursive: true });

function makeTimestampDir(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
  const dir = path.join(uploadBaseDir, ts);
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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.json', '.csv', '.tsv'].includes(ext)) cb(null, true);
    else cb(new Error('仅支持 JSON 和 CSV 文件'));
  },
});

export const accountRoutes: ReturnType<typeof Router> = Router();

function parseQuery(req: { query: Record<string, unknown> }): AccountQuery {
  const sourceType = req.query.sourceType === 'local' || req.query.sourceType === 'remote'
    ? req.query.sourceType as AccountSourceType
    : undefined;
  return {
    planType: req.query.planType as string | undefined,
    expired: req.query.expired === 'true' ? true : req.query.expired === 'false' ? false : undefined,
    disabled: req.query.disabled === 'true' ? true : req.query.disabled === 'false' ? false : undefined,
    notPushedTo: req.query.notPushedTo as string | undefined,
    search: req.query.search as string | undefined,
    tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
    sourceType,
    source: req.query.source as string | undefined,
    sourceChannelId: req.query.sourceChannelId as string | undefined,
    importDateFrom: req.query.importDateFrom as string | undefined,
    importDateTo: req.query.importDateTo as string | undefined,
    includeDeleted: req.query.includeDeleted === 'true' ? true : undefined,
    onlyDeleted: req.query.onlyDeleted === 'true' ? true : undefined,
    batchId: req.query.batchId as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  };
}

/** 账号列表（X-Total-Count 返回过滤后总数） */
accountRoutes.get('/', (req, res) => {
  const { data, total } = accountService.queryAccountsWithCount(parseQuery(req));
  res.header('X-Total-Count', String(total));
  res.json(data);
});

/** 过滤后的统计 */
accountRoutes.get('/stats', (req, res) => {
  const q = parseQuery(req);
  res.json(accountService.getFilteredStats(q));
});

/** 导入批次列表 */
accountRoutes.get('/batches', (_req, res) => {
  res.json(batchStore.findRecent(50));
});

/** 导入批次详情 */
accountRoutes.get('/batches/:id', (req, res) => {
  const batch = batchStore.findById(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  res.json(batch);
});

/** 过滤后的 id 列表（用于全量探测） */
accountRoutes.get('/ids', (req, res) => {
  const q = parseQuery(req);
  res.json(accountService.queryIds(q));
});

/** 导入: 上传文件 → 解析 → 入池 */
accountRoutes.post('/import', upload.array('files', 500), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    const singleFile = req.file;
    const profileId = req.body?.profileId as string | undefined;
    let fieldMapping = req.body?.fieldMapping ? JSON.parse(req.body.fieldMapping) as Record<string, string> : undefined;

    // 确定上传文件列表
    let fileItems: { filename: string; content: string }[] = [];
    if (files && files.length > 0) {
      fileItems = files.map((f) => ({
        filename: f.originalname,
        content: fs.readFileSync(f.path, 'utf-8'),
      }));
    } else if (singleFile) {
      fileItems = [{
        filename: singleFile.originalname,
        content: fs.readFileSync(singleFile.path, 'utf-8'),
      }];
    } else {
      return res.status(400).json({ error: '请上传文件' });
    }

    // 解析
    const { records, warnings } = fileItems.length === 1
      ? (() => {
          const ft = detectFileType(fileItems[0].filename);
          return parseFileContent(fileItems[0].content, ft);
        })()
      : parseMultipleFiles(fileItems);

    if (records.length === 0) {
      return res.status(400).json({ error: '没有有效记录', warnings });
    }

    // 确定字段映射: 请求传的 > profile 匹配 > 自动检测
    if (!fieldMapping) {
      const detected = extractFieldNames(records);
      const matched = profileId
        ? findProfile(profileId)
        : matchProfile(detected);
      if (matched) {
        fieldMapping = matched.fieldMapping;
      } else {
        fieldMapping = detectFieldMapping(detected, ['email', 'access_token'], ['refresh_token', 'id_token', 'account_id', 'organization_id', 'plan_type']);
      }
    }

    const source = fileItems.length === 1 ? fileItems[0].filename : `${fileItems.length} files`;
    const planTypeOverride = req.body?.planType as string | undefined;
    const tagsStr = req.body?.tags as string | undefined;
    const tags = tagsStr ? tagsStr.split(',').map((t: string) => t.trim()).filter(Boolean) : undefined;
    const result = accountService.importFromRecords(records, fieldMapping, source, {
      planTypeOverride: planTypeOverride || undefined,
      tags,
    });

    res.json({ ...result, total: records.length, warnings });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 启动异步用量探测/额度统计任务 */
accountRoutes.post('/usage-jobs', (req, res) => {
  try {
    const mode = req.body?.mode === 'quota' ? 'quota' : 'probe';
    const ids = Array.isArray(req.body?.ids) ? req.body.ids as string[] : undefined;
    const query = req.body?.query as ReturnType<typeof parseQuery> | undefined;
    const job = accountUsageJobService.startUsageJob({
      mode,
      ids,
      query: query ? {
        planType: query.planType,
        expired: query.expired,
        disabled: query.disabled,
        notPushedTo: query.notPushedTo,
        search: query.search,
        tags: query.tags,
        sourceType: query.sourceType,
        source: query.source,
        sourceChannelId: query.sourceChannelId,
        importDateFrom: query.importDateFrom,
        importDateTo: query.importDateTo,
      } : undefined,
    });
    res.status(201).json(job);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

accountRoutes.get('/usage-jobs/latest', (req, res) => {
  const query = parseQuery(req);
  const mode = req.query.mode === 'probe' ? 'probe' : 'quota';
  const job = accountUsageJobService.findLatestUsageJob({
    mode,
    query: {
      planType: query.planType,
      expired: query.expired,
      disabled: query.disabled,
      notPushedTo: query.notPushedTo,
      search: query.search,
      tags: query.tags,
      sourceType: query.sourceType,
      source: query.source,
      sourceChannelId: query.sourceChannelId,
      importDateFrom: query.importDateFrom,
      importDateTo: query.importDateTo,
    },
  });
  if (!job) return res.json(null);
  res.json(job);
});

accountRoutes.get('/usage-jobs/:id', (req, res) => {
  const job = accountUsageJobService.getUsageJobSnapshot(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

accountRoutes.get('/quota-archives/latest', (req, res) => {
  const query = parseQuery(req);
  const archive = accountUsageJobService.findLatestQuotaArchive({
    query: {
      planType: query.planType,
      expired: query.expired,
      disabled: query.disabled,
      notPushedTo: query.notPushedTo,
      search: query.search,
      tags: query.tags,
      sourceType: query.sourceType,
      source: query.source,
      sourceChannelId: query.sourceChannelId,
      importDateFrom: query.importDateFrom,
      importDateTo: query.importDateTo,
    },
  });
  if (!archive) return res.json(null);
  res.json(archive);
});

accountRoutes.get('/usage-jobs/:id/events', (req, res) => {
  const job = accountUsageJobService.getUsageJobSnapshot(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!accountUsageJobService.subscribeToUsageJob(req.params.id, res)) {
    res.end();
    return;
  }

  if (job.status === 'completed' || job.status === 'failed') {
    res.end();
  }
});

/** 删除单个（软删除） */
accountRoutes.delete('/:id', (req, res) => {
  const account = accountStore.findById(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  const ok = accountStore.softDelete(req.params.id, 'manual');
  if (!ok) return res.status(400).json({ error: '账号已删除' });
  eventStore.addEvent(account.id, account.email, 'delete', { reason: 'manual' });
  res.json({ ok: true });
});

/** 批量删除（软删除） */
accountRoutes.post('/batch-delete', (req, res) => {
  const ids = req.body?.ids as string[];
  if (!ids || ids.length === 0) return res.status(400).json({ error: '缺少 ids' });
  const accounts = ids.map((id) => accountStore.findById(id)).filter(Boolean);
  const removed = accountStore.softDeleteBatch(ids, 'manual');
  eventStore.addBatchEvents(accounts.map((a) => ({ accountId: a!.id, email: a!.email, eventType: 'delete' as const, detail: { reason: 'manual' } })));
  res.json({ removed });
});

/** 恢复单个 */
accountRoutes.post('/:id/restore', (req, res) => {
  const account = accountStore.findById(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  const ok = accountStore.restore(req.params.id);
  if (!ok) return res.status(400).json({ error: '恢复失败' });
  eventStore.addEvent(account.id, account.email, 'restore', {});
  res.json({ ok: true });
});

/** 批量恢复 */
accountRoutes.post('/batch-restore', (req, res) => {
  const ids = req.body?.ids as string[];
  if (!ids || ids.length === 0) return res.status(400).json({ error: '缺少 ids' });
  const accounts = ids.map((id) => accountStore.findById(id)).filter(Boolean);
  const restored = accountStore.restoreBatch(ids);
  eventStore.addBatchEvents(accounts.map((a) => ({ accountId: a!.id, email: a!.email, eventType: 'restore' as const })));
  res.json({ restored });
});

/** 永久删除（仅回收站中使用） */
accountRoutes.post('/batch-permanent-delete', (req, res) => {
  const ids = req.body?.ids as string[];
  if (!ids || ids.length === 0) return res.status(400).json({ error: '缺少 ids' });
  const removed = accountStore.permanentDeleteBatch(ids);
  res.json({ removed });
});

/** 独立用量探测：支持按 ID 探测（池模式）或直接传 tokens 探测（文件模式） */
accountRoutes.post('/probe', async (req, res) => {
  try {
    const ids = req.body?.ids as string[] | undefined;
    const tokens = req.body?.tokens as { email: string; accessToken: string; accountId?: string; planType?: string }[] | undefined;

    let accounts: { id?: string; email: string; accessToken: string; accountId?: string; planType?: string }[];

    if (Array.isArray(tokens) && tokens.length > 0) {
      // 直接传 token 探测（文件模式，账号不在库中）
      accounts = tokens.map((t) => {
        const accessToken = String(t.accessToken ?? '').trim();
        const claims = decodeOpenAiJwt(accessToken);
        return {
          email: String(t.email ?? '').trim() || claims.email,
          accessToken,
          accountId: String(t.accountId ?? '').trim() || claims.accountId || undefined,
          planType: String(t.planType ?? '').trim() || claims.planType || undefined,
        };
      }).filter((t) => t.email && t.accessToken);
    } else if (ids && ids.length > 0) {
      // 探测指定账号（池模式）
      const all = accountService.queryAccounts({});
      accounts = all
        .filter((a) => ids.includes(a.id))
        .map((a) => ({
          id: a.id,
          email: a.email,
          accessToken: a.accessToken,
          accountId: a.accountId || undefined,
          planType: a.planType,
        }));
    } else {
      // 探测全部
      const all = accountService.queryAccounts({ limit: 500 });
      accounts = all.map((a) => ({
        id: a.id,
        email: a.email,
        accessToken: a.accessToken,
        accountId: a.accountId || undefined,
        planType: a.planType,
      }));
    }

    if (accounts.length === 0) {
      return res.json({ total: 0, probed: 0, results: [] });
    }

    const pendingUpdates: Array<{ accountId: string; probe: import('../../../shared/types/account.js').AccountProbeState }> = [];
    const result = await usageProbeService.probeBatchUsage(accounts, {
      concurrency: 3,
      onResult: async (item) => {
        if (!item.accountId) return;
        pendingUpdates.push({ accountId: item.accountId, probe: usageProbeService.toProbeState(item) });
      },
    });
    // 探测完毕后一次性批量保存所有 probe 状态（含限流/失效等）
    accountStore.batchUpdateProbeStates(pendingUpdates);
    // 写入探测事件
    const probeEvents = result.results
      .filter((r) => r.accountId)
      .map((r) => ({
        accountId: r.accountId!,
        email: r.email,
        eventType: 'probe' as const,
        detail: { status: r.status, fiveHourUsed: r.usage?.fiveHourUsed, sevenDayUsed: r.usage?.sevenDayUsed },
      }));
    eventStore.addBatchEvents(probeEvents);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 探测全部号池账号用量（GET） */
accountRoutes.get('/probe', async (_req, res) => {
  try {
    const all = accountService.queryAccounts({ limit: 500 });
    const accounts = all.map((a) => ({
      id: a.id,
      email: a.email,
      accessToken: a.accessToken,
      accountId: a.accountId || undefined,
      planType: a.planType,
    }));
    if (accounts.length === 0) {
      return res.json({ total: 0, probed: 0, results: [] });
    }
    const pendingUpdates: Array<{ accountId: string; probe: import('../../../shared/types/account.js').AccountProbeState }> = [];
    const result = await usageProbeService.probeBatchUsage(accounts, {
      concurrency: 3,
      onResult: async (item) => {
        if (!item.accountId) return;
        pendingUpdates.push({ accountId: item.accountId, probe: usageProbeService.toProbeState(item) });
      },
    });
    accountStore.batchUpdateProbeStates(pendingUpdates);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 导出账号（支持 format=raw/cpa/sub2api，默认 raw） */
accountRoutes.get('/export', (req, res) => {
  try {
    const q: AccountQuery = {};
    if (req.query.planType) q.planType = String(req.query.planType);
    if (req.query.search) q.search = String(req.query.search);
    if (req.query.tags) q.tags = String(req.query.tags).split(',');
    if (req.query.sourceType) q.sourceType = String(req.query.sourceType) as AccountSourceType;
    if (req.query.source) q.source = String(req.query.source);
    if (req.query.sourceChannelId) q.sourceChannelId = String(req.query.sourceChannelId);
    if (req.query.batchId) q.batchId = String(req.query.batchId);

    const rawFormat = String(req.query.format ?? 'raw').trim().toLowerCase();
    const format: ExportFormat = rawFormat === 'sub2api' ? 'sub2api' : rawFormat === 'cpa' ? 'cpa' : 'raw';

    const ids = accountStore.queryIds(q);
    const allAccounts = accountStore.loadAll();
    const idSet = new Set(ids);
    const exported = allAccounts
      .filter((a) => idSet.has(a.id))
      .map((a) => formatRecord(format, accountToFields(a)));

    const filename = `accounts-export-${format}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(exported);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** 账号转移（SSE） */
accountRoutes.post('/transfer', (req, res) => {
  const { accountIds, sourceChannelId, targetChannelId } = req.body ?? {};
  if (!Array.isArray(accountIds) || !sourceChannelId || !targetChannelId) {
    return res.status(400).json({ error: '缺少参数' });
  }
  transferService.executeTransfer({ accountIds, sourceChannelId, targetChannelId }, res);
});

/** 批量账号测试（SSE） */
accountRoutes.post('/batch-test', (req, res) => {
  const { ids, model } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请提供账号ID列表' });
  accountTestService.testAccountBatch(ids, res, typeof model === 'string' ? model : undefined);
});

/** 单账号可用性测试（SSE, 支持 body 覆盖模型） */
accountRoutes.post('/:id/test', (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
  accountTestService.testAccount(req.params.id, res, model);
});

/** 单账号可用性测试（SSE, 向下兼容 GET） */
accountRoutes.get('/:id/test', (req, res) => {
  const model = typeof req.query?.model === 'string' ? req.query.model : undefined;
  accountTestService.testAccount(req.params.id, res, model);
});

// ── 账号事件 ──────────────────────────────────────────────

/** 获取账号事件列表 */
accountRoutes.get('/:id/events', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const eventType = typeof req.query.type === 'string' ? req.query.type : undefined;

  if (eventType) {
    const events = eventStore.getByAccountIdAndType(req.params.id, eventType as Parameters<typeof eventStore.getByAccountIdAndType>[1], limit, offset);
    res.json({ events, total: events.length });
  } else {
    const result = eventStore.getByAccountId(req.params.id, limit, offset);
    res.json(result);
  }
});

// ── Token 刷新 ──────────────────────────────────────────────

/** 单个账号刷新 token */
accountRoutes.post('/:id/refresh', async (req, res) => {
  try {
    const account = accountStore.findById(req.params.id);
    if (!account) return res.status(404).json({ error: '账号不存在' });
    if (!account.refreshToken) return res.status(400).json({ error: '该账号没有 refresh_token' });

    const result = await tokenRefreshService.refreshToken({
      id: account.id,
      email: account.email,
      refreshToken: account.refreshToken,
    });

    if (result.status === 'ok') {
      accountStore.updateTokens(account.id, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        idToken: result.idToken,
        expiredAt: result.expiredAt,
        planType: result.planType,
        accountId: result.accountId,
        organizationId: result.organizationId,
      });
    }
    eventStore.addEvent(account.id, account.email, 'refresh', {
      status: result.status, newExpiredAt: result.expiredAt, errorMessage: result.errorMessage,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 批量刷新 token */
accountRoutes.post('/batch-refresh', async (req, res) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供账号ID列表' });
    }

    const targets: tokenRefreshService.RefreshTarget[] = [];
    for (const id of ids) {
      const account = accountStore.findById(id);
      if (account?.refreshToken) {
        targets.push({ id: account.id, email: account.email, refreshToken: account.refreshToken });
      }
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: '所选账号均无 refresh_token' });
    }

    const pendingUpdates: Array<{ id: string; tokens: accountStore.TokenUpdate }> = [];
    const result = await tokenRefreshService.refreshBatch(targets, {
      concurrency: 3,
      onResult: (item) => {
        if (item.status === 'ok' && item.id) {
          pendingUpdates.push({
            id: item.id,
            tokens: {
              accessToken: item.accessToken,
              refreshToken: item.refreshToken,
              idToken: item.idToken,
              expiredAt: item.expiredAt,
              planType: item.planType,
              accountId: item.accountId,
              organizationId: item.organizationId,
            },
          });
        }
      },
    });

    accountStore.batchUpdateTokens(pendingUpdates);
    // 写入刷新事件
    const refreshEvents = result.results
      .filter((r) => r.id)
      .map((r) => ({
        accountId: r.id!,
        email: r.email,
        eventType: 'refresh' as const,
        detail: { status: r.status, newExpiredAt: r.expiredAt, errorMessage: r.errorMessage },
      }));
    eventStore.addBatchEvents(refreshEvents);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
