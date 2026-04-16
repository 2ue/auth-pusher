import { useState } from 'react';
import type { QuotaResult } from '../utils/calcQuota';
import { formatCompactNumber } from '../utils/format';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Info } from 'lucide-react';

interface Stats { total: number; byPlanType: Record<string, number>; expired: number; disabled: number; }

const QUOTA_INFO = `额度统计说明：
- 当前可用：此刻立即还能使用的刀数
- 1h 额度：未来 1 小时可用刀数，考虑 5h 窗口即将重置的账号
- 5h 额度：未来 5 小时可用刀数（所有 5h 窗口将至少重置一次）
- 7d 额度：当前 7 天窗口剩余刀数
- 1 周额度：等于 7d 剩余刀数（窗口期内不会重置）
- 1 月额度：7d 剩余刀数 x 4.3（月内约 4.3 次 7d 窗口重置）
- 限流账号视为 100% 已用
- 刀数 = 剩余额度数 x 设置中的每额度刀数`;

export default function QuotaPanel({ quota, stats, quotaTime, loading, disabled, onRefreshQuota, deletedCount, onFilterPlanType, activePlanType }: {
  quota: QuotaResult | null;
  stats: Stats | null;
  quotaTime: string;
  loading: boolean;
  disabled: boolean;
  onRefreshQuota: () => void;
  deletedCount: number;
  onFilterPlanType: (pt: string) => void;
  activePlanType: string;
}) {
  const [showInfo, setShowInfo] = useState(false);

  const items = [
    { label: '当前可用', value: quota?.availableNow, color: quota ? (quota.availableNow > 0 ? 'text-success' : 'text-destructive') : undefined },
    { label: '1h 额度', value: quota?.oneHour, color: 'text-primary' },
    { label: '5h 额度', value: quota?.fiveHour, color: 'text-primary' },
    { label: '7d 额度', value: quota?.sevenDay, color: quota ? (quota.sevenDay > 0 ? 'text-success' : 'text-destructive') : undefined },
    { label: '1 周额度', value: quota?.oneWeek, color: 'text-primary' },
    { label: '1 月额度', value: quota?.oneMonth, color: 'text-primary' },
  ];

  return (
    <Card className="mb-4 p-4">
      {/* 额度统计 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">额度统计</span>
          {quotaTime && <span className="text-muted-foreground text-xs">归档于 {quotaTime}</span>}
          <button
            onClick={() => setShowInfo(!showInfo)}
            title="统计说明"
            className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-border hover:border-primary text-xs text-muted-foreground hover:text-primary cursor-pointer"
          >
            <Info className="h-3 w-3" />
          </button>
        </div>
        <Button variant="default" size="sm" onClick={onRefreshQuota} disabled={loading || disabled}>
          {loading ? '统计中...' : quota ? '更新用量与额度' : '开始统计'}
        </Button>
      </div>
      {showInfo && (
        <div className="mb-3 p-3 bg-muted rounded-md text-xs text-muted-foreground whitespace-pre-line leading-relaxed border border-border">{QUOTA_INFO}</div>
      )}
      <div className="flex gap-3 mb-3">
        <div className="flex-[0.8] text-center">
          <div className="text-xl font-bold" title={stats?.total != null ? String(stats.total) : undefined}>
            {stats?.total != null ? formatCompactNumber(stats.total) : '--'}
          </div>
          <div className="text-muted-foreground text-xs">总账号</div>
          {quota?.totalAccounts != null && quota.totalAccounts !== (stats?.total ?? 0) && (
            <div className="text-muted-foreground text-[10px]">{quota.totalAccounts} 个已检测</div>
          )}
        </div>
        {items.map((it) => (
          <div key={it.label} className="flex-1 text-center">
            <div
              className={cn('text-xl font-bold', it.color ?? 'text-muted-foreground')}
              title={it.value != null ? String(it.value) : undefined}
            >
              {it.value != null ? formatCompactNumber(it.value) : '--'}
            </div>
            <div className="text-muted-foreground text-xs">{it.label}{it.value != null ? ' 刀' : ''}</div>
          </div>
        ))}
      </div>

      {/* 账号分布 */}
      {(() => {
        const pt = stats?.byPlanType ?? {};
        const distItems = [
          { key: '', label: '全部', value: stats?.total ?? 0 },
          { key: 'free', label: 'free', value: pt['free'] ?? 0 },
          { key: 'plus', label: 'plus', value: pt['plus'] ?? 0 },
          { key: 'pro', label: 'pro', value: pt['pro'] ?? 0 },
          { key: 'team', label: 'team', value: pt['team'] ?? 0 },
          { key: '_expired', label: '已过期', value: stats?.expired ?? 0 },
          { key: '_disabled', label: '已禁用', value: stats?.disabled ?? 0 },
          { key: '_deleted', label: '远端已删除', value: deletedCount },
        ];
        return (
          <div className="flex gap-2 pt-3 border-t border-border">
            {distItems.map((it) => {
              const isFilter = !it.key.startsWith('_');
              const active = isFilter && activePlanType === it.key;
              return (
                <div
                  key={it.key}
                  className={cn(
                    'flex-1 text-center py-2 px-1 rounded-md transition-colors',
                    isFilter && 'cursor-pointer hover:bg-muted',
                    active && 'bg-primary/10 ring-1 ring-primary',
                    !isFilter && 'cursor-default',
                  )}
                  onClick={isFilter ? () => onFilterPlanType(active ? '' : it.key) : undefined}
                >
                  <div className="text-lg font-bold" title={String(it.value)}>
                    {formatCompactNumber(it.value)}
                  </div>
                  <div className="text-xs text-muted-foreground uppercase">{it.label}</div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </Card>
  );
}
