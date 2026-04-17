import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { TextField } from './TextField';
import { cn } from '@/lib/utils';
import { EXPORT_PLAN_OPTIONS } from '@/utils/data-helpers';

export type ExportFormat = 'raw' | 'cpa' | 'sub2api';
export type ExportMode = 'individual' | 'merged';

export interface ExportOptions {
  format: ExportFormat;
  mode: ExportMode;
  planTypeOverride: string;
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  count: number;
  onConfirm: (options: ExportOptions) => Promise<void> | void;
  defaultFormat?: ExportFormat;
  defaultMode?: ExportMode;
  /** 来源数据本身的 plan_type（用于「跟随原数据」提示） */
  currentPlanTypeHint?: string;
}

export function ExportDialog({
  open,
  onOpenChange,
  title = '导出数据',
  description,
  count,
  onConfirm,
  defaultFormat = 'raw',
  defaultMode = 'individual',
  currentPlanTypeHint,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [mode, setMode] = useState<ExportMode>(defaultMode);
  const [planPreset, setPlanPreset] = useState('');
  const [planCustom, setPlanCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setFormat(defaultFormat);
      setMode(defaultMode);
      setPlanPreset('');
      setPlanCustom('');
      setSubmitting(false);
    }
  }, [open, defaultFormat, defaultMode]);

  const planTypeOverride = planPreset === '__custom__' ? planCustom.trim() : planPreset.trim();

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm({ format, mode, planTypeOverride });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? `本次将导出 ${count} 条记录，请选择格式与方式。`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div>
            <div className="text-sm font-medium mb-2">导出格式</div>
            <div className="grid grid-cols-3 gap-2">
              <OptionCard
                active={format === 'raw'}
                onClick={() => setFormat('raw')}
                title="原始 Token"
                description="扁平 JSON，含 plan_type，与导入模板对齐"
              />
              <OptionCard
                active={format === 'cpa'}
                onClick={() => setFormat('cpa')}
                title="CPA"
                description="CliproxyCLI 上传格式，不含 plan_type"
              />
              <OptionCard
                active={format === 'sub2api'}
                onClick={() => setFormat('sub2api')}
                title="SUB2API"
                description="完整 OAuth account payload"
              />
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">打包方式</div>
            <div className="grid grid-cols-2 gap-2">
              <OptionCard
                active={mode === 'individual'}
                onClick={() => setMode('individual')}
                title="每条独立"
                description="zip 压缩包，每条记录一个 JSON 文件"
              />
              <OptionCard
                active={mode === 'merged'}
                onClick={() => setMode('merged')}
                title="合并一个文件"
                description={format === 'sub2api'
                  ? '单个 JSON：{ accounts: [...] }'
                  : '单个 JSON：数组形式'}
              />
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">Plan Type</div>
            <div className="flex flex-wrap gap-2">
              {EXPORT_PLAN_OPTIONS.map((opt) => (
                <button
                  key={opt.value || 'inherit'}
                  type="button"
                  onClick={() => setPlanPreset(opt.value)}
                  className={cn(
                    'rounded-md border px-3 h-8 text-sm transition-colors',
                    planPreset === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:border-primary/40 hover:bg-muted/50',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {planPreset === '__custom__' && (
              <div className="mt-2">
                <TextField
                  value={planCustom}
                  onChange={(e) => setPlanCustom(e.target.value)}
                  placeholder="输入自定义 plan_type（例如 enterprise）"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1.5">
              {planTypeOverride
                ? `将把 plan_type 覆盖为：${planTypeOverride}`
                : currentPlanTypeHint
                  ? `默认使用原数据的 plan_type（例如 ${currentPlanTypeHint}）`
                  : '不覆盖，沿用原数据或 token 中的 plan_type'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={submitting}
            disabled={count === 0 || (planPreset === '__custom__' && !planCustom.trim())}
          >
            导出 {count} 条
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionCard({
  active, onClick, title, description,
}: { active: boolean; onClick: () => void; title: string; description: string }) {
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
