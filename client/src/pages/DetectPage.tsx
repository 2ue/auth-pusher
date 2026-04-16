import { useEffect, useState } from 'react';
import { get, post, upload } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
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
import { FileTrigger } from '@/components/FileTrigger';
import { ExportDialog, type ExportOptions } from '@/components/ExportDialog';
import { cn } from '@/lib/utils';

interface ParsedData {
  fileId: string;
  totalRecords: number;
  sampleRecords: { index: number; fields: Record<string, unknown> }[];
  detectedFields: string[];
  suggestedMapping: Record<string, string>;
  fileType: string;
  parseWarnings: string[];
  matchedProfileId?: string;
  matchedProfileName?: string;
  batchId?: string;
  fileCount?: number;
}

interface ParsedRecordPage {
  totalRecords: number;
  records: { index: number; fields: Record<string, unknown> }[];
}

interface DataProfileItem {
  id: string;
  name: string;
  fieldMapping: Record<string, string>;
  builtin?: boolean;
}

interface UsageSnapshot {
  fiveHourUsed: number;
  fiveHourResetAt: string;
  sevenDayUsed: number;
  sevenDayResetAt: string;
}

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

interface DetectThresholds {
  unusedFiveHourMaxPercent: number;
  unusedSevenDayMaxPercent: number;
}

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

const PLAN_TYPE_OPTIONS = [
  { value: '', label: '自动识别' },
  { value: 'free', label: 'free' },
  { value: 'plus', label: 'plus' },
  { value: 'pro', label: 'pro' },
  { value: 'team', label: 'team' },
  { value: '__custom__', label: '其他' },
];

const DETECT_CONCURRENCY = 3;

function getApiKeyHeader(): Record<string, string> {
  const key = localStorage.getItem('auth-pusher-api-key') ?? '';
  return key ? { 'X-Api-Key': key } : {};
}

function resolvePlanTypeOverride(preset: string, custom: string): string {
  if (preset === '__custom__') return custom.trim();
  return preset.trim();
}

function getByPath(obj: Record<string, unknown>, fieldPath: string): unknown {
  if (!fieldPath) return undefined;
  if (fieldPath in obj) return obj[fieldPath];

  const parts = fieldPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pickMappedValue(
  fields: Record<string, unknown>,
  fieldMapping: Record<string, string>,
  standardField: string,
  fallbacks: string[],
): string {
  const mappedPath = fieldMapping[standardField];
  const candidates = [
    mappedPath ? getByPath(fields, mappedPath) : undefined,
    ...fallbacks.map((key) => getByPath(fields, key)),
  ];

  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim();
    if (text) return text;
  }
  return '';
}

function decodeTokenClaims(accessToken: string): { email: string; accountId: string; planType: string } {
  const empty = { email: '', accountId: '', planType: '' };
  if (!accessToken) return empty;

  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return empty;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const profile = (payload['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;
    return {
      email: String(profile.email ?? '').trim(),
      accountId: String(auth.chatgpt_account_id ?? '').trim(),
      planType: String(auth.chatgpt_plan_type ?? '').trim(),
    };
  } catch {
    return empty;
  }
}

function extractProbeTarget(
  fields: Record<string, unknown>,
  fieldMapping: Record<string, string>,
  planTypeOverride?: string,
): { email: string; accessToken: string; accountId?: string; planType?: string } {
  const accessToken = pickMappedValue(fields, fieldMapping, 'access_token', ['access_token', 'accessToken', 'token']);
  const claims = decodeTokenClaims(accessToken);
  const email = pickMappedValue(fields, fieldMapping, 'email', ['email', 'Email']) || claims.email;
  const accountId = pickMappedValue(fields, fieldMapping, 'account_id', ['account_id', 'accountId']) || claims.accountId;
  const planType = planTypeOverride?.trim()
    || pickMappedValue(fields, fieldMapping, 'plan_type', ['plan_type', 'planType'])
    || claims.planType;

  return {
    email,
    accessToken,
    accountId: accountId || undefined,
    planType: planType || undefined,
  };
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function buildExportFilename(index: number, email: string, accountId: string): string {
  const emailPart = sanitizeFilenamePart(email);
  if (emailPart) return `${emailPart}.json`;
  const accountPart = sanitizeFilenamePart(accountId);
  if (accountPart) return `${accountPart}.json`;
  return `record-${String(index + 1).padStart(4, '0')}.json`;
}

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

  const [profiles, setProfiles] = useState<DataProfileItem[]>([]);
  const [thresholds, setThresholds] = useState<DetectThresholds>(DEFAULT_DETECT_THRESHOLDS);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [records, setRecords] = useState<ParsedRecordPage['records']>([]);
  const [uploading, setUploading] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [probeResults, setProbeResults] = useState<Map<number, AccountUsageResult>>(new Map());
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [probing, setProbing] = useState(false);
  const [activeProbeIndices, setActiveProbeIndices] = useState<Set<number>>(new Set());
  const [processedCount, setProcessedCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState<ProbeStatusFilter>('');
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [fiveHourMin, setFiveHourMin] = useState('');
  const [fiveHourMax, setFiveHourMax] = useState('');
  const [sevenDayMin, setSevenDayMin] = useState('');
  const [sevenDayMax, setSevenDayMax] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [pendingExport, setPendingExport] = useState<{
    rows: DerivedRow[];
    title: string;
    slug: string;
  } | null>(null);
  const [importPlanTypePreset, setImportPlanTypePreset] = useState('');
  const [importPlanTypeCustom, setImportPlanTypeCustom] = useState('');
  const planTypeOverride = resolvePlanTypeOverride(importPlanTypePreset, importPlanTypeCustom);

  useEffect(() => {
    get<DataProfileItem[]>('/profiles').then(setProfiles);
    get<{ detectThresholds?: DetectThresholds }>('/settings').then((settings) => {
      if (settings.detectThresholds) setThresholds(settings.detectThresholds);
    }).catch(() => { /* 用默认值即可 */ });
  }, []);

  async function loadAllRecords(fileId: string, totalRecords: number, preserveSelection = false) {
    setLoadingRecords(true);
    try {
      const all: ParsedRecordPage['records'] = [];
      const limit = 500;
      for (let offset = 0; offset < totalRecords; offset += limit) {
        const pageData = await get<ParsedRecordPage>(`/data/records/${fileId}?offset=${offset}&limit=${limit}`);
        all.push(...pageData.records);
        if (pageData.records.length < limit) break;
      }
      setRecords(all);
      if (!preserveSelection) {
        setSelectedRows(new Set(all.map((record) => record.index)));
      } else {
        setSelectedRows((current) => {
          const next = new Set(current);
          const knownIndices = new Set(records.map((r) => r.index));
          for (const rec of all) {
            if (!knownIndices.has(rec.index)) next.add(rec.index);
          }
          return next;
        });
      }
    } finally {
      setLoadingRecords(false);
    }
  }

  async function handleFileUpload(fileList: FileList | null, mode: 'replace' | 'append' = 'replace') {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError('');

    if (mode === 'replace') {
      setParsedData(null);
      setRecords([]);
      setProbeResults(new Map());
      setSelectedRows(new Set());
      setProcessedCount(0);
      setActiveProbeIndices(new Set());
      setPage(0);
    }

    try {
      if (mode === 'append' && parsedData) {
        const formData = new FormData();
        for (let index = 0; index < fileList.length; index++) {
          formData.append('files', fileList[index]);
        }
        const result = await upload<{
          fileId: string;
          totalRecords: number;
          added: number;
          duplicated: number;
          detectedFields: string[];
          parseWarnings: string[];
        }>(`/data/append/${parsedData.fileId}`, formData);

        setParsedData((current) => current ? {
          ...current,
          totalRecords: result.totalRecords,
          detectedFields: Array.from(new Set([...current.detectedFields, ...result.detectedFields])),
          parseWarnings: [...current.parseWarnings, ...result.parseWarnings],
          fileCount: (current.fileCount ?? 1) + fileList.length,
        } : current);
        await loadAllRecords(result.fileId, result.totalRecords, true);
        notify({
          tone: 'success',
          title: '追加完成',
          description: `新增 ${result.added} 条${result.duplicated > 0 ? `，跳过重复 ${result.duplicated} 条` : ''}`,
        });
        return;
      }

      const formData = new FormData();
      let data: ParsedData;
      if (fileList.length === 1) {
        formData.append('file', fileList[0]);
        data = await upload<ParsedData>('/data/parse', formData);
      } else {
        for (let index = 0; index < fileList.length; index++) {
          formData.append('files', fileList[index]);
        }
        data = await upload<ParsedData>('/data/parse-multi', formData);
      }

      setParsedData(data);
      setFieldMapping(data.suggestedMapping);
      setSelectedProfileId(data.matchedProfileId ?? '');
      await loadAllRecords(data.fileId, data.totalRecords);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function handleProfileSelect(profileId: string) {
    setSelectedProfileId(profileId);
    if (!profileId) return;
    const matched = profiles.find((profile) => profile.id === profileId);
    if (matched) {
      setFieldMapping(matched.fieldMapping);
    }
  }

  const derivedRows: DerivedRow[] = records.map((record) => {
    const target = extractProbeTarget(record.fields, fieldMapping, planTypeOverride);
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
  const progressValue = parsedData?.totalRecords ? Math.round((processedCount / parsedData.totalRecords) * 100) : 0;

  useEffect(() => {
    setPage(0);
  }, [statusFilter, planFilter, search, fiveHourMin, fiveHourMax, sevenDayMin, sevenDayMax]);

  async function handleDetectAll() {
    if (!parsedData || records.length === 0) return;

    setProbing(true);
    setProbeResults(new Map());
    setProcessedCount(0);
    setActiveProbeIndices(new Set());

    const summary = { ok: 0, rateLimited: 0, tokenInvalid: 0, error: 0, skipped: 0 };

    try {
      let cursor = 0;
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

          const target = extractProbeTarget(record.fields, fieldMapping, planTypeOverride);

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

  async function sendExport(
    rows: typeof derivedRows,
    options: ExportOptions,
    downloadSlug: string,
  ) {
    if (!parsedData || rows.length === 0) return;

    const items = rows.map((row) => ({
      index: row.index,
      filename: buildExportFilename(row.index, row.email, row.accountId),
      email: row.email,
      accountId: row.accountId,
      planType: options.planTypeOverride || row.planType || undefined,
      planField: fieldMapping.plan_type || undefined,
    }));

    const downloadName = `${downloadSlug}-${options.format}${options.mode === 'merged' ? '-merged' : ''}-${new Date().toISOString().slice(0, 10)}`;

    const response = await fetch('/api/data/export-accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getApiKeyHeader(),
      },
      body: JSON.stringify({
        fileId: parsedData.fileId,
        format: options.format,
        mode: options.mode,
        downloadName,
        items,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const ext = options.mode === 'merged' ? 'json' : 'zip';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${downloadName}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notify({
      tone: 'success',
      title: '导出完成',
      description: options.mode === 'merged'
        ? `已合并导出 ${items.length} 条记录为单个 JSON`
        : `已导出 ${items.length} 个 JSON 文件`,
    });
  }

  function openExportDialogForSelected() {
    if (!parsedData) return;
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
    if (!parsedData) return;
    const rows = derivedRows.filter((row) => row.category === category);
    const meta = CATEGORY_META[category];
    if (rows.length === 0) {
      notify({ tone: 'error', title: '无法导出', description: `��前没有${meta.label}的账号` });
      return;
    }
    setPendingExport({
      rows,
      title: `导出「${meta.label}」账号（${rows.length} 条）`,
      slug: `detected-${meta.filename}`,
    });
  }

  async function handleExportConfirm(options: ExportOptions) {
    if (!pendingExport) return;
    setExporting(true);
    try {
      await sendExport(pendingExport.rows, options, pendingExport.slug);
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

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-semibold">导入数据</h3>
            <p className="text-xs text-muted-foreground mt-1">支持 JSON、CSV、TSV，多文件会合并为一批记录</p>
          </div>
          {parsedData && <Badge variant="info">{parsedData.fileType.toUpperCase()}</Badge>}
        </div>

        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div className="min-w-[180px]">
            <div className="text-xs text-muted-foreground mb-1">导入类型</div>
            <SelectField
              value={importPlanTypePreset}
              onChange={setImportPlanTypePreset}
              options={PLAN_TYPE_OPTIONS}
            />
          </div>
          {importPlanTypePreset === '__custom__' && (
            <div className="min-w-[200px]">
              <div className="text-xs text-muted-foreground mb-1">自定义类型</div>
              <TextField
                value={importPlanTypeCustom}
                onChange={(event) => setImportPlanTypeCustom(event.target.value)}
                placeholder="输入自定义类型"
              />
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            留空按原始数据或 token 自动识别；设置后会用于检测展示和导出。
          </div>
        </div>

        <FileTrigger
          variant="dropzone"
          accept=".json,.csv,.tsv"
          multiple
          disabled={uploading || probing}
          onFiles={(files) => { void handleFileUpload(files, parsedData ? 'append' : 'replace'); }}
        >
          {uploading ? <p>解析中...</p> : parsedData ? (
            <div>
              <p className="text-base mb-2">拖拽或点击继续追加文件</p>
              <p className="text-muted-foreground text-xs">
                新记录会追加到现有列表，按 email / access_token 自动去重，已检测结果保留
              </p>
            </div>
          ) : (
            <div>
              <p className="text-base mb-2">拖拽或点击选择文件</p>
              <p className="text-muted-foreground text-xs">导入后不会推送，只用于检测与导出</p>
            </div>
          )}
        </FileTrigger>

        {parsedData && (
          <div className="mt-3 flex justify-end">
            <FileTrigger
              accept=".json,.csv,.tsv"
              multiple
              disabled={uploading || probing}
              onFiles={(files) => { void handleFileUpload(files, 'replace'); }}
            >
              <Button size="sm" variant="ghost" disabled={uploading || probing}>
                清空并重新导入
              </Button>
            </FileTrigger>
          </div>
        )}

        {uploadError && <p className="text-destructive mt-3">{uploadError}</p>}

        {parsedData && (
          <div className="mt-4 space-y-4">
            <div className={cn(
              'p-3 rounded-lg border',
              parsedData.matchedProfileId ? 'bg-success/10 border-success/30' : 'bg-muted border-border',
            )}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  {parsedData.matchedProfileId
                    ? <><span className="text-success font-semibold">匹配模板:</span> {parsedData.matchedProfileName}</>
                    : <span className="text-muted-foreground">未匹配到模板</span>}
                </div>
                <SelectField
                  value={selectedProfileId}
                  onChange={handleProfileSelect}
                  options={[{ value: '', label: '不使用模板' }, ...profiles.map((profile) => ({ value: profile.id, label: profile.name }))]}
                  style={{ width: 220 }}
                />
              </div>
            </div>

            {parsedData.parseWarnings.length > 0 && (
              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  解析信息（{parsedData.parseWarnings.length} 条）
                </summary>
                <div className="mt-2 p-2 bg-muted rounded text-xs text-muted-foreground max-h-[140px] overflow-auto">
                  {parsedData.parseWarnings.map((warning, index) => <div key={index}>{warning}</div>)}
                </div>
              </details>
            )}

            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground mb-1">总记录</div>
                <div className="text-lg font-semibold">{parsedData.totalRecords}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground mb-1">文件数</div>
                <div className="text-lg font-semibold">{parsedData.fileCount ?? 1}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground mb-1">加载状态</div>
                <div className="text-lg font-semibold">{loadingRecords ? '读取中...' : `${records.length} 条已载入`}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground mb-1">导入类型</div>
                <div className="text-lg font-semibold">{planTypeOverride || '自动识别'}</div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {parsedData && (
        <Card className="p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-base font-semibold">开始检测</h3>
              <p className="text-xs text-muted-foreground mt-1">
                当前字段映射：
                {['access_token', 'email', 'account_id', 'plan_type']
                  .map((f) => `${f} → ${fieldMapping[f] || '未映射'}`)
                  .join('；')}
              </p>
            </div>
            <Button size="sm" variant="primary" onClick={() => { void handleDetectAll(); }} loading={probing} disabled={loadingRecords || records.length === 0}>
              {probing ? '检测中...' : '开始检测'}
            </Button>
          </div>

          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
              调整字段映射
            </summary>
            <div className="px-3 pb-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标准字段</TableHead>
                    <TableHead>数据源字段</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {['access_token', 'email', 'account_id', 'plan_type'].map((field) => (
                    <TableRow key={field}>
                      <TableCell className="font-medium">{field}</TableCell>
                      <TableCell>
                        <SelectField
                          value={fieldMapping[field] ?? ''}
                          onChange={(value) => setFieldMapping((current) => ({ ...current, [field]: value }))}
                          options={[{ value: '', label: '-- 不映射 --' }, ...parsedData.detectedFields.map((item) => ({ value: item, label: item }))]}
                          className="w-full"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>

          {(probing || processedCount > 0) && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{probing ? '逐条检测中...' : '检测完成'}</span>
                <span>{processedCount} / {parsedData.totalRecords}</span>
              </div>
              <Progress value={progressValue} />
            </div>
          )}
        </Card>
      )}

      {parsedData && processedCount > 0 && (
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

      {parsedData && (
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
