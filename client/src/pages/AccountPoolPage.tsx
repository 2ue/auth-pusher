import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, getWithTotal, post, del, upload, getApiKeyHeader } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
import { useSSE } from '../hooks/useSSE';
import { UsageCell } from '../components/UsageBar';
import QuotaPanel from '../components/QuotaPanel';
import Pagination from '../components/Pagination';
import { BatchActionBar } from '../components/BatchActionBar';
import { EventTimeline } from '../components/EventTimeline';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TextField } from '@/components/TextField';
import { SelectField } from '@/components/SelectField';
import { FileTrigger } from '@/components/FileTrigger';
import { cn } from '@/lib/utils';
import { buildOpenAiModelOptions } from '@/constants/openaiModels';
import type { QuotaResult } from '../utils/calcQuota';

/* ---------- SSE 辅助：解析 fetch streaming 响应中的 SSE 事件 ---------- */
async function readSSEStream(
  response: globalThis.Response,
  onEvent: (data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }
}

/* ---------- 测试结果类型 ---------- */
interface TestResultItem {
  accountId: string;
  email: string;
  success: boolean;
  content?: string;
  error?: string;
}
interface BatchTestProgress {
  total: number;
  processed: number;
  success: number;
  failed: number;
}

interface UsageSnapshot {
  fiveHourUsed: number;
  fiveHourResetAt: string;
  sevenDayUsed: number;
  sevenDayResetAt: string;
}

interface AccountProbeState {
  status: 'ok' | 'error' | 'token_invalid' | 'rate_limited';
  usage: UsageSnapshot | null;
  errorMessage: string;
  probedAt: string;
}

interface Account {
  id: string;
  email: string;
  planType: string;
  tags: string[];
  disabled: boolean;
  expiredAt: string;
  sourceType: 'local' | 'remote';
  source: string;
  importedAt: string;
  pushHistory: { channelId: string; channelName: string; status: string; at: string }[];
  lastProbe: AccountProbeState | null;
}

interface Stats {
  total: number;
  byPlanType: Record<string, number>;
  bySourceType: Record<string, number>;
  expired: number;
  expiringSoon: number;
  disabled: number;
  recentImported: number;
  quota: QuotaResult;
}

interface Channel {
  id: string;
  name: string;
  pusherType: string;
  enabled: boolean;
  capabilities?: { syncable: boolean; fetchRemote: boolean };
}

interface PlanQuota {
  fiveHourUnits: number;
  sevenDayUnits: number;
  knivesPerUnit: number;
}

interface AppSettings {
  defaultProbeModel: string;
  defaultTestModel: string;
  planQuotas: Record<string, PlanQuota>;
  [k: string]: unknown;
}

interface TestDialogState {
  accountId: string;
  email: string;
  model: string;
}

interface UsageJobSnapshot {
  id: string;
  mode: 'quota';
  status: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  quota: QuotaResult;
}

interface UsageJobEvent {
  type: 'snapshot' | 'account_result' | 'complete' | 'error';
  job: UsageJobSnapshot;
  result?: {
    accountId: string;
    email: string;
    planType: string;
    probe: AccountProbeState;
  };
}

interface ProbeApiResult {
  accountId?: string;
  email: string;
  planType?: string;
  status: AccountProbeState['status'];
  usage: UsageSnapshot | null;
  errorMessage: string;
}

interface ProbeApiResponse {
  total: number;
  probed: number;
  results: ProbeApiResult[];
}

function groupByChannel(h: Account['pushHistory']): Record<string, Account['pushHistory'][0]> {
  const m: Record<string, Account['pushHistory'][0]> = {};
  for (const e of h) m[e.channelName] = e;
  return m;
}

function formatSourceLabel(account: Account): string {
  if (account.sourceType === 'remote') {
    return account.source.startsWith('sync:') ? account.source.slice(5) : account.source;
  }
  return account.source || '本地导入';
}

function getProbeBadge(probe: AccountProbeState | null) {
  if (!probe) return { variant: 'muted' as const, label: '未检测' };
  if (probe.status === 'ok') return { variant: 'success' as const, label: '正常' };
  if (probe.status === 'rate_limited') return { variant: 'warning' as const, label: '限流' };
  if (probe.status === 'token_invalid') return { variant: 'destructive' as const, label: 'Token失效' };
  return { variant: 'destructive' as const, label: '错误' };
}

function formatProbeTime(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString();
}

function appendScopeParams(params: URLSearchParams, scope: {
  planType?: string;
  search?: string;
  tags?: string[];
  sourceType?: '' | 'local' | 'remote';
  source?: string;
}) {
  if (scope.planType) params.set('planType', scope.planType);
  if (scope.search) params.set('search', scope.search);
  if (scope.tags && scope.tags.length > 0) params.set('tags', scope.tags.join(','));
  if (scope.sourceType) params.set('sourceType', scope.sourceType);
  if (scope.source) params.set('source', scope.source);
}

const PLAN_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'free', label: 'free' },
  { value: 'plus', label: 'plus' },
  { value: 'pro', label: 'pro' },
  { value: 'team', label: 'team' },
];

export default function AccountPoolPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [channels, setChannels] = useState<Channel[]>([]);
  const activeTab = searchParams.get('channel') ?? 'all';
  const setActiveTab = useCallback((tab: string) => {
    if (tab === 'all') setSearchParams({});
    else setSearchParams({ channel: tab });
  }, [setSearchParams]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [searchDraft, setSearchDraft] = useState('');
  const [batches, setBatches] = useState<Array<{ id: string; source: string; createdAt: string; totalCount: number }>>([]);
  const [filter, setFilter] = useState({
    planType: '',
    search: '',
    tag: '',
    sourceType: '' as '' | 'local' | 'remote',
    batchId: '',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);

  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFiles, setImportFiles] = useState<FileList | null>(null);
  const [importPlanType, setImportPlanType] = useState('');
  const [importTags, setImportTags] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');

  const [probeMap, setProbeMap] = useState<Map<string, AccountProbeState>>(new Map());
  const [probingIds, setProbingIds] = useState<Set<string>>(new Set());
  const [batchProbing, setBatchProbing] = useState(false);
  // quotaStats 现在从 stats.quota 读取，不再独立维护
  const [quotaTime, setQuotaTime] = useState('');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usageJob, setUsageJob] = useState<UsageJobSnapshot | null>(null);
  const [activeUsageJobId, setActiveUsageJobId] = useState<string | null>(null);
  const activeUsageJobIdRef = useRef<string | null>(null);
  const { confirm, notify } = useFeedback();

  // ── 账号测试状态 ────────────────────────────────────────────
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testDialog, setTestDialog] = useState<TestDialogState | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [testOutput, setTestOutput] = useState<string[]>([]);
  const [testStreamingContent, setTestStreamingContent] = useState('');
  const [testErrorMessage, setTestErrorMessage] = useState('');
  const [batchTesting, setBatchTesting] = useState(false);
  const [batchTestResults, setBatchTestResults] = useState<TestResultItem[]>([]);
  const [batchTestProgress, setBatchTestProgress] = useState<BatchTestProgress | null>(null);
  const [batchTestModel, setBatchTestModel] = useState('');

  // ── 转移状态 ────────────────────────────────────────────
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [transferResults, setTransferResults] = useState<{email: string; status: string; error?: string}[]>([]);
  const [transferProgress, setTransferProgress] = useState<{total: number; processed: number; pushed: number; skipped: number; failed: number} | null>(null);

  const defaultTestModel = String(settings?.defaultTestModel ?? 'gpt-5.2');

  const openTestDialog = useCallback((id: string, email: string) => {
    setTestDialog({
      accountId: id,
      email,
      model: defaultTestModel,
    });
    setTestStatus('idle');
    setTestOutput([]);
    setTestStreamingContent('');
    setTestErrorMessage('');
  }, [defaultTestModel]);

  const closeTestDialog = useCallback(() => {
    if (testingId) return;
    setTestDialog(null);
    setTestStatus('idle');
    setTestOutput([]);
    setTestStreamingContent('');
    setTestErrorMessage('');
  }, [testingId]);

  const appendTestOutput = useCallback((line: string) => {
    setTestOutput((current) => [...current, line]);
  }, []);

  const handleTestAccount = useCallback(async () => {
    if (!testDialog) return;

    const model = testDialog.model.trim() || defaultTestModel;
    setTestingId(testDialog.accountId);
    setTestStatus('connecting');
    setTestOutput([
      `开始测试账号: ${testDialog.email}`,
      `使用模型: ${model}`,
      '',
    ]);
    setTestStreamingContent('');
    setTestErrorMessage('');

    try {
      const res = await fetch(`/api/accounts/${testDialog.accountId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeader() },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      let content = '';
      await readSSEStream(res, (ev) => {
        if (ev.type === 'test_start') {
          appendTestOutput(`已连接，开始请求模型: ${String(ev.model ?? model)}`);
          appendTestOutput('等待响应...');
          return;
        }

        if (ev.type === 'content') {
          const delta = String(ev.text ?? '');
          content += delta;
          setTestStreamingContent(content);
          return;
        }

        if (ev.type === 'test_complete') {
          const finalContent = String(ev.content ?? content);
          if (finalContent) appendTestOutput(finalContent);
          setTestStreamingContent('');
          setTestStatus('success');
          return;
        }

        if (ev.type === 'error') {
          if (content) appendTestOutput(content);
          setTestStreamingContent('');
          setTestStatus('error');
          setTestErrorMessage(String(ev.error ?? '测试失败'));
        }
      });
    } catch (err) {
      setTestStreamingContent('');
      setTestStatus('error');
      setTestErrorMessage((err as Error).message);
    } finally {
      setTestingId(null);
    }
  }, [appendTestOutput, defaultTestModel, testDialog]);

  const handleBatchTest = useCallback(async () => {
    if (selected.size === 0) return;
    const model = String(settings?.defaultTestModel ?? 'gpt-5.2');
    setBatchTesting(true);
    setBatchTestResults([]);
    setBatchTestProgress(null);
    setBatchTestModel(model);
    try {
      const res = await fetch('/api/accounts/batch-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeader() },
        body: JSON.stringify({ ids: Array.from(selected), model }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      await readSSEStream(res, (ev) => {
        if (ev.type === 'batch_start') {
          setBatchTestModel(String(ev.model ?? model));
          setBatchTestProgress({ total: ev.total as number, processed: 0, success: 0, failed: 0 });
        }
        if (ev.type === 'item_result') {
          const item: TestResultItem = {
            accountId: ev.accountId as string,
            email: ev.email as string,
            success: ev.success as boolean,
            content: ev.content as string | undefined,
            error: ev.error as string | undefined,
          };
          setBatchTestResults((prev) => [...prev, item]);
          setBatchTestProgress((prev) => prev ? {
            ...prev,
            processed: prev.processed + 1,
            success: prev.success + (item.success ? 1 : 0),
            failed: prev.failed + (item.success ? 0 : 1),
          } : null);
        }
        if (ev.type === 'batch_complete') {
          setBatchTestProgress((prev) => prev ? {
            ...prev,
            processed: ev.total as number,
            success: ev.success as number,
            failed: ev.failed as number,
          } : null);
        }
      });
    } catch (err) {
      notify({ tone: 'error', title: '批量测试失败', description: (err as Error).message });
    } finally {
      setBatchTesting(false);
    }
  }, [notify, selected, settings?.defaultTestModel]);

  const applyProbeResults = useCallback((items: ProbeApiResult[]) => {
    const probedAt = new Date().toISOString();
    const probeById = new Map<string, AccountProbeState>();

    for (const item of items) {
      if (!item.accountId) continue;
      probeById.set(item.accountId, {
        status: item.status,
        usage: item.usage,
        errorMessage: item.errorMessage,
        probedAt,
      });
    }

    if (probeById.size === 0) return;

    setProbeMap((current) => {
      const next = new Map(current);
      for (const [accountId, probe] of probeById) next.set(accountId, probe);
      return next;
    });
    setAccounts((current) => current.map((entry) => {
      const probe = probeById.get(entry.id);
      return probe ? { ...entry, lastProbe: probe } : entry;
    }));
  }, []);

  const handleProbeAccount = useCallback(async (account: Account) => {
    setProbingIds((current) => new Set(current).add(account.id));
    try {
      const result = await post<ProbeApiResponse>('/accounts/probe', { ids: [account.id] });
      const item = result.results[0];
      if (!item) {
        notify({ tone: 'error', title: '检测失败', description: '未返回检测结果' });
        return;
      }

      applyProbeResults([item]);
      notify({
        tone: item.status === 'ok' || item.status === 'rate_limited' ? 'success' : 'error',
        title: `额度检测完成: ${account.email}`,
        description: item.errorMessage || (item.status === 'ok' ? '额度已更新' : item.status === 'rate_limited' ? '账号当前限流' : '状态已更新'),
      });
    } catch (err) {
      notify({ tone: 'error', title: `额度检测失败: ${account.email}`, description: (err as Error).message });
    } finally {
      setProbingIds((current) => {
        const next = new Set(current);
        next.delete(account.id);
        return next;
      });
    }
  }, [applyProbeResults, notify]);

  const handleBatchProbe = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    setBatchProbing(true);
    setProbingIds((current) => new Set([...current, ...ids]));
    try {
      const result = await post<ProbeApiResponse>('/accounts/probe', { ids });
      applyProbeResults(result.results);

      const summary = {
        ok: 0,
        rateLimited: 0,
        tokenInvalid: 0,
        error: 0,
      };
      for (const item of result.results) {
        if (item.status === 'ok') summary.ok += 1;
        else if (item.status === 'rate_limited') summary.rateLimited += 1;
        else if (item.status === 'token_invalid') summary.tokenInvalid += 1;
        else summary.error += 1;
      }

      notify({
        tone: summary.error === 0 && summary.tokenInvalid === 0 ? 'success' : 'error',
        title: `批量额度检测完成`,
        description: `共 ${result.results.length} 条，正常 ${summary.ok}，限流 ${summary.rateLimited}，失效 ${summary.tokenInvalid}，错误 ${summary.error}`,
      });
    } catch (err) {
      notify({ tone: 'error', title: '批量额度检测失败', description: (err as Error).message });
    } finally {
      setBatchProbing(false);
      setProbingIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }, [applyProbeResults, notify, selected]);

  useEffect(() => { activeUsageJobIdRef.current = activeUsageJobId; }, [activeUsageJobId]);

  useEffect(() => {
    get<Channel[]>('/channels').then(setChannels);
    get<AppSettings>('/settings').then(setSettings);
    loadTags();
    loadBatches();
  }, []);

  const enabledChannels = channels.filter((c) => c.enabled);
  const activeChannel = channels.find((c) => c.id === activeTab);
  const isAllTab = activeTab === 'all';
  const isRecycleBin = activeTab === 'recycle';
  const deletedTag = activeChannel ? `deleted:${activeChannel.name}` : '';
  const quotaLoading = usageJob?.status === 'running';

  const resetUsageState = useCallback((clearProbeMap = false) => {
    setActiveUsageJobId(null);
    setUsageJob(null);
    /* quota now from stats */
    setQuotaTime('');
    if (clearProbeMap) setProbeMap(new Map());
  }, []);

  useEffect(() => {
    setPage(-1);
    setSelected(new Set());
    setSyncResult('');
    resetUsageState(true);
  }, [activeTab, resetUsageState]);

  useEffect(() => {
    setPage(-1);
    resetUsageState(false);
  }, [filter.planType, filter.tag, filter.sourceType, resetUsageState]);

  useEffect(() => { if (page === -1) setPage(0); }, [page]);

  const loadTags = () => get<string[]>('/tags').then(setAllTags);
  const loadBatches = () => get<typeof batches>('/accounts/batches').then(setBatches);

  const buildScopeQuery = useCallback(() => {
    // 渠道 tab 下用 sync tag 筛选，同时保留用户手动选的 tag
    const tagsList: string[] = [];
    if (!isAllTab && activeChannel) tagsList.push(`sync:${activeChannel.name}`);
    if (filter.tag) tagsList.push(filter.tag);
    return {
    planType: filter.planType || undefined,
    search: filter.search || undefined,
    tags: tagsList.length > 0 ? tagsList : undefined,
    sourceType: isAllTab ? (filter.sourceType || undefined) : undefined,
  }; }, [activeChannel, filter.planType, filter.search, filter.sourceType, filter.tag, isAllTab]);

  const fetchLatestUsageState = useCallback(() => {
    const params = new URLSearchParams();
    appendScopeParams(params, buildScopeQuery());
    get<UsageJobSnapshot | null>(`/accounts/usage-jobs/latest?mode=quota&${params}`)
      .then((job) => {
        if (job) {
          setUsageJob(job);
          setQuotaTime(formatProbeTime(job.completedAt ?? job.updatedAt));
          if (job.status === 'running') setActiveUsageJobId(job.id);
          else setActiveUsageJobId(null);
        } else {
          setUsageJob(null);
          setActiveUsageJobId(null);
          // 尝试从归档获取
          get<{ quota: QuotaResult; createdAt: string } | null>(`/accounts/quota-archives/latest?${params}`)
            .then((archive) => {
              if (archive) { setQuotaTime(formatProbeTime(archive.createdAt)); }
              else { /* quota now from stats */ setQuotaTime(''); }
            })
            .catch(() => { /* quota now from stats */ setQuotaTime(''); });
        }
      })
      .catch(() => {
        setUsageJob(null);
        setActiveUsageJobId(null);
        /* quota now from stats */
        setQuotaTime('');
      });
  }, [buildScopeQuery]);

  const fetchAccounts = useCallback((pg: number, ps: number) => {
    setLoading(true);
    const p = new URLSearchParams();
    if (filter.planType) p.set('planType', filter.planType);
    if (filter.search) p.set('search', filter.search);
    if (filter.tag) p.set('tags', filter.tag);
    if (filter.batchId) p.set('batchId', filter.batchId);
    if (isRecycleBin) { p.set('onlyDeleted', 'true'); }
    else if (isAllTab) { if (filter.sourceType) p.set('sourceType', filter.sourceType); }
    else if (activeChannel) { p.set('tags', `sync:${activeChannel.name}`); }
    p.set('limit', String(ps));
    p.set('offset', String(pg * ps));

    // stats 使用和列表相同的筛选条件（排除分页）
    const sp = new URLSearchParams();
    if (filter.planType) sp.set('planType', filter.planType);
    if (filter.search) sp.set('search', filter.search);
    if (filter.tag) sp.set('tags', filter.tag);
    if (isRecycleBin) { sp.set('onlyDeleted', 'true'); }
    else if (isAllTab) { if (filter.sourceType) sp.set('sourceType', filter.sourceType); }
    else if (activeChannel) { sp.set('tags', `sync:${activeChannel.name}`); }

    Promise.all([
      getWithTotal<Account[]>(`/accounts?${p}`),
      get<Stats>(`/accounts/stats?${sp}`),
    ]).then(([{ data, total: nextTotal }, nextStats]) => {
      setAccounts(data);
      setTotal(nextTotal);
      setStats(nextStats);
      setProbeMap((current) => {
        const next = new Map(current);
        for (const account of data) {
          if (account.lastProbe) next.set(account.id, account.lastProbe);
          else next.delete(account.id);
        }
        return next;
      });
    }).finally(() => setLoading(false));
  }, [activeChannel, filter.planType, filter.search, filter.sourceType, filter.tag, filter.batchId, isAllTab, isRecycleBin]);

  // channels 未加载完时不请求数据（避免先请求"全部"再请求渠道 tab 的重复请求）
  const channelsReady = channels.length > 0 || isAllTab;
  useEffect(() => { if (page >= 0 && channelsReady) fetchAccounts(page, pageSize); }, [fetchAccounts, page, pageSize, channelsReady]);
  useEffect(() => { if (channelsReady) fetchLatestUsageState(); }, [fetchLatestUsageState, channelsReady]);

  const handleTransfer = useCallback(async () => {
    if (selected.size === 0 || !transferTargetId) return;
    // Detect source channel
    let sourceChannelId = '';
    if (!isAllTab && activeTab !== 'all') {
      sourceChannelId = activeTab;
    } else {
      const firstSelected = accounts.find(a => selected.has(a.id));
      if (firstSelected) {
        const syncTag = (firstSelected.tags ?? []).find(t => t.startsWith('sync:'));
        if (syncTag) {
          const channelName = syncTag.slice(5);
          const ch = channels.find(c => c.name === channelName);
          if (ch) sourceChannelId = ch.id;
        }
      }
    }
    if (!sourceChannelId) {
      notify({ tone: 'error', title: '无法确定源渠道', description: '请在渠道 Tab 下操作，或确保账号有 sync: 标签' });
      return;
    }

    setTransferring(true);
    setTransferResults([]);
    setTransferProgress(null);
    try {
      const res = await fetch('/api/accounts/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeader() },
        body: JSON.stringify({ accountIds: Array.from(selected), sourceChannelId, targetChannelId: transferTargetId }),
      });
      await readSSEStream(res, (ev) => {
        if (ev.type === 'transfer_start') {
          setTransferProgress({ total: ev.total as number, processed: 0, pushed: 0, skipped: 0, failed: 0 });
        }
        if (ev.type === 'item_result') {
          const item = { email: ev.email as string, status: ev.status as string, error: ev.error as string | undefined };
          setTransferResults(prev => [...prev, item]);
          setTransferProgress(prev => prev ? {
            ...prev,
            processed: (ev.processed as number) ?? prev.processed + 1,
            pushed: prev.pushed + (ev.status === 'pushed' ? 1 : 0),
            skipped: prev.skipped + (ev.status === 'skipped' ? 1 : 0),
            failed: prev.failed + (ev.status === 'push_failed' || ev.status === 'delete_failed' ? 1 : 0),
          } : null);
        }
        if (ev.type === 'transfer_complete') {
          setTransferProgress(prev => prev ? {
            ...prev,
            processed: ev.total as number,
            pushed: ev.pushed as number,
            skipped: ev.skipped as number,
            failed: ev.failed as number,
          } : null);
        }
        if (ev.type === 'error') {
          notify({ tone: 'error', title: '转移失败', description: ev.error as string });
        }
      });
    } catch (err) {
      notify({ tone: 'error', title: '转移失败', description: (err as Error).message });
    } finally {
      setTransferring(false);
      fetchAccounts(page, pageSize);
    }
  }, [selected, transferTargetId, activeTab, isAllTab, accounts, channels, notify, fetchAccounts, page, pageSize]);

  const handleSearch = () => {
    setFilter((c) => ({ ...c, search: searchDraft.trim() }));
    setPage(-1);
    resetUsageState(false);
  };

  const handleUsageEvent = useCallback((event: UsageJobEvent) => {
    if (!event.job || activeUsageJobIdRef.current !== event.job.id) return;
    setUsageJob(event.job);
    if (event.result) {
      setProbeMap((c) => { const n = new Map(c); n.set(event.result!.accountId, event.result!.probe); return n; });
    }
    if (event.job.mode === 'quota') { setQuotaTime(formatProbeTime(event.job.updatedAt)); }
    if (event.type === 'complete' || event.type === 'error') {
      setActiveUsageJobId(null);
      // 统计完成后刷新当前页账号列表和统计数据，同步最新 probe 状态
      setTimeout(() => fetchAccounts(page, pageSize), 300);
    }
  }, [fetchAccounts, page, pageSize]);

  useSSE<UsageJobEvent>(activeUsageJobId ? `/api/accounts/usage-jobs/${activeUsageJobId}/events` : null, handleUsageEvent);

  const startUsageJob = async () => {
    const job = await post<UsageJobSnapshot>('/accounts/usage-jobs', { mode: 'quota', query: buildScopeQuery() });
    setUsageJob(job);
    setQuotaTime(job.updatedAt ? formatProbeTime(job.updatedAt) : '');
    if (job.status === 'running') setActiveUsageJobId(job.id);
    else setActiveUsageJobId(null);
  };

  const handleRefreshQuota = async () => {
    if (!settings?.planQuotas || total === 0) return;
    await startUsageJob();
  };

  const handleSync = async () => {
    if (!activeChannel) return;
    setSyncing(true); setSyncResult('');
    try {
      const result = await post<{ added: number; updated: number; deleted: number; total: number }>(`/channels/${activeChannel.id}/sync`, {});
      setSyncResult(`同步完成: 远端 ${result.total} 个，新增 ${result.added}，更新 ${result.updated}，远端已删除 ${result.deleted}`);
      fetchAccounts(page, pageSize); loadTags();
    } catch (err) { setSyncResult(`同步失败: ${(err as Error).message}`); }
    finally { setSyncing(false); }
  };

  const handleFileSelect = (nextFiles: FileList | null) => {
    if (!nextFiles || nextFiles.length === 0) return;
    setImportFiles(nextFiles); setImportPlanType(''); setImportTags(''); setShowImportDialog(true);
  };

  const handleImportConfirm = async () => {
    if (!importFiles || importFiles.length === 0) return;
    setImporting(true); setImportResult('');
    try {
      const formData = new FormData();
      for (let i = 0; i < importFiles.length; i += 1) formData.append('files', importFiles[i]);
      if (importPlanType) formData.append('planType', importPlanType);
      if (importTags.trim()) formData.append('tags', importTags.trim());
      const result = await upload<{ added: number; updated: number; skipped: number }>('/accounts/import', formData);
      setImportResult(`导入完成: ${result.added} 新增, ${result.updated} 更新, ${result.skipped} 跳过`);
      setShowImportDialog(false);
      fetchAccounts(page, pageSize); loadTags();
    } catch (err) { setImportResult(`导入失败: ${(err as Error).message}`); }
    finally { setImporting(false); setImportFiles(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleDelete = async (id: string) => {
    const accepted = await confirm({ title: '删除账号', description: '仅删除本地记录，不会影响远端来源。', confirmText: '删除', tone: 'danger' });
    if (!accepted) return;
    await del(`/accounts/${id}`);
    fetchAccounts(page, pageSize);
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0) return;
    const accepted = await confirm({ title: '批量删除账号', description: `确认删除 ${selected.size} 个账号？仅删除本地，不影响远端。`, confirmText: '删除', tone: 'danger' });
    if (!accepted) return;
    await post('/accounts/batch-delete', { ids: Array.from(selected) });
    setSelected(new Set());
    notify({ tone: 'success', title: '删除完成', description: `已删除 ${selected.size} 个账号` });
    fetchAccounts(page, pageSize);
  };

  const handleBatchRestore = async () => {
    if (selected.size === 0) return;
    const accepted = await confirm({ title: '批量恢复', description: `确认恢复 ${selected.size} 个账号？`, confirmText: '恢复' });
    if (!accepted) return;
    await post('/accounts/batch-restore', { ids: Array.from(selected) });
    setSelected(new Set());
    notify({ tone: 'success', title: '恢复完成', description: `已恢复 ${selected.size} 个账号` });
    fetchAccounts(page, pageSize);
  };

  const handleBatchPermanentDelete = async () => {
    if (selected.size === 0) return;
    const accepted = await confirm({ title: '永久删除', description: `确认永久删除 ${selected.size} 个账号？此操作不可恢复。`, confirmText: '永久删除', tone: 'danger' });
    if (!accepted) return;
    await post('/accounts/batch-permanent-delete', { ids: Array.from(selected) });
    setSelected(new Set());
    notify({ tone: 'success', title: '永久删除完成', description: `已永久删除 ${selected.size} 个账号` });
    fetchAccounts(page, pageSize);
  };

  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const handleBatchRefresh = async () => {
    if (selected.size === 0) return;
    const accepted = await confirm({ title: '批量刷新 Token', description: `将刷新 ${selected.size} 个账号的 access_token（需要 refresh_token）。`, confirmText: '开始刷新' });
    if (!accepted) return;
    setBatchRefreshing(true);
    try {
      const result = await post<{ total: number; refreshed: number; results: Array<{ email: string; status: string; errorMessage: string }> }>('/accounts/batch-refresh', { ids: Array.from(selected) });
      const failed = result.total - result.refreshed;
      notify({
        tone: failed === 0 ? 'success' : 'error',
        title: '刷新完成',
        description: `成功 ${result.refreshed}，失败 ${failed}，共 ${result.total}`,
      });
      fetchAccounts(page, pageSize);
    } catch (err) {
      notify({ tone: 'error', title: '刷新失败', description: (err as Error).message });
    } finally {
      setBatchRefreshing(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const toggleAll = () => {
    if (selected.size === accounts.length) { setSelected(new Set()); return; }
    setSelected(new Set(accounts.map((a) => a.id)));
  };

  const isDeleted = (account: Account) => deletedTag && (account.tags ?? []).includes(deletedTag);
  const deletedCount = deletedTag ? accounts.filter(isDeleted).length : 0;
  const usageJobStatus = usageJob?.status ?? 'completed';
  const usageBusy = usageJobStatus === 'running';

  return (
    <div>
      {/* Tab strip */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        <button
          onClick={() => setActiveTab('all')}
          className={cn(
            'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
            isAllTab ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          全部
        </button>
        {enabledChannels.map((ch) => {
          const active = activeTab === ch.id;
          return (
            <button
              key={ch.id}
              onClick={() => setActiveTab(ch.id)}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5',
                active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {ch.name}
              <Badge variant="muted" className="text-[10px]">{ch.pusherType}</Badge>
            </button>
          );
        })}
        <div className="ml-auto">
          <button
            onClick={() => setActiveTab('recycle')}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              isRecycleBin ? 'border-destructive text-destructive' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            回收站
          </button>
        </div>
      </div>

      <QuotaPanel
        quota={stats?.quota ?? null} stats={stats} quotaTime={quotaTime} loading={quotaLoading}
        disabled={total === 0 || usageBusy} onRefreshQuota={handleRefreshQuota}
        deletedCount={deletedCount}
        onFilterPlanType={(pt) => setFilter((c) => ({ ...c, planType: pt }))}
        activePlanType={filter.planType}
      />

      <Card className="mb-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-2 flex-wrap flex-1">
            <TextField
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索 email..."
              style={{ width: 220 }}
            />
            <Button size="sm" onClick={handleSearch}>搜索</Button>
            <SelectField
              value={filter.tag}
              onChange={(v) => setFilter((c) => ({ ...c, tag: v }))}
              options={[{ value: '', label: '全部标签' }, ...allTags.map((t) => ({ value: t, label: t }))]}
              style={{ width: 150 }}
            />
            <SelectField
              value={filter.batchId}
              onChange={(v) => setFilter((c) => ({ ...c, batchId: v }))}
              options={[
                { value: '', label: '全部批次' },
                ...batches.map((b) => ({
                  value: b.id,
                  label: `${b.source.slice(0, 20)} (${b.totalCount}) ${new Date(b.createdAt).toLocaleDateString()}`,
                })),
              ]}
              style={{ width: 200 }}
            />
            {isAllTab && (
              <SelectField
                value={filter.sourceType}
                onChange={(v) => setFilter((c) => ({ ...c, sourceType: v as '' | 'local' | 'remote' }))}
                options={[
                  { value: '', label: '全部来源' },
                  { value: 'local', label: '仅本地' },
                  { value: 'remote', label: '仅远端' },
                ]}
                style={{ width: 150 }}
              />
            )}
            {(filter.tag || filter.sourceType) && (
              <Button size="sm" onClick={() => setFilter((c) => ({ ...c, tag: '', sourceType: '' }))}>清除筛选</Button>
            )}
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            {!isAllTab && activeChannel?.capabilities?.syncable && (
              <Button size="sm" variant="primary" onClick={handleSync} loading={syncing} disabled={usageBusy}>
                {syncing ? '同步中...' : '从远端同步'}
              </Button>
            )}
            <Button size="sm" variant="destructive" disabled={selected.size === 0} onClick={handleBatchDelete}>删除选中{selected.size > 0 ? ` (${selected.size})` : ''}</Button>
            <Button size="sm" variant="primary" disabled={selected.size === 0 || batchProbing} loading={batchProbing} onClick={handleBatchProbe}>批量检测额度{selected.size > 0 ? ` (${selected.size})` : ''}</Button>
            <Button size="sm" disabled={selected.size === 0 || batchTesting} loading={batchTesting} onClick={handleBatchTest}>批量测试调用{selected.size > 0 ? ` (${selected.size})` : ''}</Button>
            <Button size="sm" variant="primary" disabled={selected.size === 0} onClick={() => { setShowTransferDialog(true); setTransferTargetId(''); setTransferResults([]); setTransferProgress(null); }}>转移{selected.size > 0 ? ` (${selected.size})` : ''}</Button>
            <Button size="sm" onClick={() => {
              const params = new URLSearchParams();
              if (filter.planType) params.set('planType', filter.planType);
              if (filter.search) params.set('search', filter.search);
              if (filter.tag) params.set('tags', filter.tag);
              if (isAllTab && filter.sourceType) params.set('sourceType', filter.sourceType);
              if (!isAllTab && activeChannel) params.set('source', `sync:${activeChannel.name}`);
              window.open(`/api/accounts/export?${params}`, '_blank');
            }}>导出</Button>
            {isAllTab && (
              <FileTrigger ref={fileRef} multiple accept=".json,.csv" onFiles={handleFileSelect}>
                {importing ? '导入中...' : '导入数据'}
              </FileTrigger>
            )}
          </div>
        </div>
      </Card>

      <Dialog open={!!testDialog} onOpenChange={(open) => { if (!open) closeTestDialog(); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>测试调用</DialogTitle>
            <DialogDescription>
              {testDialog ? `账号: ${testDialog.email}` : '选择模型后发起一次真实调用测试。'}
            </DialogDescription>
          </DialogHeader>

          {testDialog && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">测试模型</label>
                <SelectField
                  value={testDialog.model}
                  onChange={(value) => setTestDialog((current) => current ? { ...current, model: value } : current)}
                  options={buildOpenAiModelOptions(testDialog.model)}
                  disabled={testingId !== null}
                />
                <p className="text-xs text-muted-foreground mt-1">默认值来自系统设置，这里可以临时覆盖，仅本次测试生效。</p>
              </div>

              <div className="rounded-xl border border-border bg-slate-950 p-4 font-mono text-sm text-slate-100">
                {testStatus === 'idle' && testOutput.length === 0 && (
                  <div className="text-slate-400">准备就绪，点击“开始测试”发起请求。</div>
                )}
                {testOutput.map((line, index) => (
                  <div key={`${index}-${line}`} className={line ? 'whitespace-pre-wrap' : 'h-3'}>{line || ' '}</div>
                ))}
                {testStreamingContent && (
                  <div className="whitespace-pre-wrap text-emerald-300">
                    {testStreamingContent}
                    {testingId && <span className="animate-pulse">_</span>}
                  </div>
                )}
                {testErrorMessage && (
                  <div className="mt-3 border-t border-slate-800 pt-3 text-rose-300">{testErrorMessage}</div>
                )}
                {testStatus === 'success' && (
                  <div className="mt-3 border-t border-slate-800 pt-3 text-emerald-300">测试完成</div>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={closeTestDialog} disabled={testingId !== null}>关闭</Button>
            <Button
              variant="primary"
              onClick={handleTestAccount}
              disabled={!testDialog || testingId !== null}
              loading={testingId !== null}
            >
              {testStatus === 'success' || testStatus === 'error' ? '重新测试' : '开始测试'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量测试结果面板 */}
      {(batchTesting || batchTestProgress) && (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">批量测试</h4>
            {!batchTesting && <Button size="sm" onClick={() => { setBatchTestProgress(null); setBatchTestResults([]); }}>关闭</Button>}
          </div>
          {batchTestModel && <p className="text-xs text-muted-foreground mb-3">默认测试模型: {batchTestModel}</p>}
          {batchTestProgress && (
            <>
              <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${batchTestProgress.total === 0 ? 0 : (batchTestProgress.processed / batchTestProgress.total) * 100}%` }}
                />
              </div>
              <div className="flex gap-2 mb-3 text-sm">
                <span>进度: {batchTestProgress.processed}/{batchTestProgress.total}</span>
                <Badge variant="success">成功 {batchTestProgress.success}</Badge>
                <Badge variant="destructive">失败 {batchTestProgress.failed}</Badge>
              </div>
            </>
          )}
          {batchTestResults.length > 0 && (
            <div className="max-h-[250px] overflow-auto bg-background rounded-lg p-3 text-xs font-mono border border-border">
              {batchTestResults.map((r, i) => (
                <div key={i} className="mb-1">
                  <span className={r.success ? 'text-success' : 'text-destructive'}>{r.success ? '[OK]' : '[FAIL]'}</span>
                  {' '}{r.email}
                  {r.error && <span className="text-warning"> - {r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {usageJob && (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between mb-3 gap-3">
            <div>
              <div className="text-sm font-bold">用量与额度更新任务</div>
              <div className="text-muted-foreground text-xs">{usageJob.processed} / {usageJob.total}，最近更新 {formatProbeTime(usageJob.updatedAt)}</div>
            </div>
            <Badge variant={usageJob.status === 'completed' ? 'success' : usageJob.status === 'failed' ? 'destructive' : 'info'}>
              {usageJob.status === 'running' ? '进行中' : usageJob.status === 'failed' ? '失败' : '完成'}
            </Badge>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
            <div
              className={cn('h-full transition-[width] duration-200', usageJob.status === 'failed' ? 'bg-destructive' : 'bg-primary')}
              style={{ width: `${usageJob.total === 0 ? 0 : (usageJob.processed / usageJob.total) * 100}%` }}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Badge variant="success">正常 {usageJob.successCount}</Badge>
            <Badge variant="warning">限流 {usageJob.rateLimitedCount}</Badge>
            <Badge variant="destructive">失效 {usageJob.tokenInvalidCount}</Badge>
            <Badge variant="muted">错误 {usageJob.errorCount}</Badge>
          </div>
        </Card>
      )}

      {syncResult && (
        <div className={cn('mb-3 p-3 rounded-md text-sm border', syncResult.includes('失败') ? 'bg-destructive/10 text-destructive border-destructive/30' : 'bg-success/10 text-success border-success/30')}>
          {syncResult}
        </div>
      )}
      {importResult && (
        <div className={cn('mb-3 p-3 rounded-md text-sm border', importResult.includes('失败') ? 'bg-destructive/10 text-destructive border-destructive/30' : 'bg-success/10 text-success border-success/30')}>
          {importResult}
        </div>
      )}

      {showImportDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <Card className="w-[460px] max-w-full p-6">
            <h3 className="text-base font-semibold mb-4">导入设置</h3>
            <p className="text-xs text-muted-foreground mb-3">已选择 {importFiles?.length ?? 0} 个文件</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">Plan Type</label>
                <SelectField value={importPlanType} onChange={setImportPlanType} options={[{ value: '', label: '自动检测' }, ...PLAN_OPTIONS.filter((i) => i.value)]} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">标签</label>
                <TextField value={importTags} onChange={(e) => setImportTags(e.target.value)} placeholder="逗号分隔" />
                {allTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {allTags.slice(0, 10).map((tag) => (
                      <Badge
                        key={tag} variant="muted" className="cursor-pointer"
                        onClick={() => {
                          const current = importTags.split(',').map((i) => i.trim()).filter(Boolean);
                          if (!current.includes(tag)) setImportTags([...current, tag].join(', '));
                        }}
                      >{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <Button variant="primary" onClick={handleImportConfirm} loading={importing}>{importing ? '导入中...' : '确认导入'}</Button>
              <Button onClick={() => { setShowImportDialog(false); setImportFiles(null); if (fileRef.current) fileRef.current.value = ''; }}>取消</Button>
            </div>
          </Card>
        </div>
      )}

      {/* 转移对话框 */}
      {showTransferDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <Card className="w-[460px] max-w-full p-6">
            <h3 className="text-base font-semibold mb-4">转移账号</h3>
            <p className="text-xs text-muted-foreground mb-3">已选择 {selected.size} 个账号</p>
            {!isAllTab && activeChannel && (
              <p className="text-xs text-muted-foreground mb-3">源渠道: {activeChannel.name}</p>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">目标渠道</label>
                <SelectField
                  value={transferTargetId}
                  onChange={setTransferTargetId}
                  options={[
                    { value: '', label: '请选择目标渠道' },
                    ...enabledChannels
                      .filter(ch => ch.id !== (isAllTab ? '' : activeTab))
                      .map(ch => ({ value: ch.id, label: `${ch.name} (${ch.pusherType})` })),
                  ]}
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <Button
                variant="primary"
                onClick={() => { setShowTransferDialog(false); handleTransfer(); }}
                disabled={!transferTargetId}
              >开始转移</Button>
              <Button onClick={() => setShowTransferDialog(false)}>取消</Button>
            </div>
          </Card>
        </div>
      )}

      {/* 转移结果面板 */}
      {(transferring || transferProgress) && (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">账号转移</h4>
            {!transferring && <Button size="sm" onClick={() => { setTransferProgress(null); setTransferResults([]); }}>关闭</Button>}
          </div>
          {transferProgress && (
            <>
              <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${transferProgress.total === 0 ? 0 : (transferProgress.processed / transferProgress.total) * 100}%` }}
                />
              </div>
              <div className="flex gap-2 mb-3 text-sm flex-wrap">
                <span>进度: {transferProgress.processed}/{transferProgress.total}</span>
                <Badge variant="success">推送成功 {transferProgress.pushed}</Badge>
                <Badge variant="warning">跳过 {transferProgress.skipped}</Badge>
                <Badge variant="destructive">失败 {transferProgress.failed}</Badge>
              </div>
            </>
          )}
          {transferResults.length > 0 && (
            <div className="max-h-[250px] overflow-auto bg-background rounded-lg p-3 text-xs font-mono border border-border">
              {transferResults.map((r, i) => (
                <div key={i} className="mb-1">
                  <span className={r.status === 'pushed' ? 'text-success' : r.status === 'skipped' ? 'text-warning' : 'text-destructive'}>
                    [{r.status === 'pushed' ? 'OK' : r.status === 'skipped' ? 'SKIP' : 'FAIL'}]
                  </span>
                  {' '}{r.email}
                  {r.error && <span className="text-muted-foreground"> - {r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {loading ? (
        <p className="text-muted-foreground">加载中...</p>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-11">
                  <Checkbox checked={selected.size === accounts.length && accounts.length > 0} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>标签</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>5h / 7d 用量</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead>来源</TableHead>
                <TableHead className="w-[180px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    {!isAllTab && activeChannel?.capabilities?.syncable ? '暂无账号，点击上方「从远端同步」拉取数据' : '暂无账号'}
                  </TableCell>
                </TableRow>
              ) : accounts.map((account) => {
                const expired = account.expiredAt && account.expiredAt < new Date().toISOString();
                const chMap = groupByChannel(account.pushHistory);
                const probe = probeMap.get(account.id) ?? account.lastProbe;
                const dead = isDeleted(account);
                const probeBadge = getProbeBadge(probe);

                return (
                  <React.Fragment key={account.id}>
                  <TableRow className={dead ? 'opacity-55' : ''}>
                    <TableCell>
                      <Checkbox checked={selected.has(account.id)} onCheckedChange={() => toggleSelect(account.id)} />
                    </TableCell>
                    <TableCell className="max-w-[220px] overflow-hidden text-ellipsis">
                      {account.email}
                      {dead && <Badge variant="warning" className="ml-1.5 text-[10px]">远端已删除</Badge>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.planType === 'plus' ? 'info' : account.planType === 'pro' ? 'success' : account.planType === 'team' ? 'warning' : 'muted'}>
                        {account.planType || 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {(account.tags ?? [])
                          .filter((t) => !t.startsWith('sync:') && !t.startsWith('deleted:'))
                          .map((t) => <Badge key={t} variant="muted" className="text-[11px]">{t}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={probeBadge.variant}>
                          {probeBadge.label}
                          {probe?.errorMessage ? <span title={probe.errorMessage}> !</span> : null}
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {probe?.probedAt ? `更新于 ${formatProbeTime(probe.probedAt)}` : usageBusy ? '任务处理中' : '-'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {probe?.usage ? (
                        <UsageCell
                          fiveHour={{ used: probe.usage.fiveHourUsed, resetAt: probe.usage.fiveHourResetAt }}
                          sevenDay={{ used: probe.usage.sevenDayUsed, resetAt: probe.usage.sevenDayResetAt }}
                        />
                      ) : usageBusy ? (
                        <UsageCell fiveHour={null} sevenDay={null} loading />
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className={expired ? 'text-destructive' : ''}>
                        {account.expiredAt ? new Date(account.expiredAt).toLocaleDateString() : '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1 flex-wrap">
                          <Badge variant={account.sourceType === 'remote' ? 'info' : 'muted'}>
                            {account.sourceType === 'remote' ? '远端' : '本地'}
                          </Badge>
                          <span className="text-muted-foreground text-xs">{formatSourceLabel(account)}</span>
                        </div>
                        {isAllTab && account.pushHistory.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {Object.entries(chMap).map(([name, entry]) => (
                              <Badge
                                key={name}
                                variant={entry.status === 'success' ? 'success' : 'destructive'}
                                title={`${name}: ${new Date(entry.at).toLocaleString()}`}
                                className="text-[11px]"
                              >{name}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => handleProbeAccount(account)}
                          loading={probingIds.has(account.id)}
                          disabled={probingIds.has(account.id)}
                        >检测额度</Button>
                        <Button size="sm" onClick={() => openTestDialog(account.id, account.email)} disabled={testingId !== null && testingId !== account.id}>测试调用</Button>
                        <Button size="sm" variant="ghost" onClick={() => setExpandedRow((c) => c === account.id ? null : account.id)}>
                          {expandedRow === account.id ? '收起' : '事件'}
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(account.id)}>删</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedRow === account.id && (
                    <TableRow>
                      <TableCell colSpan={20} className="bg-muted/30 p-4">
                        <EventTimeline accountId={account.id} />
                      </TableCell>
                    </TableRow>
                  )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </Card>
      )}

      {/* 批量操作工具栏 */}
      <BatchActionBar
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        onBatchDelete={isRecycleBin ? handleBatchPermanentDelete : handleBatchDelete}
        onBatchRefresh={isRecycleBin ? undefined : handleBatchRefresh}
        batchRefreshing={batchRefreshing}
        onBatchRestore={isRecycleBin ? handleBatchRestore : undefined}
      />
    </div>
  );
}
