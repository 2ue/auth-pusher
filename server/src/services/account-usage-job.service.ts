import type { Response } from 'express';
import { nanoid } from 'nanoid';
import type { Account, AccountProbeState, AccountQuery, AccountUsageStatus, UsageSnapshot } from '../../../shared/types/account.js';
import type { QuotaArchive, QuotaArchiveScope, QuotaSummary } from '../../../shared/types/quota.js';
import type { PlanQuota } from '../../../shared/types/settings.js';
import * as accountStore from '../persistence/account.store.js';
import * as quotaArchiveStore from '../persistence/quota-archive.store.js';
import * as settingsStore from '../persistence/settings.store.js';
import type { PersistedUsageJobRecord } from '../persistence/usage-job.store.js';
import * as usageJobStore from '../persistence/usage-job.store.js';
import * as usageProbeService from './usage-probe.service.js';

type UsageJobMode = 'probe' | 'quota';
type UsageJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface UsageQuotaSummary extends QuotaSummary {}

export interface UsageJobSnapshot {
  id: string;
  mode: UsageJobMode;
  status: UsageJobStatus;
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  quota: UsageQuotaSummary;
}

export interface UsageJobEvent {
  type: 'snapshot' | 'account_result' | 'complete' | 'error';
  job: UsageJobSnapshot;
  result?: {
    accountId: string;
    email: string;
    planType: string;
    probe: AccountProbeState;
  };
}

interface UsageJobState {
  snapshot: UsageJobSnapshot;
  scope: QuotaArchiveScope;
  scopeKey: string;
  subscribers: Set<Response>;
}

const jobs = new Map<string, UsageJobState>();
const JOB_TTL_MS = 30 * 60 * 1000;

usageJobStore.markUnfinishedAsFailed('服务重启，未完成的统计任务已中断');

export function startUsageJob(input: {
  mode: UsageJobMode;
  ids?: string[];
  query?: Omit<AccountQuery, 'limit' | 'offset'>;
}): UsageJobSnapshot {
  const scope = normalizeScope(input.ids, input.query);
  const scopeKey = buildScopeKey(scope);
  const runningJob = usageJobStore.findRunningByScope(scopeKey, input.mode);
  if (runningJob) {
    return toSnapshot(runningJob);
  }

  const targets = resolveTargets(input.ids, input.query);
  const now = new Date().toISOString();
  const snapshot: UsageJobSnapshot = {
    id: nanoid(12),
    mode: input.mode,
    status: targets.length > 0 ? 'running' : 'completed',
    total: targets.length,
    processed: 0,
    successCount: 0,
    errorCount: 0,
    tokenInvalidCount: 0,
    rateLimitedCount: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: targets.length > 0 ? undefined : now,
    quota: emptyQuota(),
  };

  jobs.set(snapshot.id, { snapshot, scope, scopeKey, subscribers: new Set() });
  persistSnapshot(snapshot, scope, scopeKey);

  if (targets.length === 0) {
    if (snapshot.mode === 'quota') {
      quotaArchiveStore.appendArchive({
        id: nanoid(12),
        scopeKey,
        scope,
        quota: { ...snapshot.quota },
        total: snapshot.total,
        processed: snapshot.processed,
        successCount: snapshot.successCount,
        errorCount: snapshot.errorCount,
        tokenInvalidCount: snapshot.tokenInvalidCount,
        rateLimitedCount: snapshot.rateLimitedCount,
        createdAt: snapshot.completedAt ?? now,
      });
    }
    scheduleCleanup(snapshot.id);
    return snapshot;
  }

  void runUsageJob(snapshot.id, targets).catch((error) => {
    const state = jobs.get(snapshot.id);
    if (!state) return;
    state.snapshot.status = 'failed';
    state.snapshot.updatedAt = new Date().toISOString();
    state.snapshot.completedAt = state.snapshot.updatedAt;
    persistSnapshot(state.snapshot, state.scope, state.scopeKey, error instanceof Error ? error.message : String(error));
    emit(snapshot.id, {
      type: 'error',
      job: { ...state.snapshot },
    });
    scheduleCleanup(snapshot.id);
    import('../utils/logger.js').then(({ logger }) => logger.error({ error }, 'usage job failed'));
  });

  return snapshot;
}

export function getUsageJobSnapshot(id: string): UsageJobSnapshot | undefined {
  const active = jobs.get(id)?.snapshot;
  if (active) return active;
  const persisted = usageJobStore.findJob(id);
  return persisted ? toSnapshot(persisted) : undefined;
}

export function findLatestQuotaArchive(input: {
  ids?: string[];
  query?: Omit<AccountQuery, 'limit' | 'offset'>;
}): QuotaArchive | undefined {
  return quotaArchiveStore.findLatestByScope(buildScopeKey(normalizeScope(input.ids, input.query)));
}

export function findLatestUsageJob(input: {
  mode?: UsageJobMode;
  ids?: string[];
  query?: Omit<AccountQuery, 'limit' | 'offset'>;
}): UsageJobSnapshot | undefined {
  const scopeKey = buildScopeKey(normalizeScope(input.ids, input.query));
  const persisted = usageJobStore.findLatestByScope(scopeKey, input.mode);
  return persisted ? toSnapshot(persisted) : undefined;
}

export function subscribeToUsageJob(id: string, res: Response) {
  const state = jobs.get(id);
  if (!state) return false;

  state.subscribers.add(res);
  emit(id, { type: 'snapshot', job: { ...state.snapshot } }, [res]);

  res.on('close', () => {
    const current = jobs.get(id);
    current?.subscribers.delete(res);
  });
  return true;
}

const PROBE_CONCURRENCY = 3;
const BATCH_FLUSH_INTERVAL_MS = 2000;

async function runUsageJob(jobId: string, targets: Account[]) {
  const quotas = settingsStore.load().planQuotas;

  // 批量累积 probe 结果，定期刷盘，避免每次结果都读写整个文件
  const pendingProbeUpdates: Array<{ accountId: string; probe: import('../../../shared/types/account.js').AccountProbeState }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushProbeUpdates = () => {
    if (pendingProbeUpdates.length === 0) return;
    const batch = pendingProbeUpdates.splice(0);
    accountStore.batchUpdateProbeStates(batch);
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushProbeUpdates();
    }, BATCH_FLUSH_INTERVAL_MS);
  };

  await usageProbeService.probeBatchUsage(
    targets.map((account) => ({
      id: account.id,
      email: account.email,
      accessToken: account.accessToken,
      accountId: account.accountId || undefined,
      planType: account.planType,
    })),
    {
      concurrency: PROBE_CONCURRENCY,
      onResult: async (result, _target, index) => {
        const state = jobs.get(jobId);
        if (!state) return;

        const probe = usageProbeService.toProbeState(result);

        // 累积到待刷盘队列，延迟批量写入
        pendingProbeUpdates.push({ accountId: result.accountId ?? '', probe });
        scheduleFlush();

        state.snapshot.processed += 1;
        state.snapshot.updatedAt = probe.probedAt;
        updateCounters(state.snapshot, result.status);
        if (result.usage) {
          accumulateQuota(state.snapshot.quota, result.planType ?? 'free', result.usage, quotas);
        }
        persistSnapshot(state.snapshot, state.scope, state.scopeKey);

        emit(jobId, {
          type: 'account_result',
          job: { ...state.snapshot },
          result: result.accountId ? {
            accountId: result.accountId,
            email: result.email,
            planType: result.planType ?? 'free',
            probe,
          } : undefined,
        });
      },
    },
  );

  // 任务结束，清除定时器并刷盘所有剩余的 probe 更新
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushProbeUpdates();

  const state = jobs.get(jobId);
  if (!state) return;
  state.snapshot.status = 'completed';
  state.snapshot.completedAt = new Date().toISOString();
  state.snapshot.updatedAt = state.snapshot.completedAt;
  persistSnapshot(state.snapshot, state.scope, state.scopeKey);
  if (state.snapshot.mode === 'quota') {
    quotaArchiveStore.appendArchive({
      id: nanoid(12),
      scopeKey: state.scopeKey,
      scope: state.scope,
      quota: { ...state.snapshot.quota },
      total: state.snapshot.total,
      processed: state.snapshot.processed,
      successCount: state.snapshot.successCount,
      errorCount: state.snapshot.errorCount,
      tokenInvalidCount: state.snapshot.tokenInvalidCount,
      rateLimitedCount: state.snapshot.rateLimitedCount,
      createdAt: state.snapshot.completedAt,
    });
  }
  emit(jobId, { type: 'complete', job: { ...state.snapshot } });
  scheduleCleanup(jobId);
}

function emit(jobId: string, event: UsageJobEvent, only?: Response[]) {
  const state = jobs.get(jobId);
  if (!state) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const targets = only ?? Array.from(state.subscribers);
  for (const res of targets) {
    try {
      res.write(data);
    } catch {
      state.subscribers.delete(res);
    }
  }
}

function resolveTargets(ids?: string[], query?: Omit<AccountQuery, 'limit' | 'offset'>): Account[] {
  const allAccounts = accountStore.loadAll();
  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    return allAccounts.filter((account) => idSet.has(account.id));
  }
  if (!query) return allAccounts;
  const orderedIds = accountStore.queryIds(query);
  const byId = new Map(allAccounts.map((account) => [account.id, account]));
  return orderedIds.map((id) => byId.get(id)).filter((account): account is Account => Boolean(account));
}

function updateCounters(snapshot: UsageJobSnapshot, status: AccountUsageStatus) {
  if (status === 'ok') {
    snapshot.successCount += 1;
    return;
  }
  if (status === 'rate_limited') {
    snapshot.successCount += 1;
    snapshot.rateLimitedCount += 1;
    return;
  }
  if (status === 'token_invalid') {
    snapshot.tokenInvalidCount += 1;
    return;
  }
  snapshot.errorCount += 1;
}

function emptyQuota(): UsageQuotaSummary {
  return {
    totalAccounts: 0,
    availableNow: 0,
    oneHour: 0,
    fiveHour: 0,
    sevenDay: 0,
    oneWeek: 0,
    oneMonth: 0,
  };
}

function accumulateQuota(
  quota: UsageQuotaSummary,
  planType: string,
  usage: UsageSnapshot,
  quotas: Record<string, PlanQuota>,
) {
  const now = Date.now();
  const oneHourLater = now + 60 * 60 * 1000;
  const config = quotas[planType] ?? quotas.free ?? { fiveHourUnits: 50, sevenDayUnits: 500, knivesPerUnit: 1 };
  const rem5hUnits = Math.max(0, Math.round(config.fiveHourUnits * (100 - usage.fiveHourUsed) / 100));
  const rem7dUnits = Math.max(0, Math.round(config.sevenDayUnits * (100 - usage.sevenDayUsed) / 100));
  const currentUnits = Math.min(rem5hUnits, rem7dUnits);
  const resetAt5h = usage.fiveHourResetAt ? new Date(usage.fiveHourResetAt).getTime() : 0;
  const willReset = resetAt5h > 0 && resetAt5h <= oneHourLater;
  const knivesPerUnit = config.knivesPerUnit || 1;

  quota.totalAccounts += 1;
  quota.availableNow += Math.round(currentUnits * knivesPerUnit);
  quota.oneHour += Math.round(Math.min(willReset ? config.fiveHourUnits : rem5hUnits, rem7dUnits) * knivesPerUnit);
  quota.fiveHour += Math.round(Math.min(config.fiveHourUnits, rem7dUnits) * knivesPerUnit);
  quota.sevenDay += Math.round(rem7dUnits * knivesPerUnit);
  quota.oneWeek = quota.sevenDay;
  quota.oneMonth = Math.round(quota.sevenDay * (30 / 7));
}

function normalizeScope(ids?: string[], query?: Omit<AccountQuery, 'limit' | 'offset'>): QuotaArchiveScope {
  return {
    ids: ids && ids.length > 0 ? [...ids].sort() : undefined,
    planType: query?.planType,
    expired: query?.expired,
    disabled: query?.disabled,
    notPushedTo: query?.notPushedTo,
    search: query?.search,
    tags: query?.tags ? [...query.tags].sort() : undefined,
    sourceType: query?.sourceType,
    source: query?.source,
    sourceChannelId: query?.sourceChannelId,
    importDateFrom: query?.importDateFrom,
    importDateTo: query?.importDateTo,
  };
}

function buildScopeKey(scope: QuotaArchiveScope) {
  return JSON.stringify(scope);
}

function persistSnapshot(
  snapshot: UsageJobSnapshot,
  scope: QuotaArchiveScope,
  scopeKey: string,
  errorMessage?: string,
) {
  usageJobStore.upsertJob({
    ...snapshot,
    scope,
    scopeKey,
    errorMessage,
  });
}

function toSnapshot(job: PersistedUsageJobRecord): UsageJobSnapshot {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    total: job.total,
    processed: job.processed,
    successCount: job.successCount,
    errorCount: job.errorCount,
    tokenInvalidCount: job.tokenInvalidCount,
    rateLimitedCount: job.rateLimitedCount,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    quota: job.quota,
  };
}

function scheduleCleanup(jobId: string) {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS).unref?.();
}
