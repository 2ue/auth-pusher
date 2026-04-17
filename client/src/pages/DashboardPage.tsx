import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../api/client';
import { formatCompactNumber } from '../utils/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { QuickPushCard } from '@/components/QuickPushCard';

interface Stats {
  total: number; byPlanType: Record<string, number>;
  bySourceType: Record<string, number>;
  expired: number; expiringSoon: number; disabled: number; recentImported: number;
}
interface Channel {
  id: string; name: string; pusherType: string; enabled: boolean;
  pusherConfig?: Record<string, unknown>;
  capabilities?: { syncable: boolean; fetchRemote: boolean };
  defaultAccountFilter?: {
    planType?: string;
    excludeDisabled?: boolean;
    excludeExpired?: boolean;
  };
}
interface TaskSummary {
  id: string; channelName: string; pusherType: string; status: string;
  totalItems: number; successCount: number; failedCount: number; createdAt: string;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      get<Stats>('/accounts/stats').then(setStats),
      get<Channel[]>('/channels').then(setChannels),
      get<TaskSummary[]>('/push/tasks').then((t) => setTasks(t.slice(0, 5))),
    ]).finally(() => setLoading(false));
  }, []);

  const enabledChannels = channels.filter((c) => c.enabled);
  const planTypes = stats ? Object.entries(stats.byPlanType).sort(([, a], [, b]) => b - a) : [];
  const channelColumns = enabledChannels.length >= 6 ? 6 : Math.max(enabledChannels.length, 1);

  if (loading) {
    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-primary">
            <span className="opacity-40">&gt; </span>仪表盘
          </h1>
        </div>
        <LoadingSpinner text="加载中..." className="py-20" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold text-primary">
          <span className="opacity-40">&gt; </span>仪表盘
        </h1>
        <Badge variant="success">系统在线</Badge>
      </div>

      {/* 渠道总览 */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">渠道总览</span>
          <Link to="/channels"><Button variant="default" size="sm">管理渠道</Button></Link>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${channelColumns}, minmax(0, 1fr))` }}>
          {enabledChannels.map((ch) => (
            <Card
              key={ch.id}
              className="p-3.5 cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => navigate(`/accounts?channel=${ch.id}`)}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-semibold text-sm">{ch.name}</span>
                <Badge variant="info" className="text-[10px]">{ch.pusherType}</Badge>
              </div>
              {ch.capabilities?.syncable && (
                <div className="text-xs text-muted-foreground">
                  {ch.capabilities.fetchRemote ? '同步+远端' : '同步'}
                </div>
              )}
            </Card>
          ))}
          {enabledChannels.length === 0 && (
            <Card className="p-5 text-center col-span-full">
              <span className="text-muted-foreground">暂无渠道</span>
            </Card>
          )}
        </div>
      </div>

      {/* 号池统计 */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">号池统计</span>
          <Link to="/accounts"><Button variant="default" size="sm">号池管理</Button></Link>
        </div>
        <div className="flex gap-3">
          {[
            { label: '总计', value: stats?.total ?? 0, color: 'text-primary' },
            ...planTypes.map(([pt, count]) => ({
              label: pt, value: count,
              color: pt === 'plus' ? 'text-primary' : pt === 'pro' ? 'text-success' : 'text-foreground',
            })),
            { label: '本地', value: stats?.bySourceType?.local ?? 0, color: 'text-foreground' },
            { label: '远端', value: stats?.bySourceType?.remote ?? 0, color: 'text-info' },
            { label: '今日', value: stats?.recentImported ?? 0, color: 'text-success' },
            { label: '即将过期', value: stats?.expiringSoon ?? 0, color: stats?.expiringSoon ? 'text-warning' : 'text-muted-foreground' },
            { label: '已过期', value: stats?.expired ?? 0, color: stats?.expired ? 'text-destructive' : 'text-muted-foreground' },
            { label: '已禁用', value: stats?.disabled ?? 0, color: stats?.disabled ? 'text-destructive' : 'text-muted-foreground' },
          ].map((item) => (
            <Card key={item.label} className="flex-1 p-4 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-1">{item.label}</div>
              <div className={`text-2xl font-bold ${item.color}`} title={String(item.value)}>
                {formatCompactNumber(item.value)}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* 快捷推送 */}
      {enabledChannels.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">快捷推送</span>
            <Link to="/push"><Button variant="default" size="sm">推送页</Button></Link>
          </div>
          <QuickPushCard channels={enabledChannels} />
        </div>
      )}

      {/* 最近任务 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">最近任务</span>
          <Link to="/tasks"><Button variant="default" size="sm">查看全部</Button></Link>
        </div>
        {tasks.length === 0 ? (
          <Card className="text-center p-6">
            <span className="text-muted-foreground">暂无推送记录</span>
          </Card>
        ) : (
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>渠道</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead className="w-[60px]">-</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.channelName}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === 'completed' ? 'success' : t.status === 'running' ? 'info' : 'destructive'}>
                        {t.status === 'completed' ? '完成' : t.status === 'running' ? '执行中' : '失败'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-success">{t.successCount}</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">{t.failedCount}</span>
                      <span className="text-muted-foreground"> / {t.totalItems}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{new Date(t.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Link to={`/tasks/${t.id}`}>
                        <Button variant="ghost" size="sm">&gt;</Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

    </div>
  );
}
