import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
import { ImportCard } from '../components/ImportCard';
import { UsageCell } from '../components/UsageBar';
import Pagination from '../components/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TextField } from '@/components/TextField';
import { SelectField } from '@/components/SelectField';
import { ExportDialog, type ExportOptions } from '@/components/ExportDialog';
import { useFileImport } from '@/hooks/useFileImport';
import { useExport, type ExportRow } from '@/hooks/useExport';
import { extractProbeTarget, resolvePlanTypeOverride, pickMappedValue } from '@/utils/data-helpers';
import type { UsageSnapshot } from '../../../shared/types/account';
import type { DetectThresholds } from '../../../shared/types/settings';

/* ── 检测独有类型 ── */

interface AccountUsageResult {
  email: string;
  status: 'ok' | 'error' | 'token_invalid' | 'rate_limited';
  usage: UsageSnapshot | null;
  errorMessage: string;
}

interface BatchUsageResult {
  total: number;
  probed: number;
  results: AccountUsageResult[];
}

type ProbeStatusFilter = '' | 'unchecked' | 'unused' | 'used' | 'rate_limited' | 'token_invalid' | 'error';
type UsageCategory = 'unused' | 'used' | 'rate_limited' | 'token_invalid' | 'error' | 'unchecked';

const DEFAULT_DETECT_THRESHOLDS: DetectThresholds = {
  unusedFiveHourMaxPercent: 2,
  unusedSevenDayMaxPercent: 1,
};

function categorizeResult(
  result: AccountUsageResult | undefined,
  thresholds: DetectThresholds,
): UsageCategory {
  if (!result) return 'unchecked';
  if (result.status === 'token_invalid') return 'token_invalid';
  if (result.status === 'error') return 'error';
  const usage = result.usage;
  if (result.status === 'rate_limited') return 'rate_limited';
  if (usage && (usage.fiveHourUsed >= 100 || usage.sevenDayUsed >= 100)) return 'rate_limited';
  if (
    usage
    && usage.fiveHourUsed <= thresholds.unusedFiveHourMaxPercent
    && usage.sevenDayUsed < thresholds.unusedSevenDayMaxPercent
  ) {
    return 'unused';
  }
  return 'used';
}

interface DerivedRow {
  index: number;
  fields: Record<string, unknown>;
  email: string;
  accountId: string;
  planType: string;
  accessToken: string;
  result: AccountUsageResult | undefined;
  category: UsageCategory;
}

const CATEGORY_META: Record<UsageCategory, { label: string; filename: string }> = {
  unused: { label: '未使用', filename: 'unused' },
  used: { label: '已使用', filename: 'used' },
  rate_limited: { label: '限流', filename: 'rate-limited' },
  token_invalid: { label: 'Token失效', filename: 'token-invalid' },
  error: { label: '探测错误', filename: 'error' },
  unchecked: { label: '未检测', filename: 'unchecked' },
};

const DETECT_CONCURRENCY = 3;

function getStatusBadge(result: AccountUsageResult | undefined, thresholds: DetectThresholds) {
  const category = categorizeResult(result, thresholds);
  if (category === 'unchecked') return { variant: 'muted' as const, label: '未检测' };
  if (category === 'rate_limited') return { variant: 'warning' as const, label: '限流' };
  if (category === 'token_invalid') return { variant: 'destructive' as const, label: 'Token失效' };
  if (category === 'error') return { variant: 'destructive' as const, label: '错误' };
  if (category === 'unused') return { variant: 'success' as const, label: '未使用' };
  return { variant: 'info' as const, label: '已使用' };
}

export default function DetectPage() {
  const { notify } = useFeedback();
  const fileImport = useFileImport();
  const { exporting, setExporting, sendExport } = useExport();

  /* ── plan type 覆盖 ── */
  const [importPlanTypePreset, setImportPlanTypePreset] = useState('');
  const [importPlanTypeCustom, setImportPlanTypeCustom] = useState('');
  const planTypeOverride = resolvePlanTypeOverride(importPlanTypePreset, importPlanTypeCustom);

  /* ── 检测独有状态 ── */
  const [thresholds, setThresholds] = useState<DetectThresholds>(DEFAULT_DETECT_THRESHOLDS);
  const [probeResults, setProbeResults] = useState<Map<number, AccountUsageResult>>(new Map());
  const [probing, setProbing] = useState(false);
  const [activeProbeIndices, setActiveProbeIndices] = useState<Set<number>>(new Set());
  const [processedCount, setProcessedCount] = useState(0);

  /* ── 表格状态 ── */
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<ProbeStatusFilter>('');
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [fiveHourMin, setFiveHourMin] = useState('');
  const [fiveHourMax, setFiveHourMax] = useState('');
  const [sevenDayMin, setSevenDayMin] = useState('');
  const [sevenDayMax, setSevenDayMax] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  const [pendingExport, setPendingExport] = useState<{
    rows: DerivedRow[];
    title: string;
    slug: string;
  } | null>(null);

  useEffect(() => {
    get<{ detectThresholds?: DetectThresholds }>('/settings').then((settings) => {
      if (settings.detectThresholds) setThresholds(settings.detectThresholds);
    }).catch(() => { /* 用默认值即可 */ });
  }, []);

  /* ── 文件导入回调 ── */
  async function handleFileUpload(files: FileList | null, mode: 'replace' | 'append') {
    if (mode === 'replace') {
      setProbeResults(new Map());
      setSelectedRows(new Set());
      setProcessedCount(0);
      setActiveProbeIndices(new Set());
      setPage(0);
    }

    const result = await fileImport.handleFileUpload(files, mode);
    if (!result) return;

    if (result.action === 'replace') {
      setSelectedRows(new Set(fileImport.records.map((r) => r.index)));
    } else if (result.action === 'append') {
      setSelectedRows((current) => {
        const next = new Set(current);
        for (const rec of fileImport.records) next.add(rec.index);
        return next;
      });
      notify({
        tone: 'success',
        title: '追加完成',
        description: `新增 ${result.added} 条${result.duplicated && result.duplicated > 0 ? `，跳过重复 ${result.duplicated} 条` : ''}`,
      });
    }
  }

  // replace 后全选（records 异步更新）
  useEffect(() => {
    if (fileImport.records.length > 0 && selectedRows.size === 0) {
      setSelectedRows(new Set(fileImport.records.map((r) => r.index)));
    }
  }, [fileImport.records]);

  /* ── 派生行数据 ── */
  const derivedRows: DerivedRow[] = fileImport.records.map((record) => {
    const target = extractProbeTarget(record.fields, fileImport.fieldMapping, planTypeOverride);
    const result = probeResults.get(record.index);
    return {
      index: record.index,
      fields: record.fields,
      email: target.email,
      accountId: target.accountId ?? '',
      planType: target.planType ?? '',
      accessToken: target.accessToken,
      result,
      category: categorizeResult(result, thresholds),
    };
  });

  const categoryCounts = derivedRows.reduce<Record<UsageCategory, number>>((acc, row) => {
    acc[row.category] = (acc[row.category] ?? 0) + 1;
    return acc;
  }, { unused: 0, used: 0, rate_limited: 0, token_invalid: 0, error: 0, unchecked: 0 });

  const usageRange = {
    fiveHourMin: fiveHourMin.trim() === '' ? null : Number(fiveHourMin),
    fiveHourMax: fiveHourMax.trim() === '' ? null : Number(fiveHourMax),
    sevenDayMin: sevenDayMin.trim() === '' ? null : Number(sevenDayMin),
    sevenDayMax: sevenDayMax.trim() === '' ? null : Number(sevenDayMax),
  };
  const usageRangeActive = Object.values(usageRange).some((v) => v !== null && !Number.isNaN(v));

  const visibleRows = derivedRows.filter((row) => {
    if (statusFilter && row.category !== statusFilter) return false;
    if (planFilter && row.planType !== planFilter) return false;
    if (usageRangeActive) {
      const usage = row.result?.usage;
      if (!usage) return false;
      if (usageRange.fiveHourMin !== null && !Number.isNaN(usageRange.fiveHourMin) && usage.fiveHourUsed < usageRange.fiveHourMin) return false;
      if (usageRange.fiveHourMax !== null && !Number.isNaN(usageRange.fiveHourMax) && usage.fiveHourUsed > usageRange.fiveHourMax) return false;
      if (usageRange.sevenDayMin !== null && !Number.isNaN(usageRange.sevenDayMin) && usage.sevenDayUsed < usageRange.sevenDayMin) return false;
      if (usageRange.sevenDayMax !== null && !Number.isNaN(usageRange.sevenDayMax) && usage.sevenDayUsed > usageRange.sevenDayMax) return false;
    }
    if (search) {
      const keyword = search.trim().toLowerCase();
      const text = `${row.email} ${row.accountId} ${row.planType}`.toLowerCase();
      if (!text.includes(keyword)) return false;
    }
    return true;
  });

  const pagedRows = visibleRows.slice(page * pageSize, (page + 1) * pageSize);
  const planOptions = Array.from(new Set(derivedRows.map((row) => row.planType).filter(Boolean))).sort();
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selectedRows.has(row.index));
  const progressValue = fileImport.parsedData?.totalRecords ? Math.round((processedCount / fileImport.parsedData.totalRecords) * 100) : 0;

  useEffect(() => {
    setPage(0);
  }, [statusFilter, planFilter, search, fiveHourMin, fiveHourMax, sevenDayMin, sevenDayMax]);

  /* ── 导入到号池 ── */
  const [importingToPool, setImportingToPool] = useState(false);
  async function handleImportToPool() {
    if (!fileImport.parsedData || fileImport.records.length === 0) return;
    setImportingToPool(true);
    try {
      const result = await post<{ added: number; updated: number; skipped: number }>('/data/import-to-pool', {
        fileId: fileImport.parsedData.fileId,
        fieldMapping: fileImport.fieldMapping,
        planTypeOverride: planTypeOverride || undefined,
      });
      notify({
        tone: 'success',
        title: '导入完成',
        description: `新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`,
      });
    } catch (err) {
      notify({ tone: 'error', title: '导入失败', description: (err as Error).message });
    } finally {
      setImportingToPool(false);
    }
  }

  /* ── 刷新 Token 逻辑 ── */
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSummary, setRefreshSummary] = useState<{ ok: number; invalid: number; error: number; skipped: number } | null>(null);

  async function handleRefreshAll() {
    if (!fileImport.parsedData || fileImport.records.length === 0) return;

    setRefreshing(true);

    setRefreshSummary(null);

    try {
      const items: Array<{ index: number; refreshToken: string }> = [];
      for (const record of fileImport.records) {
        const rt = pickMappedValue(record.fields, fileImport.fieldMapping, 'refresh_token', ['refresh_token', 'refreshToken', 'rt']);
        if (rt) items.push({ index: record.index, refreshToken: rt });
      }

      if (items.length === 0) {
        notify({ tone: 'error', title: '无法刷新', description: '未找到包含 refresh_token 的记录' });
        return;
      }

      const result = await post<{
        total: number;
        refreshed: number;
        results: Array<{ index?: number; email: string; status: string; errorMessage: string }>;
      }>('/data/refresh-tokens', { fileId: fileImport.parsedData.fileId, items });

      const summary = { ok: 0, invalid: 0, error: 0, skipped: fileImport.records.length - items.length };
      for (const r of result.results) {
        if (r.status === 'ok') summary.ok++;
        else if (r.status === 'invalid_grant') summary.invalid++;
        else summary.error++;
      }
      setRefreshSummary(summary);


      notify({
        tone: summary.error === 0 && summary.invalid === 0 ? 'success' : 'error',
        title: '刷新完成',
        description: `成功 ${summary.ok}，失效 ${summary.invalid}，错误 ${summary.error}${summary.skipped > 0 ? `，跳过(无RT) ${summary.skipped}` : ''}`,
      });
    } catch (err) {
      notify({ tone: 'error', title: '刷新失败', description: (err as Error).message });
    } finally {
      setRefreshing(false);
    }
  }

  /* ── 检测逻辑 ── */
  async function handleDetectAll() {
    if (!fileImport.parsedData || fileImport.records.length === 0) return;

    setProbing(true);
    setProbeResults(new Map());
    setProcessedCount(0);
    setActiveProbeIndices(new Set());

    const summary = { ok: 0, rateLimited: 0, tokenInvalid: 0, error: 0, skipped: 0 };

    try {
      let cursor = 0;
      const records = fileImport.records;
      const takeNextRecord = () => {
        if (cursor >= records.length) return null;
        const record = records[cursor];
        cursor += 1;
        return record;
      };

      const markActive = (index: number, active: boolean) => {
        setActiveProbeIndices((current) => {
          const next = new Set(current);
          if (active) next.add(index);
          else next.delete(index);
          return next;
        });
      };

      const workerCount = Math.min(DETECT_CONCURRENCY, records.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const record = takeNextRecord();
          if (!record) break;

          const target = extractProbeTarget(record.fields, fileImport.fieldMapping, planTypeOverride);

          if (!target.email || !target.accessToken) {
            summary.skipped += 1;
            setProcessedCount((current) => current + 1);
            continue;
          }

          markActive(record.index, true);

          try {
            const result = await post<BatchUsageResult>('/accounts/probe', { tokens: [target] });
            const item = result.results[0];
            if (item) {
              setProbeResults((current) => {
                const next = new Map(current);
                next.set(record.index, item);
                return next;
              });

              if (item.status === 'ok') summary.ok += 1;
              else if (item.status === 'rate_limited') summary.rateLimited += 1;
              else if (item.status === 'token_invalid') summary.tokenInvalid += 1;
              else summary.error += 1;
            } else {
              summary.error += 1;
              setProbeResults((current) => {
                const next = new Map(current);
                next.set(record.index, {
                  email: target.email,
                  status: 'error',
                  usage: null,
                  errorMessage: '未返回检测结果',
                });
                return next;
              });
            }
          } catch (err) {
            summary.error += 1;
            setProbeResults((current) => {
              const next = new Map(current);
              next.set(record.index, {
                email: target.email,
                status: 'error',
                usage: null,
                errorMessage: err instanceof Error ? err.message : '检测失败',
              });
              return next;
            });
          } finally {
            markActive(record.index, false);
            setProcessedCount((current) => current + 1);
          }
        }
      });

      await Promise.all(workers);

      const processed = summary.ok + summary.rateLimited + summary.tokenInvalid + summary.error;
      if (processed === 0) {
        notify({ tone: 'error', title: '无法检测', description: '未找到可用于检测的 email / access_token 数据' });
        return;
      }

      notify({
        tone: summary.error === 0 && summary.tokenInvalid === 0 ? 'success' : 'error',
        title: '检测完成',
        description: `共 ${processed} 条，正常 ${summary.ok}，限流 ${summary.rateLimited}，失效 ${summary.tokenInvalid}，错误 ${summary.error}${summary.skipped > 0 ? `，跳过 ${summary.skipped}` : ''}`,
      });
    } finally {
      setProbing(false);
      setActiveProbeIndices(new Set());
    }
  }

  /* ── 导出 ── */
  function openExportDialogForSelected() {
    if (!fileImport.parsedData) return;
    if (selectedRows.size === 0) {
      notify({ tone: 'error', title: '无法导出', description: '请先勾选要导出的数据' });
      return;
    }
    setPendingExport({
      rows: derivedRows.filter((row) => selectedRows.has(row.index)),
      title: `导出勾选的 ${selectedRows.size} 条记录`,
      slug: 'detected-records',
    });
  }

  function openExportDialogForCategory(category: UsageCategory) {
    if (!fileImport.parsedData) return;
    const rows = derivedRows.filter((row) => row.category === category);
    const meta = CATEGORY_META[category];
    if (rows.length === 0) {
      notify({ tone: 'error', title: '无法导出', description: `当前没有${meta.label}的账号` });
      return;
    }
    setPendingExport({
      rows,
      title: `导出「${meta.label}」账号（${rows.length} 条）`,
      slug: `detected-${meta.filename}`,
    });
  }

  async function handleExportConfirm(options: ExportOptions) {
    if (!pendingExport || !fileImport.parsedData) return;
    setExporting(true);
    try {
      const result = await sendExport(
        fileImport.parsedData.fileId,
        pendingExport.rows as ExportRow[],
        fileImport.fieldMapping,
        options,
        pendingExport.slug,
      );
      notify({
        tone: 'success',
        title: '导出完成',
        description: result.mode === 'merged'
          ? `已合并导出 ${result.count} 条记录为单个 JSON`
          : `已导出 ${result.count} 个 JSON 文件`,
      });
    } catch (err) {
      notify({ tone: 'error', title: '导出失败', description: (err as Error).message });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="text-lg font-semibold mb-2">独立检测</h2>
        <p className="text-sm text-muted-foreground">
          直接导入本地数据，逐条检测 5h / 7d 用量，筛选后勾选导出为 zip，压缩包内每条记录会生成一个独立 JSON 文件。
        </p>
      </Card>

      <ImportCard
        profiles={fileImport.profiles}
        selectedProfileId={fileImport.selectedProfileId}
        onProfileSelect={fileImport.handleProfileSelect}
        parsedData={fileImport.parsedData}
        uploading={fileImport.uploading}
        loadingRecords={fileImport.loadingRecords}
        uploadError={fileImport.uploadError}
        recordCount={fileImport.records.length}
        fieldMapping={fileImport.fieldMapping}
        onFieldMappingChange={fileImport.setFieldMapping}
        onFileUpload={handleFileUpload}
        disabled={probing}
        importPlanTypePreset={importPlanTypePreset}
        importPlanTypeCustom={importPlanTypeCustom}
        onPlanTypePresetChange={setImportPlanTypePreset}
        onPlanTypeCustomChange={setImportPlanTypeCustom}
        planTypeOverride={planTypeOverride}
      />

      {fileImport.parsedData && (
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-base font-semibold">操作</h3>
              <p className="text-xs text-muted-foreground mt-1">
                刷新 Token 和检测额度是独立操作，可先刷新再检测
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { void handleRefreshAll(); }} loading={refreshing} disabled={probing || fileImport.loadingRecords || fileImport.records.length === 0}>
                {refreshing ? '刷新中...' : '刷新 Token'}
              </Button>
              <Button size="sm" variant="primary" onClick={() => { void handleDetectAll(); }} loading={probing} disabled={refreshing || fileImport.loadingRecords || fileImport.records.length === 0}>
                {probing ? '检测中...' : '检测额度'}
              </Button>
            </div>
          </div>

          {refreshSummary && (
            <div className="mb-3 p-3 rounded-lg bg-muted text-sm">
              刷新结果：成功 <span className="text-success font-semibold">{refreshSummary.ok}</span>
              {refreshSummary.invalid > 0 && <>，RT 失效 <span className="text-destructive font-semibold">{refreshSummary.invalid}</span></>}
              {refreshSummary.error > 0 && <>，错误 <span className="text-destructive font-semibold">{refreshSummary.error}</span></>}
              {refreshSummary.skipped > 0 && <>，跳过 <span className="text-muted-foreground">{refreshSummary.skipped}</span></>}
            </div>
          )}

          {(probing || processedCount > 0) && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{probing ? '逐条检测中...' : '检测完成'}</span>
                <span>{processedCount} / {fileImport.parsedData.totalRecords}</span>
              </div>
              <Progress value={progressValue} />
            </div>
          )}
        </Card>
      )}

      {fileImport.parsedData && processedCount > 0 && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-semibold">按分类一键导出</h3>
              <p className="text-xs text-muted-foreground mt-1">
                未使用 = 5h 用量 ≤ {thresholds.unusedFiveHourMaxPercent}% 且 7d 用量 &lt; {thresholds.unusedSevenDayMaxPercent}%；限流 = 5h 或 7d = 100%（可在「设置」页修改阈值）
              </p>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            {(['unused', 'used', 'rate_limited', 'token_invalid', 'error'] as UsageCategory[]).map((category) => {
              const meta = CATEGORY_META[category];
              const count = categoryCounts[category] ?? 0;
              const primary = category === 'unused';
              return (
                <div key={category} className="rounded-lg border border-border p-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs text-muted-foreground">{meta.label}</div>
                    <div className="text-lg font-semibold">{count}</div>
                  </div>
                  <Button
                    size="sm"
                    variant={primary ? 'primary' : 'default'}
                    disabled={count === 0 || exporting}
                    onClick={() => { openExportDialogForCategory(category); }}
                  >
                    导出
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {fileImport.parsedData && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <TextField
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索 email / accountId / plan"
              className="w-[240px]"
            />
            <SelectField
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as ProbeStatusFilter)}
              options={[
                { value: '', label: '全部状态' },
                { value: 'unchecked', label: '未检测' },
                { value: 'unused', label: `未使用 (5h≤${thresholds.unusedFiveHourMaxPercent}% · 7d<${thresholds.unusedSevenDayMaxPercent}%)` },
                { value: 'used', label: '已使用' },
                { value: 'rate_limited', label: '限流' },
                { value: 'token_invalid', label: 'Token失效' },
                { value: 'error', label: '错误' },
              ]}
              style={{ width: 160 }}
            />
            <SelectField
              value={planFilter}
              onChange={setPlanFilter}
              options={[{ value: '', label: '全部 Plan' }, ...planOptions.map((item) => ({ value: item, label: item }))]}
              style={{ width: 160 }}
            />
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>5h %</span>
              <TextField
                value={fiveHourMin}
                onChange={(e) => setFiveHourMin(e.target.value)}
                placeholder="min"
                className="w-[70px]"
              />
              <span>~</span>
              <TextField
                value={fiveHourMax}
                onChange={(e) => setFiveHourMax(e.target.value)}
                placeholder="max"
                className="w-[70px]"
              />
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>7d %</span>
              <TextField
                value={sevenDayMin}
                onChange={(e) => setSevenDayMin(e.target.value)}
                placeholder="min"
                className="w-[70px]"
              />
              <span>~</span>
              <TextField
                value={sevenDayMax}
                onChange={(e) => setSevenDayMax(e.target.value)}
                placeholder="max"
                className="w-[70px]"
              />
            </div>
            {usageRangeActive && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFiveHourMin('');
                  setFiveHourMax('');
                  setSevenDayMin('');
                  setSevenDayMax('');
                }}
              >
                清空范围
              </Button>
            )}
            <Button size="sm" onClick={() => setSelectedRows(new Set(visibleRows.map((row) => row.index)))} disabled={visibleRows.length === 0}>
              全选筛选
            </Button>
            <Button size="sm" onClick={() => setSelectedRows(new Set())} disabled={selectedRows.size === 0}>
              清空勾选
            </Button>
            <Button size="sm" variant="primary" onClick={() => { openExportDialogForSelected(); }} loading={exporting} disabled={selectedRows.size === 0}>
              导出勾选 ({selectedRows.size})
            </Button>
            <Button size="sm" onClick={() => { void handleImportToPool(); }} loading={importingToPool} disabled={fileImport.records.length === 0}>
              导入到号池
            </Button>
            <span className="text-xs text-muted-foreground ml-auto">
              当前 {visibleRows.length} 条，可导出 {selectedRows.size} 条
            </span>
          </div>

          <div className="max-h-[62vh] overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={() => {
                        if (allVisibleSelected) {
                          setSelectedRows((current) => {
                            const next = new Set(current);
                            for (const row of visibleRows) next.delete(row.index);
                            return next;
                          });
                          return;
                        }
                        setSelectedRows((current) => {
                          const next = new Set(current);
                          for (const row of visibleRows) next.add(row.index);
                          return next;
                        });
                      }}
                    />
                  </TableHead>
                  <TableHead>#</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Account ID</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>5h / 7d</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      暂无数据
                    </TableCell>
                  </TableRow>
                ) : pagedRows.map((row) => {
                  const badge = getStatusBadge(row.result, thresholds);
                  const active = activeProbeIndices.has(row.index);
                  return (
                    <TableRow key={row.index}>
                      <TableCell>
                        <Checkbox
                          checked={selectedRows.has(row.index)}
                          onCheckedChange={() => {
                            setSelectedRows((current) => {
                              const next = new Set(current);
                              if (next.has(row.index)) next.delete(row.index);
                              else next.add(row.index);
                              return next;
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell className="text-xs">{row.index + 1}</TableCell>
                      <TableCell className="text-xs max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap">{row.email || '-'}</TableCell>
                      <TableCell className="text-xs max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">{row.accountId || '-'}</TableCell>
                      <TableCell>
                        {row.planType ? <Badge variant="info">{row.planType}</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                      </TableCell>
                      <TableCell>
                        {active ? <span className="text-muted-foreground text-xs">检测中...</span> : (
                          <Badge variant={badge.variant}>
                            {badge.label}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.result?.usage ? (
                          <UsageCell
                            fiveHour={{ used: row.result.usage.fiveHourUsed, resetAt: row.result.usage.fiveHourResetAt }}
                            sevenDay={{ used: row.result.usage.sevenDayUsed, resetAt: row.result.usage.sevenDayResetAt }}
                          />
                        ) : active ? (
                          <UsageCell fiveHour={null} sevenDay={null} loading />
                        ) : (
                          <span className="text-muted-foreground text-xs">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <Pagination page={page} pageSize={pageSize} total={visibleRows.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </Card>
      )}

      <ExportDialog
        open={pendingExport !== null}
        onOpenChange={(open) => { if (!open) setPendingExport(null); }}
        title={pendingExport?.title ?? '导出账号数据'}
        count={pendingExport?.rows.length ?? 0}
        onConfirm={handleExportConfirm}
      />
    </div>
  );
}
