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

type ProbeStatusFilter = '' | 'unchecked' | 'ok' | 'rate_limited' | 'token_invalid' | 'error';

const PLAN_TYPE_OPTIONS = [
  { value: '', label: '自动识别' },
  { value: 'free', label: 'free' },
  { value: 'plus', label: 'plus' },
  { value: 'pro', label: 'pro' },
  { value: 'team', label: 'team' },
  { value: '__custom__', label: '其他' },
];

const EXPORT_PLAN_TYPE_OPTIONS = [
  { value: '', label: '跟随当前数据' },
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
  const parts = [
    `record-${String(index + 1).padStart(4, '0')}`,
    sanitizeFilenamePart(email),
    sanitizeFilenamePart(accountId),
  ].filter(Boolean);
  return `${parts.join('_') || `record-${String(index + 1).padStart(4, '0')}`}.json`;
}

function getStatusBadge(result: AccountUsageResult | undefined) {
  if (!result) return { variant: 'muted' as const, label: '未检测' };
  if (result.status === 'ok') return { variant: 'success' as const, label: '正常' };
  if (result.status === 'rate_limited') return { variant: 'warning' as const, label: '限流' };
  if (result.status === 'token_invalid') return { variant: 'destructive' as const, label: 'Token失效' };
  return { variant: 'destructive' as const, label: '错误' };
}

export default function DetectPage() {
  const { notify } = useFeedback();

  const [profiles, setProfiles] = useState<DataProfileItem[]>([]);
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
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [importPlanTypePreset, setImportPlanTypePreset] = useState('');
  const [importPlanTypeCustom, setImportPlanTypeCustom] = useState('');
  const [exportPlanTypePreset, setExportPlanTypePreset] = useState('');
  const [exportPlanTypeCustom, setExportPlanTypeCustom] = useState('');

  const planTypeOverride = resolvePlanTypeOverride(importPlanTypePreset, importPlanTypeCustom);
  const exportPlanTypeOverride = resolvePlanTypeOverride(exportPlanTypePreset, exportPlanTypeCustom);

  useEffect(() => {
    get<DataProfileItem[]>('/profiles').then(setProfiles);
  }, []);

  async function loadAllRecords(fileId: string, totalRecords: number) {
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
      setSelectedRows(new Set(all.map((record) => record.index)));
    } finally {
      setLoadingRecords(false);
    }
  }

  async function handleFileUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError('');
    setParsedData(null);
    setRecords([]);
    setProbeResults(new Map());
    setSelectedRows(new Set());
    setProcessedCount(0);
    setActiveProbeIndices(new Set());
    setPage(0);

    try {
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

  const derivedRows = records.map((record) => {
    const target = extractProbeTarget(record.fields, fieldMapping, planTypeOverride);
    return {
      index: record.index,
      fields: record.fields,
      email: target.email,
      accountId: target.accountId ?? '',
      planType: target.planType ?? '',
      accessToken: target.accessToken,
      result: probeResults.get(record.index),
    };
  });

  const visibleRows = derivedRows.filter((row) => {
    if (statusFilter === 'unchecked' && row.result) return false;
    if (statusFilter && statusFilter !== 'unchecked' && row.result?.status !== statusFilter) return false;
    if (planFilter && row.planType !== planFilter) return false;
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
  }, [statusFilter, planFilter, search]);

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

  async function handleExportSelected() {
    if (!parsedData || selectedRows.size === 0) {
      notify({ tone: 'error', title: '无法导出', description: '请先勾选要导出的数据' });
      return;
    }

    setExporting(true);
    try {
      const items = derivedRows
        .filter((row) => selectedRows.has(row.index))
        .map((row) => ({
          index: row.index,
          filename: buildExportFilename(row.index, row.email, row.accountId),
          planType: exportPlanTypeOverride || row.planType || undefined,
          planField: fieldMapping.plan_type || undefined,
        }));

      const response = await fetch('/api/data/export-zip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getApiKeyHeader(),
        },
        body: JSON.stringify({ fileId: parsedData.fileId, items }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `detected-records-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      notify({ tone: 'success', title: '导出完成', description: `已导出 ${items.length} 个 JSON 文件` });
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
          onFiles={(files) => { void handleFileUpload(files); }}
        >
          {uploading ? <p>解析中...</p> : (
            <div>
              <p className="text-base mb-2">拖拽或点击选择文件</p>
              <p className="text-muted-foreground text-xs">导入后不会推送，只用于检测与导出</p>
            </div>
          )}
        </FileTrigger>

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
              <h3 className="text-base font-semibold">字段映射</h3>
              <p className="text-xs text-muted-foreground mt-1">检测只需要下面这些字段</p>
            </div>
            <Button size="sm" variant="primary" onClick={() => { void handleDetectAll(); }} loading={probing} disabled={loadingRecords || records.length === 0}>
              {probing ? '检测中...' : '开始检测'}
            </Button>
          </div>

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
                { value: 'ok', label: '正常' },
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
            <Button size="sm" onClick={() => setSelectedRows(new Set(visibleRows.map((row) => row.index)))} disabled={visibleRows.length === 0}>
              全选筛选
            </Button>
            <Button size="sm" onClick={() => setSelectedRows(new Set())} disabled={selectedRows.size === 0}>
              清空勾选
            </Button>
            <div className="min-w-[160px]">
              <SelectField
                value={exportPlanTypePreset}
                onChange={setExportPlanTypePreset}
                options={EXPORT_PLAN_TYPE_OPTIONS}
              />
            </div>
            {exportPlanTypePreset === '__custom__' && (
              <div className="w-[160px]">
                <TextField
                  value={exportPlanTypeCustom}
                  onChange={(event) => setExportPlanTypeCustom(event.target.value)}
                  placeholder="导出自定义类型"
                  size="sm"
                />
              </div>
            )}
            <Button size="sm" variant="primary" onClick={() => { void handleExportSelected(); }} loading={exporting} disabled={selectedRows.size === 0}>
              导出勾选 ({selectedRows.size})
            </Button>
            <span className="text-xs text-muted-foreground ml-auto">
              当前 {visibleRows.length} 条，可导出 {selectedRows.size} 条{exportPlanTypeOverride ? `，导出类型 ${exportPlanTypeOverride}` : ''}
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
                  const badge = getStatusBadge(row.result);
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
    </div>
  );
}
