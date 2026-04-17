import { useState, useMemo } from 'react';
import { useFeedback } from '@/components/FeedbackProvider';
import { ImportCard } from '@/components/ImportCard';
import { useFileImport } from '@/hooks/useFileImport';
import { useExport } from '@/hooks/useExport';
import { extractProbeTarget, resolvePlanTypeOverride, pickMappedValue, EXPORT_PLAN_OPTIONS } from '@/utils/data-helpers';
import { post } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TextField } from '@/components/TextField';
import { cn } from '@/lib/utils';
import type { ExportFormat, ExportMode } from '@/components/ExportDialog';

const PREVIEW_LIMIT = 10;

function OptionCard({ active, onClick, title, description }: {
  active: boolean; onClick: () => void; title: string; description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left rounded-lg border p-3 transition-colors',
        active
          ? 'border-primary bg-primary/10'
          : 'border-border hover:border-primary/40 hover:bg-muted/50',
      )}
    >
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="text-xs text-muted-foreground leading-snug">{description}</div>
    </button>
  );
}

export default function ConvertPage() {
  const { notify } = useFeedback();
  const fileImport = useFileImport();
  const { exporting, setExporting, sendExport } = useExport();

  const [importPlanTypePreset, setImportPlanTypePreset] = useState('');
  const [importPlanTypeCustom, setImportPlanTypeCustom] = useState('');
  const planTypeOverride = resolvePlanTypeOverride(importPlanTypePreset, importPlanTypeCustom);

  /* ── 导出设置（内嵌） ── */
  const [format, setFormat] = useState<ExportFormat>('raw');
  const [mode, setMode] = useState<ExportMode>('individual');
  const [exportPlanPreset, setExportPlanPreset] = useState('');
  const [exportPlanCustom, setExportPlanCustom] = useState('');
  const exportPlanOverride = exportPlanPreset === '__custom__' ? exportPlanCustom.trim() : exportPlanPreset.trim();

  async function handleFileUpload(files: FileList | null, uploadMode: 'replace' | 'append') {
    const result = await fileImport.handleFileUpload(files, uploadMode);
    if (!result) return;
    if (result.action === 'append') {
      notify({
        tone: 'success',
        title: '追加完成',
        description: `新增 ${result.added} 条${result.duplicated && result.duplicated > 0 ? `，跳过重复 ${result.duplicated} 条` : ''}`,
      });
    }
  }

  const derivedRows = useMemo(() =>
    fileImport.records.map((record) => {
      const target = extractProbeTarget(record.fields, fileImport.fieldMapping, planTypeOverride);
      return {
        index: record.index,
        email: target.email,
        accountId: target.accountId ?? '',
        planType: target.planType ?? '',
      };
    }),
  [fileImport.records, fileImport.fieldMapping, planTypeOverride]);

  const previewRows = derivedRows.slice(0, PREVIEW_LIMIT);
  const totalCount = derivedRows.length;

  async function handleExport() {
    if (!fileImport.parsedData || totalCount === 0) return;
    setExporting(true);
    try {
      const result = await sendExport(
        fileImport.parsedData.fileId,
        derivedRows,
        fileImport.fieldMapping,
        { format, mode, planTypeOverride: exportPlanOverride },
        'convert',
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

  /* ── 导入到号池 ── */
  const [importingToPool, setImportingToPool] = useState(false);
  async function handleImportToPool() {
    if (!fileImport.parsedData || totalCount === 0) return;
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

  /* ── 刷新 Token ── */
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
        total: number; refreshed: number;
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

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="text-lg font-semibold mb-2">格式转换</h2>
        <p className="text-sm text-muted-foreground">
          导入本地数据文件（JSON / CSV / TSV），确认解析后选择目标格式全量导出。如需筛选或检测，请使用「检测」页。
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
        importPlanTypePreset={importPlanTypePreset}
        importPlanTypeCustom={importPlanTypeCustom}
        onPlanTypePresetChange={setImportPlanTypePreset}
        onPlanTypeCustomChange={setImportPlanTypeCustom}
        planTypeOverride={planTypeOverride}
        mappingCollapsible
      />

      {fileImport.parsedData && totalCount > 0 && (
        <>
          {/* ── 数据预览 ── */}
          <Card className="p-5">
            <h3 className="text-base font-semibold mb-3">
              数据预览
              <span className="text-sm font-normal text-muted-foreground ml-2">
                前 {Math.min(PREVIEW_LIMIT, totalCount)} / {totalCount} 条
              </span>
            </h3>
            <div className="overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Account ID</TableHead>
                    <TableHead>Plan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row) => (
                    <TableRow key={row.index}>
                      <TableCell className="text-xs">{row.index + 1}</TableCell>
                      <TableCell className="text-xs max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap">{row.email || '-'}</TableCell>
                      <TableCell className="text-xs max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">{row.accountId || '-'}</TableCell>
                      <TableCell>
                        {row.planType ? <Badge variant="info">{row.planType}</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalCount > PREVIEW_LIMIT && (
              <p className="text-xs text-muted-foreground mt-2">
                还有 {totalCount - PREVIEW_LIMIT} 条未显示，导出时将包含全部 {totalCount} 条记录
              </p>
            )}
          </Card>

          {/* ── 刷新 Token ── */}
          <Card className="p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">刷新 Token</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  使用 refresh_token 获取新的 access_token，刷新后导出即为最新凭证
                </p>
              </div>
              <Button size="sm" onClick={() => { void handleRefreshAll(); }} loading={refreshing} disabled={fileImport.loadingRecords || totalCount === 0}>
                {refreshing ? '刷新中...' : '刷新 Token'}
              </Button>
            </div>
            {refreshSummary && (
              <div className="mt-3 p-3 rounded-lg bg-muted text-sm">
                刷新结果：成功 <span className="text-success font-semibold">{refreshSummary.ok}</span>
                {refreshSummary.invalid > 0 && <>，RT 失效 <span className="text-destructive font-semibold">{refreshSummary.invalid}</span></>}
                {refreshSummary.error > 0 && <>，错误 <span className="text-destructive font-semibold">{refreshSummary.error}</span></>}
                {refreshSummary.skipped > 0 && <>，跳过 <span className="text-muted-foreground">{refreshSummary.skipped}</span></>}
              </div>
            )}
          </Card>

          {/* ── 导出设置（内嵌） ── */}
          <Card className="p-5 space-y-5">
            <h3 className="text-base font-semibold">导出设置</h3>

            <div>
              <div className="text-sm font-medium mb-2">导出格式</div>
              <div className="grid grid-cols-3 gap-2">
                <OptionCard active={format === 'raw'} onClick={() => setFormat('raw')} title="原始 Token" description="扁平 JSON，含 plan_type，与导入模板对齐" />
                <OptionCard active={format === 'cpa'} onClick={() => setFormat('cpa')} title="CPA" description="CliproxyCLI 上传格式，不含 plan_type" />
                <OptionCard active={format === 'sub2api'} onClick={() => setFormat('sub2api')} title="SUB2API" description="完整 OAuth account payload" />
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">打包方式</div>
              <div className="grid grid-cols-2 gap-2">
                <OptionCard active={mode === 'individual'} onClick={() => setMode('individual')} title="每条独立" description="zip 压缩包，每条记录一个 JSON 文件" />
                <OptionCard
                  active={mode === 'merged'}
                  onClick={() => setMode('merged')}
                  title="合并一个文件"
                  description={format === 'sub2api' ? '单个 JSON：{ accounts: [...] }' : '单个 JSON：数组形式'}
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Plan Type 覆盖</div>
              <div className="flex flex-wrap gap-2">
                {EXPORT_PLAN_OPTIONS.map((opt) => (
                  <button
                    key={opt.value || 'inherit'}
                    type="button"
                    onClick={() => setExportPlanPreset(opt.value)}
                    className={cn(
                      'rounded-md border px-3 h-8 text-sm transition-colors',
                      exportPlanPreset === opt.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:border-primary/40 hover:bg-muted/50',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {exportPlanPreset === '__custom__' && (
                <div className="mt-2 max-w-[300px]">
                  <TextField
                    value={exportPlanCustom}
                    onChange={(e) => setExportPlanCustom(e.target.value)}
                    placeholder="输入自定义 plan_type（例如 enterprise）"
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1.5">
                {exportPlanOverride
                  ? `导出时 plan_type 覆盖为：${exportPlanOverride}`
                  : '不覆盖，沿用原数据或 token 中的 plan_type'}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                onClick={handleImportToPool}
                loading={importingToPool}
                disabled={totalCount === 0}
              >
                导入到号池
              </Button>
              <Button
                variant="primary"
                onClick={handleExport}
                loading={exporting}
                disabled={totalCount === 0 || (exportPlanPreset === '__custom__' && !exportPlanCustom.trim())}
              >
                导出全部 {totalCount} 条
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
