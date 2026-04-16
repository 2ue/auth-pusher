import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import Pagination from '../components/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface TaskSummary {
  id: string;
  channelName: string;
  pusherType: string;
  status: string;
  totalItems: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  completedAt?: string;
}

const statusMap: Record<string, { label: string; variant: 'muted' | 'info' | 'success' | 'destructive' }> = {
  pending: { label: '等待中', variant: 'muted' },
  running: { label: '执行中', variant: 'info' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  cancelled: { label: '已取消', variant: 'muted' },
};

export default function TaskListPage() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    get<TaskSummary[]>('/push/tasks').then(setTasks).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">任务历史</h2>

      {loading ? (
        <p className="text-muted-foreground">加载中...</p>
      ) : tasks.length === 0 ? (
        <Card className="text-center p-10">
          <p className="text-muted-foreground">暂无推送记录</p>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>渠道</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>进度</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.slice(page * pageSize, (page + 1) * pageSize).map((task) => {
                const s = statusMap[task.status] ?? statusMap.pending;
                return (
                  <TableRow key={task.id}>
                    <TableCell>{task.channelName}</TableCell>
                    <TableCell><Badge variant="info">{task.pusherType}</Badge></TableCell>
                    <TableCell><Badge variant={s.variant}>{s.label}</Badge></TableCell>
                    <TableCell className="text-xs">
                      <span className="text-success">{task.successCount}</span>
                      {' / '}
                      <span className="text-destructive">{task.failedCount}</span>
                      {' / '}
                      {task.totalItems}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{new Date(task.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Link to={`/tasks/${task.id}`}>
                        <Button size="sm">详情</Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={tasks.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </Card>
      )}
    </div>
  );
}
