import { useEffect, useMemo, useState } from 'react';
import { get, post, upload } from '@/api/client';
import { useFeedback } from '@/components/FeedbackProvider';
import { FileTrigger } from '@/components/FileTrigger';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

interface OpenAiOAuthStartResponse {
  authUrl: string;
  redirectUri: string;
}

interface ManagedOpenAiOAuthFile {
  email: string;
  filename: string;
  path: string;
  savedAt: string;
  sizeBytes: number;
  format?: 'auth-pusher' | 'team-auto';
  planType?: string;
  parseOk: boolean;
  parseError?: string;
  matchedChannelId?: string;
  matchedChannelName?: string;
  matchedRemoteId?: string;
  matchStatus?: string;
  matchError?: string;
  syncStatus: string;
  canRemoteUpdate: boolean;
  lastMatchedAt?: string;
  lastRemoteUpdatedAt?: string;
  lastRemoteUpdateStatus?: string;
  lastRemoteUpdateError?: string;
}

interface ManagedOpenAiOAuthFilesResponse {
  directory: string;
  files: ManagedOpenAiOAuthFile[];
}

interface ImportFilesResponse {
  imported: number;
  failed: number;
  files: Array<{
    originalName: string;
    status: 'imported' | 'failed';
    email?: string;
    path?: string;
    error?: string;
  }>;
}

interface MatchResponse {
  matched: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
}

interface UpdateResponse {
  dryRun: boolean;
  updated: number;
  skipped: number;
  failed: number;
  items: Array<{
    path: string;
    email: string;
    status: 'updated' | 'would_update' | 'skipped' | 'failed';
    channelName?: string;
    remoteId?: string;
    error?: string;
  }>;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function syncStatusMeta(status: string): { label: string; variant: 'muted' | 'info' | 'warning' | 'success' | 'destructive' } {
  switch (status) {
    case 'ready':
      return { label: '可更新', variant: 'info' };
    case 'synced':
      return { label: '已同步', variant: 'success' };
    case 'unmatched':
      return { label: '未匹配', variant: 'warning' };
    case 'ambiguous':
      return { label: '多池冲突', variant: 'warning' };
    case 'remote_missing':
      return { label: '远端缺失', variant: 'warning' };
    case 'unsupported_channel':
      return { label: '渠道不支持', variant: 'destructive' };
    case 'channel_error':
      return { label: '渠道异常', variant: 'destructive' };
    case 'parse_error':
      return { label: '解析失败', variant: 'destructive' };
    default:
      return { label: '待匹配', variant: 'muted' };
  }
}

function formatMatch(file: ManagedOpenAiOAuthFile): string {
  if (file.matchedChannelName && file.matchedRemoteId) return `${file.matchedChannelName} / #${file.matchedRemoteId}`;
  if (file.matchedChannelName) return file.matchedChannelName;
  if (file.matchError) return file.matchError;
  return '未匹配';
}

export default function OpenAiOAuthPage() {
  const { notify, confirm } = useFeedback();
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState<ManagedOpenAiOAuthFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function loadFiles() {
    setLoading(true);
    try {
      const result = await get<ManagedOpenAiOAuthFilesResponse>('/openai-auth/files');
      setDirectory(result.directory);
      setFiles(result.files);
    } catch (err) {
      notify({ tone: 'error', title: '读取 OAuth 文件失败', description: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFiles();
  }, []);

  useEffect(() => {
    setSelected((current) => {
      const next = new Set<string>();
      for (const item of current) {
        if (files.some((file) => file.path === item)) next.add(item);
      }
      return next;
    });
  }, [files]);

  const selectedPaths = useMemo(() => Array.from(selected), [selected]);
  const selectedFiles = useMemo(
    () => files.filter((file) => selected.has(file.path)),
    [files, selected],
  );
  const readySelectedCount = selectedFiles.filter((file) => file.canRemoteUpdate).length;
  const allSelected = files.length > 0 && selected.size === files.length;
  const statusSummary = useMemo(() => {
    return files.reduce<Record<string, number>>((acc, file) => {
      acc[file.syncStatus] = (acc[file.syncStatus] ?? 0) + 1;
      return acc;
    }, {});
  }, [files]);

  async function handleStart() {
    setStarting(true);
    try {
      const result = await post<OpenAiOAuthStartResponse>('/openai-auth/start', {
        returnTo: `${window.location.origin}/oauth-capture`,
      });
      notify({
        tone: 'info',
        title: '即将跳转 OpenAI 授权',
        description: `回调地址：${result.redirectUri}`,
      });
      window.location.assign(result.authUrl);
    } catch (err) {
      notify({ tone: 'error', title: '发起授权失败', description: (err as Error).message });
    } finally {
      setStarting(false);
    }
  }

  async function handleImport(nextFiles: FileList | null) {
    if (!nextFiles || nextFiles.length === 0) return;
    setImporting(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < nextFiles.length; i += 1) {
        formData.append('files', nextFiles[i]);
      }
      const result = await upload<ImportFilesResponse>('/openai-auth/import-files', formData);
      notify({
        tone: result.failed > 0 ? 'info' : 'success',
        title: 'JSON 导入完成',
        description: `成功 ${result.imported} 个，失败 ${result.failed} 个`,
      });
      await loadFiles();
    } catch (err) {
      notify({ tone: 'error', title: '导入 JSON 失败', description: (err as Error).message });
    } finally {
      setImporting(false);
    }
  }

  async function handleMatchSelected() {
    if (selectedPaths.length === 0) {
      notify({ tone: 'error', title: '请先选择 JSON 文件' });
      return;
    }

    setMatching(true);
    try {
      const result = await post<MatchResponse>('/openai-auth/match', { filePaths: selectedPaths });
      notify({
        tone: result.failed > 0 ? 'info' : 'success',
        title: '号池匹配完成',
        description: `命中 ${result.matched}，未匹配 ${result.unmatched}，冲突 ${result.ambiguous}，失败 ${result.failed}`,
      });
      await loadFiles();
    } catch (err) {
      notify({ tone: 'error', title: '匹配号池失败', description: (err as Error).message });
    } finally {
      setMatching(false);
    }
  }

  async function handleUpdateSelected(dryRun: boolean) {
    if (selectedPaths.length === 0) {
      notify({ tone: 'error', title: '请先选择 JSON 文件' });
      return;
    }

    if (!dryRun) {
      const accepted = await confirm({
        title: '更新远端号池',
        description: `将尝试更新 ${selectedPaths.length} 个 JSON 对应的远端账号。已成功同步且未变化的文件会自动跳过。`,
        confirmText: '开始更新',
      });
      if (!accepted) return;
    }

    const setter = dryRun ? setDryRunning : setUpdating;
    setter(true);
    try {
      const result = await post<UpdateResponse>('/openai-auth/update-remote', {
        filePaths: selectedPaths,
        dryRun,
      });
      const tone = result.failed > 0 ? 'info' : 'success';
      const title = dryRun ? '模拟更新完成' : '远端更新完成';
      const description = dryRun
        ? `可更新 ${result.items.filter((item) => item.status === 'would_update').length} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个`
        : `更新 ${result.updated} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个`;
      notify({ tone, title, description });
      await loadFiles();
    } catch (err) {
      notify({ tone: 'error', title: dryRun ? '模拟更新失败' : '远端更新失败', description: (err as Error).message });
    } finally {
      setter(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div>
              <h2 className="text-lg font-semibold">OpenAI OAuth 采集与号池更新</h2>
              <p className="text-sm text-muted-foreground mt-1">
                采集后的 JSON 会落到当前项目目录，也可以额外导入 `team-auto` 的凭证 JSON。匹配时优先走本地账号的 `sourceChannelId`，不是按渠道名字硬匹配。
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1">
              <div>统一目录</div>
              <div className="font-mono text-xs break-all text-muted-foreground">
                {directory || 'data/openai-oauth-json'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => { void handleStart(); }} loading={starting}>
              {starting ? '跳转中...' : '开始 OpenAI 授权'}
            </Button>
            <FileTrigger accept=".json,application/json" multiple onFiles={(value) => { void handleImport(value); }} disabled={importing}>
              {importing ? '导入中...' : '导入外部 JSON'}
            </FileTrigger>
            <Button variant="outline" onClick={() => { void loadFiles(); }} loading={loading}>
              {loading ? '刷新中...' : '刷新列表'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="info">回调文件名 = 邮箱.json</Badge>
          <Badge variant="muted">支持当前项目 JSON 与 team-auto 凭证 JSON</Badge>
          <Badge variant="muted">远端更新成功后，同内容 JSON 会被锁定，直到文件再次变化</Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="info">待匹配 {statusSummary.pending_match ?? 0}</Badge>
          <Badge variant="success">已同步 {statusSummary.synced ?? 0}</Badge>
          <Badge variant="warning">可更新 {statusSummary.ready ?? 0}</Badge>
          <Badge variant="warning">未匹配 {statusSummary.unmatched ?? 0}</Badge>
          <Badge variant="destructive">异常 {(
            (statusSummary.parse_error ?? 0)
            + (statusSummary.channel_error ?? 0)
            + (statusSummary.unsupported_channel ?? 0)
          )}</Badge>
        </div>
      </Card>

      <Card className="p-0">
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">JSON 列表</h3>
            <p className="text-xs text-muted-foreground mt-1">
              先勾选文件，再点“匹配号池”。建议先跑一次“模拟远端更新”，确认不会误命中之后再做正式更新。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { void handleMatchSelected(); }} loading={matching} disabled={selectedPaths.length === 0}>
              {matching ? '匹配中...' : '匹配号池'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { void handleUpdateSelected(true); }} loading={dryRunning} disabled={selectedPaths.length === 0}>
              {dryRunning ? '模拟中...' : '模拟远端更新'}
            </Button>
            <Button size="sm" variant="primary" onClick={() => { void handleUpdateSelected(false); }} loading={updating} disabled={selectedPaths.length === 0 || readySelectedCount === 0}>
              {updating ? '更新中...' : '更新远端号池'}
            </Button>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">
            {loading ? '读取中...' : '当前还没有 OAuth JSON 文件'}
          </div>
        ) : (
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelected(new Set());
                        else setSelected(new Set(files.map((file) => file.path)));
                      }}
                    />
                  </TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>来源格式</TableHead>
                  <TableHead>号池匹配</TableHead>
                  <TableHead>同步状态</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead>路径</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => {
                  const syncMeta = syncStatusMeta(file.syncStatus);
                  return (
                    <TableRow key={file.path}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(file.path)}
                          onChange={() => {
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(file.path)) next.delete(file.path);
                              else next.add(file.path);
                              return next;
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell className="max-w-[240px]">
                        <div className="text-xs font-medium truncate">{file.email}</div>
                        {!file.parseOk && (
                          <div className="text-[11px] text-destructive mt-1 break-all">{file.parseError}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{file.planType || '-'}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant={file.format === 'team-auto' ? 'warning' : 'muted'}>
                          {file.format === 'team-auto' ? 'team-auto' : file.format === 'auth-pusher' ? 'auth-pusher' : '未知'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[240px]">
                        <div className="text-xs">{formatMatch(file)}</div>
                        {file.lastMatchedAt && (
                          <div className="text-[11px] text-muted-foreground mt-1">
                            匹配于 {new Date(file.lastMatchedAt).toLocaleString()}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <div className="flex flex-wrap gap-2 items-center">
                          <Badge variant={syncMeta.variant}>{syncMeta.label}</Badge>
                          {file.canRemoteUpdate && <Badge variant="info">可推远端</Badge>}
                        </div>
                        {(file.lastRemoteUpdatedAt || file.lastRemoteUpdateError) && (
                          <div className="text-[11px] text-muted-foreground mt-1 break-all">
                            {file.lastRemoteUpdatedAt ? `上次远端更新: ${new Date(file.lastRemoteUpdatedAt).toLocaleString()}` : ''}
                            {file.lastRemoteUpdateError ? ` ${file.lastRemoteUpdateError}` : ''}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        <div>{new Date(file.savedAt).toLocaleString()}</div>
                        <div className="text-muted-foreground mt-1">{formatBytes(file.sizeBytes)}</div>
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground">
                        {file.path}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
