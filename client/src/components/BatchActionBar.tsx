import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, Tag, Ban, CheckCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BatchActionBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBatchTag?: () => void;
  onBatchDisable?: () => void;
  onBatchEnable?: () => void;
  onBatchDelete?: () => void;
  onBatchRefresh?: () => void;
  batchRefreshing?: boolean;
  onBatchRestore?: () => void;
  className?: string;
}

export function BatchActionBar({
  selectedCount,
  onClearSelection,
  onBatchTag,
  onBatchDisable,
  onBatchEnable,
  onBatchDelete,
  onBatchRefresh,
  batchRefreshing,
  onBatchRestore,
  className,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        'fixed bottom-6 left-1/2 -translate-x-1/2 z-50',
        'bg-card border border-border rounded-lg shadow-lg',
        'p-3 flex items-center gap-3',
        'animate-in slide-in-from-bottom-4 duration-300',
        className
      )}
    >
      <Badge variant="info" className="px-3 py-1">
        已选 {selectedCount} 项
      </Badge>

      <div className="h-5 w-px bg-border" />

      {onBatchTag && (
        <Button
          size="sm"
          variant="outline"
          onClick={onBatchTag}
          className="gap-2"
        >
          <Tag className="h-3.5 w-3.5" />
          批量标签
        </Button>
      )}

      {onBatchDisable && (
        <Button
          size="sm"
          variant="outline"
          onClick={onBatchDisable}
          className="gap-2"
        >
          <Ban className="h-3.5 w-3.5" />
          批量禁用
        </Button>
      )}

      {onBatchEnable && (
        <Button
          size="sm"
          variant="outline"
          onClick={onBatchEnable}
          className="gap-2"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          批量启用
        </Button>
      )}

      {onBatchRestore && (
        <Button
          size="sm"
          variant="outline"
          onClick={onBatchRestore}
          className="gap-2"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          恢复
        </Button>
      )}

      {onBatchRefresh && (
        <Button
          size="sm"
          variant="outline"
          onClick={onBatchRefresh}
          loading={batchRefreshing}
          className="gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新 Token
        </Button>
      )}

      {onBatchDelete && (
        <Button
          size="sm"
          variant="destructive"
          onClick={onBatchDelete}
          className="gap-2"
        >
          <Trash2 className="h-3.5 w-3.5" />
          批量删除
        </Button>
      )}

      <div className="h-5 w-px bg-border" />

      <Button
        size="sm"
        variant="ghost"
        onClick={onClearSelection}
      >
        取消
      </Button>
    </div>
  );
}
