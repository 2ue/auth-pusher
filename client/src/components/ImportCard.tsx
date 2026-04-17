import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { SelectField } from '@/components/SelectField';
import { TextField } from '@/components/TextField';
import { FileTrigger } from '@/components/FileTrigger';
import { cn } from '@/lib/utils';
import { PLAN_TYPE_OPTIONS } from '@/utils/data-helpers';
import type { ParsedData, DataProfileItem } from '@/hooks/useFileImport';

interface ImportCardProps {
  profiles: DataProfileItem[];
  selectedProfileId: string;
  onProfileSelect: (profileId: string) => void;
  parsedData: ParsedData | null;
  uploading: boolean;
  loadingRecords: boolean;
  uploadError: string;
  recordCount: number;
  fieldMapping: Record<string, string>;
  onFieldMappingChange: (mapping: Record<string, string>) => void;
  onFileUpload: (files: FileList | null, mode: 'replace' | 'append') => void;
  disabled?: boolean;
  /** planType 覆盖相关 */
  importPlanTypePreset: string;
  importPlanTypeCustom: string;
  onPlanTypePresetChange: (value: string) => void;
  onPlanTypeCustomChange: (value: string) => void;
  planTypeOverride: string;
  /** 隐藏字段映射调整（转换页面默认展开，检测页面折叠） */
  mappingCollapsible?: boolean;
}

export function ImportCard({
  profiles,
  selectedProfileId,
  onProfileSelect,
  parsedData,
  uploading,
  loadingRecords,
  uploadError,
  recordCount,
  fieldMapping,
  onFieldMappingChange,
  onFileUpload,
  disabled = false,
  importPlanTypePreset,
  importPlanTypeCustom,
  onPlanTypePresetChange,
  onPlanTypeCustomChange,
  planTypeOverride,
  mappingCollapsible = true,
}: ImportCardProps) {
  const mappingContent = parsedData && (
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
                  onChange={(value) => onFieldMappingChange({ ...fieldMapping, [field]: value })}
                  options={[{ value: '', label: '-- 不映射 --' }, ...parsedData.detectedFields.map((item) => ({ value: item, label: item }))]}
                  className="w-full"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
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
            onChange={onPlanTypePresetChange}
            options={PLAN_TYPE_OPTIONS}
          />
        </div>
        {importPlanTypePreset === '__custom__' && (
          <div className="min-w-[200px]">
            <div className="text-xs text-muted-foreground mb-1">自定义类型</div>
            <TextField
              value={importPlanTypeCustom}
              onChange={(event) => onPlanTypeCustomChange(event.target.value)}
              placeholder="输入自定义类型"
            />
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          留空按原始数据或 token 自动识别；设置后会用于导出。
        </div>
      </div>

      <FileTrigger
        variant="dropzone"
        accept=".json,.csv,.tsv"
        multiple
        disabled={uploading || disabled}
        onFiles={(files) => { onFileUpload(files, parsedData ? 'append' : 'replace'); }}
      >
        {uploading ? <p>解析中...</p> : parsedData ? (
          <div>
            <p className="text-base mb-2">拖拽或点击继续追加文件</p>
            <p className="text-muted-foreground text-xs">
              新记录会追加到现有列表，按 email / access_token 自动去重
            </p>
          </div>
        ) : (
          <div>
            <p className="text-base mb-2">拖拽或点击选择文件</p>
            <p className="text-muted-foreground text-xs">导入后不会推送，仅用于转换与导出</p>
          </div>
        )}
      </FileTrigger>

      {parsedData && (
        <div className="mt-3 flex justify-end">
          <FileTrigger
            accept=".json,.csv,.tsv"
            multiple
            disabled={uploading || disabled}
            onFiles={(files) => { onFileUpload(files, 'replace'); }}
          >
            <Button size="sm" variant="ghost" disabled={uploading || disabled}>
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
                onChange={onProfileSelect}
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
              <div className="text-lg font-semibold">{loadingRecords ? '读取中...' : `${recordCount} 条已载入`}</div>
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground mb-1">导入类型</div>
              <div className="text-lg font-semibold">{planTypeOverride || '自动识别'}</div>
            </div>
          </div>

          {mappingCollapsible ? (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                调整字段映射
              </summary>
              {mappingContent}
            </details>
          ) : (
            <div className="rounded-lg border border-border">
              <div className="px-3 py-2 text-sm text-muted-foreground">字段映射</div>
              {mappingContent}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
