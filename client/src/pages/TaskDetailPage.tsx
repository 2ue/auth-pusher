import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { get, post } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
import Pagination from '../components/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TASK_ITEM_STATUS_MAP } from '@/constants/task';

interface TaskItem {
  index: number;
  identifier: string;
  status: string;
  pushResult?: {
    ok: boolean;
    statusCode: number;
    externalId: string;
    error: string;
    durationMs: number;
  };
}

interface Task {
  id: string;
  channelId: string;
  channelName: string;
  pusherType: string;
  status: string;
  totalItems: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  completedAt?: string;
  items: TaskItem[];
}

export default function TaskDetailPage() {
  const { confirm, notify } = useFeedback();
  const { id } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [filter, setFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [itemPage, setItemPage] = useState(0);
  const [itemPageSize, setItemPageSize] = useState(10);
  const [retrying, setRetrying] = useState(false);
  const [files, setFiles] = useState<{ id: string; batchId: string; originalName: string; size: number; uploadedAt: string }[]>([]);

  const load = () => {
    if (id) {
      get<Task>(`/push/tasks/${id}`).then(setTask);
      get<typeof files>(`/files?taskId=${id}`).then(setFiles).catch(() => {});
    }
  };

  useEffect(load, [id]);

  if (!task) return <p className="text-muted-foreground">加载中...</p>;

  const failedItems = task.items.filter((i) => i.status === 'failed');
  const filteredItems = filter === 'all'
    ? task.items
    : task.items.filter((i) => i.status === filter);

  const handleExportFailed = () => {
    const data = failedItems.map((i) => ({
      identifier: i.identifier,
      error: i.pushResult?.error ?? '',
      statusCode: i.pushResult?.statusCode ?? 0,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `failed-${task.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetryFailed = async () => {
    if (failedItems.length === 0) return;
    const accepted = await confirm({
      title: '重试失败项',
      description: `重试 ${failedItems.length} 个失败项，并重新推送到当前渠道。`,
      confirmText: '开始重试',
    });
    if (!accepted) return;
    setRetrying(true);
    try {
      const res = await post<{ taskIds: string[] }>(`/push/tasks/${task.id}/retry-failed`, {});
      if (res.taskIds?.length > 0) navigate(`/tasks/${res.taskIds[0]}`);
    } catch (err) {
      notify({ tone: 'error', title: '重试失败', description: (err as Error).message });
    } finally { setRetrying(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">任务详情</h2>
        <Link to="/tasks"><Button size="sm">返回列表</Button></Link>
      </div>

      <Card className="mb-4 p-5">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <div className="text-muted-foreground text-xs">渠道</div>
            <div className="font-semibold">{task.channelName}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">类型</div>
            <Badge variant="info">{task.pusherType}</Badge>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">状态</div>
            <Badge variant={task.status === 'completed' ? 'success' : task.status === 'failed' ? 'destructive' : 'info'}>
              {task.status}
            </Badge>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">时间</div>
            <div className="text-sm">{new Date(task.createdAt).toLocaleString()}</div>
          </div>
        </div>

        <div className="flex gap-3 mt-4">
          <div className="px-4 py-2 bg-success/10 rounded-md text-center">
            <span className="font-bold text-success">{task.successCount}</span> 成功
          </div>
          <div className="px-4 py-2 bg-destructive/10 rounded-md text-center">
            <span className="font-bold text-destructive">{task.failedCount}</span> 失败
          </div>
          <div className="px-4 py-2 bg-muted rounded-md text-center">
            <span className="font-bold">{task.totalItems}</span> 总计
          </div>
        </div>

        {files.length > 0 && (() => {
          const batchId = files[0]?.batchId;
          return (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-muted-foreground text-xs">关联文件 ({files.length} 个)</span>
                {batchId && files.length > 1 && (
                  <a href={`/api/files/batch/${batchId}/download`} download>
                    <Button variant="primary" size="sm">打包下载 (ZIP)</Button>
                  </a>
                )}
                {files.length === 1 && (
                  <a href={`/api/files/${files[0].id}/download`} download>
                    <Button variant="primary" size="sm">下载</Button>
                  </a>
                )}
              </div>
              <div className="max-h-[200px] overflow-auto text-sm">
                {files.map((f) => (
                  <div key={f.id} className="flex items-center justify-between py-1">
                    <span className="text-muted-foreground">{f.originalName} ({(f.size / 1024).toFixed(1)} KB)</span>
                    <a href={`/api/files/${f.id}/download`} className="text-xs text-primary hover:underline" download>单独下载</a>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {failedItems.length > 0 && task.status === 'completed' && (
          <div className="flex gap-2 mt-4 pt-4 border-t border-border">
            <Button size="sm" variant="primary" onClick={handleRetryFailed} loading={retrying}>
              {retrying ? '重试中...' : `重试失败项 (${failedItems.length})`}
            </Button>
            <Button size="sm" onClick={handleExportFailed}>
              导出失败项
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-0">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex gap-2">
            {(['all', 'success', 'failed'] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? 'primary' : 'default'}
                onClick={() => { setFilter(f); setItemPage(0); }}
              >
                {f === 'all' ? '全部' : f === 'success' ? '成功' : '失败'} ({
                  f === 'all' ? task.items.length
                  : task.items.filter((i) => i.status === f).length
                })
              </Button>
            ))}
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>标识</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>HTTP</TableHead>
              <TableHead>外部ID</TableHead>
              <TableHead>错误</TableHead>
              <TableHead>耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.slice(itemPage * itemPageSize, (itemPage + 1) * itemPageSize).map((item) => {
              const s = TASK_ITEM_STATUS_MAP[item.status] ?? TASK_ITEM_STATUS_MAP.pending;
              return (
                <TableRow key={item.index}>
                  <TableCell>{item.index + 1}</TableCell>
                  <TableCell className="max-w-[200px] overflow-hidden text-ellipsis">{item.identifier}</TableCell>
                  <TableCell><Badge variant={s.variant}>{s.label}</Badge></TableCell>
                  <TableCell className="text-xs">{item.pushResult?.statusCode || '-'}</TableCell>
                  <TableCell className="text-xs">{item.pushResult?.externalId || '-'}</TableCell>
                  <TableCell className="text-xs text-destructive max-w-[250px] overflow-hidden text-ellipsis">
                    {item.pushResult?.error || '-'}
                  </TableCell>
                  <TableCell className="text-xs">{item.pushResult?.durationMs ? `${item.pushResult.durationMs}ms` : '-'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Pagination page={itemPage} pageSize={itemPageSize} total={filteredItems.length} onPageChange={setItemPage} onPageSizeChange={setItemPageSize} />
      </Card>
    </div>
  );
}
