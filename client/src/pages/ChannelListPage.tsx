import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, del } from '../api/client';
import Pagination from '../components/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface Channel {
  id: string;
  name: string;
  pusherType: string;
  enabled: boolean;
  updatedAt: string;
  capabilities?: { syncable: boolean; fetchRemote: boolean };
}

export default function ChannelListPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ msg: string; onOk: () => void } | null>(null);
  const navigate = useNavigate();

  const load = () => {
    get<Channel[]>('/channels').then(setChannels).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = (id: string, name: string) => {
    setConfirmDialog({
      msg: `确认删除渠道「${name}」？`,
      onOk: async () => { await del(`/channels/${id}`); setConfirmDialog(null); load(); },
    });
  };

  const handleHealthCheck = async (id: string, name: string) => {
    setCheckingId(id);
    try {
      const result = await post<{ ok: boolean; statusCode?: number; latencyMs: number; error?: string }>(`/channels/${id}/health-check`, {});
      const msg = result.ok
        ? `渠道「${name}」连通正常，延迟 ${result.latencyMs}ms (HTTP ${result.statusCode})`
        : `渠道「${name}」连通失败: ${result.error ?? `HTTP ${result.statusCode}`}`;
      setConfirmDialog({ msg, onOk: () => setConfirmDialog(null) });
    } catch (e) {
      setConfirmDialog({ msg: `检查失败: ${(e as Error).message}`, onOk: () => setConfirmDialog(null) });
    } finally {
      setCheckingId(null);
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      const result = await post<{ added: number; updated: number; deleted: number; total: number }>(`/channels/${id}/sync`, {});
      setConfirmDialog({ msg: `同步完成: 远端 ${result.total} 个，新增 ${result.added}，更新 ${result.updated}，远端已删除 ${result.deleted}`, onOk: () => setConfirmDialog(null) });
    } catch (e) {
      setConfirmDialog({ msg: `同步失败: ${(e as Error).message}`, onOk: () => setConfirmDialog(null) });
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">渠道管理</h2>
        <Button variant="primary" onClick={() => navigate('/channels/new')}>新建渠道</Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground">加载中...</p>
      ) : channels.length === 0 ? (
        <Card className="text-center p-10">
          <p className="text-muted-foreground mb-3">还没有配置渠道</p>
          <Button variant="primary" onClick={() => navigate('/channels/new')}>创建第一个渠道</Button>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>推送类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="w-[240px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.slice(page * pageSize, (page + 1) * pageSize).map((ch) => (
                <TableRow key={ch.id}>
                  <TableCell><Link to={`/channels/${ch.id}`} className="text-primary hover:underline">{ch.name}</Link></TableCell>
                  <TableCell><Badge variant="info">{ch.pusherType}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={ch.enabled ? 'success' : 'muted'}>
                      {ch.enabled ? '启用' : '禁用'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{new Date(ch.updatedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleHealthCheck(ch.id, ch.name)}
                        loading={checkingId === ch.id} title="测试连通性">
                        检测
                      </Button>
                      {ch.capabilities?.fetchRemote && (
                        <Button size="sm" onClick={() => navigate(`/accounts?channel=${ch.id}`)}>号池</Button>
                      )}
                      {ch.capabilities?.syncable && (
                        <Button size="sm" onClick={() => handleSync(ch.id)}
                          loading={syncingId === ch.id} title="从该渠道同步账号到本地号池">
                          {syncingId === ch.id ? '同步中...' : '同步'}
                        </Button>
                      )}
                      <Button size="sm" onClick={() => navigate(`/channels/${ch.id}`)}>编辑</Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(ch.id, ch.name)}>删除</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={channels.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </Card>
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        message={confirmDialog?.msg}
        onConfirm={() => confirmDialog?.onOk()}
        onCancel={confirmDialog?.msg.includes('确认') ? () => setConfirmDialog(null) : undefined}
        showCancel={!!confirmDialog?.msg.includes('确认')}
      />
    </div>
  );
}
