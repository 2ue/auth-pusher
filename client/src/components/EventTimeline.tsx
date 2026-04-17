import { useState, useEffect } from 'react';
import { get } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AccountEvent {
  id: string;
  accountId: string;
  email: string;
  eventType: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

const EVENT_META: Record<string, { label: string; variant: 'info' | 'success' | 'destructive' | 'warning' | 'muted' }> = {
  import: { label: '导入', variant: 'info' },
  probe: { label: '检测', variant: 'info' },
  refresh: { label: '刷新', variant: 'info' },
  push: { label: '推送', variant: 'success' },
  delete: { label: '删除', variant: 'destructive' },
  restore: { label: '恢复', variant: 'success' },
  transfer: { label: '转移', variant: 'warning' },
  sync: { label: '同步', variant: 'muted' },
};

function formatDetail(eventType: string, detail: Record<string, unknown>): string {
  switch (eventType) {
    case 'import':
      return `来源: ${detail.source ?? '未知'}`;
    case 'probe': {
      const status = detail.status ?? '';
      if (status === 'ok') return `5h: ${detail.fiveHourUsed ?? '-'}%, 7d: ${detail.sevenDayUsed ?? '-'}%`;
      return `状态: ${status}`;
    }
    case 'refresh': {
      if (detail.status === 'ok') return `成功，新过期: ${detail.newExpiredAt ? new Date(detail.newExpiredAt as string).toLocaleString() : '-'}`;
      return `失败: ${detail.errorMessage ?? detail.status}`;
    }
    case 'push':
      return `${detail.channelName ?? ''} → ${detail.status === 'success' ? '成功' : '失败'}`;
    case 'delete':
      return `原因: ${detail.reason ?? '手动'}`;
    case 'restore':
      return '从回收站恢复';
    case 'transfer':
      return `${detail.fromChannel ?? ''} → ${detail.toChannel ?? ''}`;
    default:
      return JSON.stringify(detail);
  }
}

export function EventTimeline({ accountId }: { accountId: string }) {
  const [events, setEvents] = useState<AccountEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    get<{ events: AccountEvent[]; total: number }>(`/accounts/${accountId}/events?limit=20`)
      .then((res) => { setEvents(res.events); setTotal(res.total); })
      .finally(() => setLoading(false));
  }, [accountId]);

  const loadMore = () => {
    get<{ events: AccountEvent[]; total: number }>(`/accounts/${accountId}/events?limit=20&offset=${events.length}`)
      .then((res) => { setEvents((prev) => [...prev, ...res.events]); setTotal(res.total); });
  };

  if (loading) return <p className="text-xs text-muted-foreground py-2">加载事件...</p>;
  if (events.length === 0) return <p className="text-xs text-muted-foreground py-2">暂无操作记录</p>;

  return (
    <div className="space-y-2">
      {events.map((event) => {
        const meta = EVENT_META[event.eventType] ?? { label: event.eventType, variant: 'muted' as const };
        return (
          <div key={event.id} className="flex items-start gap-3 text-xs">
            <span className="text-muted-foreground whitespace-nowrap shrink-0 w-[130px]">
              {new Date(event.createdAt).toLocaleString()}
            </span>
            <Badge variant={meta.variant} className="shrink-0">{meta.label}</Badge>
            <span className="text-muted-foreground">{formatDetail(event.eventType, event.detail)}</span>
          </div>
        );
      })}
      {events.length < total && (
        <Button size="sm" variant="ghost" onClick={loadMore} className="text-xs">
          加载更多 ({events.length}/{total})
        </Button>
      )}
    </div>
  );
}
