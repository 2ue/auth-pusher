import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, upload } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
import { useSSE } from '../hooks/useSSE';
import { UsageCell } from '../components/UsageBar';
import Pagination from '../components/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TextField } from '@/components/TextField';
import { SelectField } from '@/components/SelectField';
import { FileTrigger } from '@/components/FileTrigger';
import { cn } from '@/lib/utils';

interface Channel {
  id: string; name: string; pusherType: string; enabled: boolean;
  pusherConfig?: Record<string, unknown>;
  defaultAccountFilter?: { planType?: string; excludeDisabled?: boolean; excludeExpired?: boolean };
}
interface PusherSchema {
  type: string; name: string;
  requiredDataFields: string[];
  optionalDataFields: string[];
}
interface ParsedData {
  fileId: string; totalRecords: number;
  sampleRecords: { index: number; fields: Record<string, unknown> }[];
  detectedFields: string[];
  suggestedMapping: Record<string, string>;
  fileType: string; parseWarnings: string[];
  matchedProfileId?: string; matchedProfileName?: string;
  batchId?: string; fileCount?: number;
}
interface DataProfileItem { id: string; name: string; fieldMapping: Record<string, string>; builtin?: boolean; }
interface ParsedRecordPage {
  totalRecords: number;
  records: { index: number; fields: Record<string, unknown> }[];
}
interface ProgressEvent {
  type: 'item_start' | 'item_complete' | 'task_complete' | 'task_error';
  taskId: string; itemIndex?: number; identifier?: string;
  result?: { ok: boolean; statusCode: number; externalId: string; error: string; durationMs: number };
  summary?: { total: number; success: number; failed: number };
}

interface AccountItem { id: string; email: string; planType: string; tags: string[]; disabled: boolean; expiredAt: string; }
interface PoolStats { total: number; byPlanType: Record<string, number>; }
interface UsageSnapshot {
  fiveHourUsed: number; fiveHourResetAt: string;
  sevenDayUsed: number; sevenDayResetAt: string;
}
interface AccountUsageResult {
  email: string; status: 'ok' | 'error' | 'token_invalid' | 'rate_limited';
  usage: UsageSnapshot | null; errorMessage: string;
}
interface BatchUsageResult {
  total: number; probed: number; results: AccountUsageResult[];
}

const STEPS = ['选择渠道', '选择数据', '字段映射', '推送执行'];

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  if (path in obj) return obj[path];

  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pickMappedValue(
  fields: Record<string, unknown>,
  mapping: Record<string, string>,
  standardField: string,
  fallbacks: string[],
): string {
  const mappedPath = mapping[standardField];
  const candidates = [
    mappedPath ? getByPath(fields, mappedPath) : undefined,
    ...fallbacks.map((key) => getByPath(fields, key)),
  ];

  for (const value of candidates) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function decodeTokenClaims(accessToken: string): { email: string; accountId: string; planType: string } {
  const empty = { email: '', accountId: '', planType: '' };
  if (!accessToken) return empty;

  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return empty;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const profile = (payload['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;

    return {
      email: String(profile.email ?? '').trim(),
      accountId: String(auth.chatgpt_account_id ?? '').trim(),
      planType: String(auth.chatgpt_plan_type ?? '').trim(),
    };
  } catch {
    return empty;
  }
}

function extractProbeTarget(
  fields: Record<string, unknown>,
  mapping: Record<string, string>,
): { email: string; accessToken: string; accountId?: string; planType?: string } {
  const accessToken = pickMappedValue(fields, mapping, 'access_token', ['access_token', 'accessToken', 'token']);
  const claims = decodeTokenClaims(accessToken);
  const email = pickMappedValue(fields, mapping, 'email', ['email', 'Email']) || claims.email;
  const accountId = pickMappedValue(fields, mapping, 'account_id', ['account_id', 'accountId']) || claims.accountId;
  const planType = pickMappedValue(fields, mapping, 'plan_type', ['plan_type', 'planType']) || claims.planType;

  return {
    email,
    accessToken,
    accountId: accountId || undefined,
    planType: planType || undefined,
  };
}

export default function PushPage() {
  const { notify } = useFeedback();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(0);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [schemas, setSchemas] = useState<PusherSchema[]>([]);

  // URL 参数自动选中渠道并跳到 Step 2（池模式 + 默认筛选）
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    const channelParam = searchParams.get('channel');
    if (channelParam && channels.length > 0 && !autoSelectedRef.current) {
      const found = channels.find((c) => c.id === channelParam && c.enabled);
      if (found) {
        autoSelectedRef.current = true;
        setSelectedChannelId(found.id);
        setDataSource('pool');
        // 带入渠道默认筛选条件
        if (found.defaultAccountFilter?.planType) {
          setPoolFilter((prev) => ({ ...prev, planType: found.defaultAccountFilter!.planType! }));
        }
        setStep(1);
      }
    }
  }, [searchParams, channels]);
  const [dataSource, setDataSource] = useState<'file' | 'pool'>('file');
  const [groups, setGroups] = useState<{ id: number; name: string; account_count: number }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [planTypeOverride, setPlanTypeOverride] = useState('');
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [filePage, setFilePage] = useState(0);
  const [filePageSize, setFilePageSize] = useState(100);
  const [fileRecords, setFileRecords] = useState<{ index: number; fields: Record<string, unknown> }[]>([]);
  const [filePageLoading, setFilePageLoading] = useState(false);
  const [profiles, setProfiles] = useState<DataProfileItem[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [saveProfileName, setSaveProfileName] = useState('');
  const [saveProfileDesc, setSaveProfileDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [poolAccounts, setPoolAccounts] = useState<AccountItem[]>([]);
  const [poolPage, setPoolPage] = useState(0);
  const [poolPageSize, setPoolPageSize] = useState(10);
  const [poolFilter, setPoolFilter] = useState({ planType: '', tag: '', notPushedTo: '' });
  const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [poolLoading, setPoolLoading] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [probeMap, setProbeMap] = useState<Map<string, AccountUsageResult>>(new Map());
  const [probing, setProbing] = useState(false);
  const [checkDuplicates, setCheckDuplicates] = useState(false);
  const [duplicateResult, setDuplicateResult] = useState<{ duplicates: string[]; unique: string[]; remoteTotal: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [taskId, setTaskId] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [logs, setLogs] = useState<{ identifier: string; ok: boolean; error: string; ms: number }[]>([]);
  const [summary, setSummary] = useState<{ total: number; success: number; failed: number } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    get<Channel[]>('/channels').then(setChannels);
    get<PusherSchema[]>('/pushers').then(setSchemas);
    get<DataProfileItem[]>('/profiles').then(setProfiles);
    get<string[]>('/tags').then(setAllTags);
  }, []);

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);
  const currentSchema = schemas.find((s) => s.type === selectedChannel?.pusherType);

  useEffect(() => {
    if (selectedChannel?.pusherType === 'sub2api' && selectedChannelId) {
      setGroupsLoading(true);
      get<{ id: number; name: string; account_count: number }[]>(`/channels/${selectedChannelId}/groups`)
        .then((gs) => {
          setGroups(gs);
          const existing = String(selectedChannel.pusherConfig?.group_ids ?? '');
          if (existing) {
            const ids = existing.split(',').map(Number).filter((n) => !isNaN(n));
            setSelectedGroupIds(ids);
          }
        })
        .catch(() => setGroups([]))
        .finally(() => setGroupsLoading(false));
    } else { setGroups([]); setSelectedGroupIds([]); }
  }, [selectedChannelId]);

  const allTargetFields = [...(currentSchema?.requiredDataFields ?? []), ...(currentSchema?.optionalDataFields ?? [])];

  const loadPool = () => {
    setPoolLoading(true);
    const params = new URLSearchParams({ disabled: 'false', expired: 'false', limit: '500' });
    if (poolFilter.planType) params.set('planType', poolFilter.planType);
    if (poolFilter.tag) params.set('tags', poolFilter.tag);
    if (poolFilter.notPushedTo) params.set('notPushedTo', poolFilter.notPushedTo);
    Promise.all([
      get<AccountItem[]>(`/accounts?${params}`),
      get<PoolStats>('/accounts/stats'),
    ]).then(([accs, stats]) => {
      setPoolAccounts(accs); setPoolStats(stats);
      setSelectedAccountIds(new Set(accs.map((a) => a.id)));
    }).finally(() => setPoolLoading(false));
  };

  useEffect(() => { if (dataSource === 'pool') { setPoolPage(0); loadPool(); } }, [dataSource, poolFilter.planType, poolFilter.tag, poolFilter.notPushedTo]);

  // 已移除自动探测，改为手动触发

  const handleProfileSelect = (profileId: string) => {
    setSelectedProfileId(profileId);
    if (profileId) { const p = profiles.find((x) => x.id === profileId); if (p) setFieldMapping(p.fieldMapping); }
  };

  const handleSaveProfile = async () => {
    if (!saveProfileName || !parsedData) return;
    setSaving(true);
    try {
      await post('/profiles', { name: saveProfileName, description: saveProfileDesc, fieldMapping, fingerprint: parsedData.detectedFields.slice(0, 10) });
      setShowSaveProfile(false); setSaveProfileName(''); setSaveProfileDesc('');
      get<DataProfileItem[]>('/profiles').then(setProfiles);
    } catch (err) { notify({ tone: 'error', title: '保存模板失败', description: (err as Error).message }); }
    finally { setSaving(false); }
  };

  const triggerProbeByIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    setProbing(true); setProbeMap(new Map());
    try {
      const result = await post<BatchUsageResult>('/accounts/probe', { ids });
      const map = new Map<string, AccountUsageResult>();
      for (const r of result.results) map.set(r.email.toLowerCase(), r);
      setProbeMap(map);
    } catch { /* ignore */ }
    finally { setProbing(false); }
  };

  const loadParsedFilePage = useCallback(async (fileId: string, page: number, pageSize: number) => {
    setFilePageLoading(true);
    try {
      const offset = page * pageSize;
      const result = await get<ParsedRecordPage>(`/data/records/${fileId}?offset=${offset}&limit=${pageSize}`);
      setFileRecords(result.records);
    } catch (err) {
      setUploadError((err as Error).message);
      setFileRecords([]);
    } finally {
      setFilePageLoading(false);
    }
  }, []);

  const handleFileUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploadError(''); setUploading(true);
    try {
      const fd = new FormData();
      fd.append('pusherType', selectedChannel?.pusherType ?? '');
      let data: ParsedData;
      if (fileList.length === 1) { fd.append('file', fileList[0]); data = await upload<ParsedData>('/data/parse', fd); }
      else { for (let i = 0; i < fileList.length; i++) fd.append('files', fileList[i]); data = await upload<ParsedData>('/data/parse-multi', fd); }
      setFilePage(0);
      setProbeMap(new Map());
      setParsedData(data);
      setFieldMapping(data.suggestedMapping);
    } catch (err) { setUploadError((err as Error).message); }
    finally { setUploading(false); }
  };

  useEffect(() => {
    if (dataSource !== 'file' || !parsedData?.fileId) {
      setFileRecords([]);
      return;
    }
    void loadParsedFilePage(parsedData.fileId, filePage, filePageSize);
  }, [dataSource, parsedData?.fileId, filePage, filePageSize, loadParsedFilePage]);

  const handlePush = async () => {
    if (!selectedChannelId) return;
    if (dataSource === 'file' && !parsedData) return;
    if (dataSource === 'pool' && selectedAccountIds.size === 0) return;
    setPushing(true); setLogs([]); setSummary(null);
    try {
      const configOverrides: Record<string, unknown> = {};
      if (selectedChannel?.pusherType === 'sub2api') {
        if (selectedGroupIds.length > 0) configOverrides.group_ids = selectedGroupIds.join(',');
        if (planTypeOverride) configOverrides.plan_type = planTypeOverride;
      }
      const body: Record<string, unknown> = {
        channelIds: [selectedChannelId], dataSource,
        configOverrides: Object.keys(configOverrides).length > 0 ? configOverrides : undefined,
      };
      if (dataSource === 'file') { body.fileId = parsedData!.fileId; body.batchId = parsedData!.batchId; body.fieldMapping = fieldMapping; }
      else { body.accountIds = Array.from(selectedAccountIds); }
      const res = await post<{ taskIds: string[] }>('/push/execute', body);
      if (res.taskIds.length > 0) setTaskId(res.taskIds[0]);
    } catch (err) { setPushing(false); notify({ tone: 'error', title: '推送启动失败', description: (err as Error).message }); }
  };

  const handleSSE = useCallback((event: ProgressEvent) => {
    if (event.type === 'item_complete' && event.result) {
      setLogs((prev) => [...prev, { identifier: event.identifier ?? '', ok: event.result!.ok, error: event.result!.error, ms: event.result!.durationMs }]);
    }
    if (event.type === 'task_complete') { setSummary(event.summary ?? null); setPushing(false); setTaskId(null); }
    if (event.type === 'task_error') { setSummary(event.summary ?? null); setPushing(false); setTaskId(null); }
  }, []);

  useSSE<ProgressEvent>(taskId ? `/api/push/tasks/${taskId}/events` : null, handleSSE);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const totalItems = dataSource === 'file' ? (parsedData?.totalRecords ?? 0) : selectedAccountIds.size;

  const canNext = () => {
    if (step === 0) return !!selectedChannelId;
    if (step === 1) { if (dataSource === 'file') return !!parsedData; return selectedAccountIds.size > 0; }
    if (step === 2) { if (dataSource === 'pool') return true; return (currentSchema?.requiredDataFields ?? []).every((f) => fieldMapping[f]); }
    return false;
  };

  const handleReset = () => { setStep(0); setParsedData(null); setFieldMapping({}); setTaskId(null); setLogs([]); setSummary(null); setPushing(false); };

  return (
    <div>
      {/* Steps */}
      <div className="flex gap-3 mb-4">
        {STEPS.map((s, i) => (
          <div key={i} className={cn(
            'flex-1 text-center py-2.5 text-sm border-b-[3px] transition-colors',
            i <= step ? 'border-primary text-primary' : 'border-border text-muted-foreground',
            i === step && 'font-semibold',
          )}>
            {i + 1}. {s}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 0 && (
        <Card className="p-5 overflow-hidden">
          <h3 className="text-base font-semibold mb-4">选择推送渠道</h3>
          {channels.filter((c) => c.enabled).length === 0 ? (
            <p className="text-muted-foreground">暂无可用渠道，请先 <a href="/channels/new" className="text-primary hover:underline">创建渠道</a></p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {channels.filter((c) => c.enabled).map((ch) => (
                <div
                  key={ch.id}
                  className={cn(
                    'p-4 rounded-lg border-2 cursor-pointer transition-colors',
                    ch.id === selectedChannelId ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                  )}
                  onClick={() => {
                    setSelectedChannelId(ch.id);
                    // Auto-load default account filter from channel
                    if (ch.defaultAccountFilter) {
                      setPoolFilter((f) => ({
                        ...f,
                        planType: ch.defaultAccountFilter?.planType ?? f.planType,
                      }));
                    }
                  }}
                >
                  <div className="font-semibold mb-1">{ch.name}</div>
                  <Badge variant="info">{ch.pusherType}</Badge>
                </div>
              ))}
            </div>
          )}

          {selectedChannel?.pusherType === 'sub2api' && selectedChannelId && (
            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Plan Type（账号类型）</label>
                <SelectField
                  value={planTypeOverride} onChange={setPlanTypeOverride}
                  options={[
                    { value: '', label: '自动（从数据/JWT中读取）' },
                    { value: 'free', label: 'free' }, { value: 'plus', label: 'plus' },
                    { value: 'pro', label: 'pro' }, { value: 'team', label: 'team' },
                  ]}
                  style={{ width: 240 }}
                />
                <p className="text-xs text-muted-foreground mt-1">优先级：手动选择 &gt; 数据字段 plan_type &gt; JWT 解码</p>
              </div>

              <h4 className="text-sm font-semibold">选择推送分组</h4>
              {groupsLoading ? (
                <p className="text-muted-foreground text-xs">拉取分组中...</p>
              ) : groups.length === 0 ? (
                <p className="text-muted-foreground text-xs">未获取到分组，将使用渠道默认配置</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <Button size="sm" onClick={() => setSelectedGroupIds(groups.map((g) => g.id))}>全选</Button>
                    <Button size="sm" onClick={() => setSelectedGroupIds([])}>清空</Button>
                    <span className="text-muted-foreground text-xs leading-7">已选 {selectedGroupIds.length} / {groups.length}</span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 max-h-[300px] overflow-auto">
                    {groups.map((g) => {
                      const checked = selectedGroupIds.includes(g.id);
                      return (
                        <div
                          key={g.id}
                          className={cn(
                            'flex items-center gap-2 p-2 px-3 rounded-md border cursor-pointer transition-colors',
                            checked ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                          )}
                          onClick={() => setSelectedGroupIds((prev) => checked ? prev.filter((x) => x !== g.id) : [...prev, g.id])}
                        >
                          <div className={cn(
                            'h-4 w-4 shrink-0 rounded-sm border shadow-sm flex items-center justify-center',
                            checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input',
                          )}>
                            {checked && <span className="text-[10px]">&#10003;</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{g.name}</div>
                            <div className="text-muted-foreground text-xs">ID:{g.id} / {g.account_count} 账号</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Step 2 */}
      {step === 1 && (
        <Card className="p-5 overflow-hidden">
          <div className="flex gap-2 mb-4">
            {(['pool', 'file'] as const).map((ds) => (
              <Button key={ds} variant={dataSource === ds ? 'primary' : 'default'} onClick={() => setDataSource(ds)}>
                {ds === 'pool' ? '从账号池选择' : '上传文件'}
              </Button>
            ))}
          </div>

          {dataSource === 'pool' && (
            <div>
              <div className="flex gap-2 mb-3 flex-wrap">
                <SelectField
                  value={poolFilter.planType}
                  onChange={(v) => setPoolFilter((f) => ({ ...f, planType: v }))}
                  options={[
                    { value: '', label: '全部类型' },
                    ...Object.keys(poolStats?.byPlanType ?? {}).map((pt) => ({ value: pt, label: `${pt} (${poolStats?.byPlanType[pt] ?? 0})` })),
                  ]}
                  style={{ width: 160 }}
                />
                <SelectField
                  value={poolFilter.tag}
                  onChange={(v) => setPoolFilter((f) => ({ ...f, tag: v }))}
                  options={[{ value: '', label: '全部标签' }, ...allTags.map((t) => ({ value: t, label: t }))]}
                  style={{ width: 160 }}
                />
                <SelectField
                  value={poolFilter.notPushedTo}
                  onChange={(v) => setPoolFilter((f) => ({ ...f, notPushedTo: v }))}
                  options={[
                    { value: '', label: '全部（含已推送）' },
                    ...channels.filter((c) => c.enabled).map((c) => ({ value: c.id, label: `仅未推送到 ${c.name}` })),
                  ]}
                  style={{ width: 180 }}
                />
                <span className="text-muted-foreground text-xs leading-9">
                  {poolLoading ? '加载中...' : `${poolAccounts.length} 个可用账号，已选 ${selectedAccountIds.size} 个`}
                </span>
                <Button size="sm" onClick={() => setSelectedAccountIds(new Set(poolAccounts.map((a) => a.id)))}>全选</Button>
                <Button size="sm" onClick={() => setSelectedAccountIds(new Set())}>清空</Button>
                <Button size="sm" onClick={() => triggerProbeByIds([...selectedAccountIds])} loading={probing} disabled={selectedAccountIds.size === 0}>检测用量</Button>
              </div>
              {poolAccounts.length === 0 && !poolLoading ? (
                <p className="text-muted-foreground text-center py-5">
                  账号池为空，请先到 <a href="/accounts" className="text-primary hover:underline">账号池</a> 导入数据
                </p>
              ) : (
                <div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={selectedAccountIds.size === poolAccounts.length && poolAccounts.length > 0}
                            onCheckedChange={() => {
                              if (selectedAccountIds.size === poolAccounts.length) setSelectedAccountIds(new Set());
                              else setSelectedAccountIds(new Set(poolAccounts.map((a) => a.id)));
                            }}
                          />
                        </TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>5h / 7d 用量</TableHead>
                        <TableHead>过期时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {poolAccounts.slice(poolPage * poolPageSize, (poolPage + 1) * poolPageSize).map((a) => {
                        const probe = probeMap.get(a.email.toLowerCase());
                        return (
                          <TableRow key={a.id}>
                            <TableCell>
                              <Checkbox checked={selectedAccountIds.has(a.id)}
                                onCheckedChange={() => setSelectedAccountIds((prev) => { const n = new Set(prev); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                              />
                            </TableCell>
                            <TableCell className="text-xs">{a.email}</TableCell>
                            <TableCell><Badge variant={a.planType === 'plus' ? 'info' : 'muted'}>{a.planType}</Badge></TableCell>
                            <TableCell>
                              {probing ? <span className="text-muted-foreground text-xs">探测中...</span> : probe ? (
                                <Badge variant={probe.status === 'ok' ? 'success' : probe.status === 'rate_limited' ? 'warning' : 'destructive'}>
                                  {probe.status === 'ok' ? '正常' : probe.status === 'rate_limited' ? '限流' : probe.status === 'token_invalid' ? 'Token失效' : '错误'}
                                </Badge>
                              ) : <span className="text-muted-foreground">-</span>}
                            </TableCell>
                            <TableCell>
                              {probing ? <UsageCell fiveHour={null} sevenDay={null} loading /> : probe?.usage ? (
                                <UsageCell fiveHour={{ used: probe.usage.fiveHourUsed, resetAt: probe.usage.fiveHourResetAt }} sevenDay={{ used: probe.usage.sevenDayUsed, resetAt: probe.usage.sevenDayResetAt }} />
                              ) : <span className="text-muted-foreground text-xs">-</span>}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{a.expiredAt ? new Date(a.expiredAt).toLocaleDateString() : '-'}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <Pagination page={poolPage} pageSize={poolPageSize} total={poolAccounts.length} onPageChange={setPoolPage} onPageSizeChange={setPoolPageSize} />
                </div>
              )}
            </div>
          )}

          {dataSource === 'file' && (
            <div>
              <FileTrigger variant="dropzone" accept=".json,.csv,.tsv" multiple onFiles={(files) => { void handleFileUpload(files); }}>
                {uploading ? <p>解析中...</p> : (
                  <div>
                    <p className="text-base mb-2">拖拽或点击选择文件</p>
                    <p className="text-muted-foreground text-xs">支持 JSON、CSV 格式，可多选</p>
                  </div>
                )}
              </FileTrigger>
              {uploadError && <p className="text-destructive mt-3">{uploadError}</p>}
              {parsedData && (
                <div className="mt-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span>共 <b>{parsedData.totalRecords}</b> 条记录</span>
                      <Button size="sm" loading={probing} onClick={() => {
                        void (async () => {
                          const pageLimit = 500;
                          const summary = {
                            ok: 0,
                            rateLimited: 0,
                            tokenInvalid: 0,
                            error: 0,
                            skipped: 0,
                          };
                          try {
                            setProbing(true);
                            setProbeMap(new Map());
                            for (let offset = 0; offset < parsedData.totalRecords; offset += pageLimit) {
                              const page = await get<ParsedRecordPage>(`/data/records/${parsedData.fileId}?offset=${offset}&limit=${pageLimit}`);
                              for (const record of page.records) {
                                const target = extractProbeTarget(record.fields, fieldMapping);
                                if (!target.email || !target.accessToken) {
                                  summary.skipped += 1;
                                  continue;
                                }

                                try {
                                  const result = await post<BatchUsageResult>('/accounts/probe', { tokens: [target] });
                                  const item = result.results[0];
                                  if (!item) {
                                    summary.error += 1;
                                    continue;
                                  }

                                  setProbeMap((current) => {
                                    const next = new Map(current);
                                    next.set(item.email.toLowerCase(), item);
                                    return next;
                                  });

                                  if (item.status === 'ok') summary.ok += 1;
                                  else if (item.status === 'rate_limited') summary.rateLimited += 1;
                                  else if (item.status === 'token_invalid') summary.tokenInvalid += 1;
                                  else summary.error += 1;
                                } catch {
                                  summary.error += 1;
                                }
                              }

                              if (page.records.length < pageLimit) break;
                            }

                            const processed = summary.ok + summary.rateLimited + summary.tokenInvalid + summary.error;
                            if (processed === 0) {
                              notify({ tone: 'error', title: '无法检测', description: '未找到可用于检测的 email / access_token 数据' });
                              return;
                            }

                            notify({
                              tone: summary.error === 0 && summary.tokenInvalid === 0 ? 'success' : 'error',
                              title: '检测完成',
                              description: `共 ${processed} 条，正常 ${summary.ok}，限流 ${summary.rateLimited}，失效 ${summary.tokenInvalid}，错误 ${summary.error}${summary.skipped > 0 ? `，跳过 ${summary.skipped}` : ''}`,
                            });
                          } catch (err) {
                            notify({ tone: 'error', title: '检测失败', description: (err as Error).message });
                          } finally {
                            setProbing(false);
                          }
                        })();
                      }}>检测用量</Button>
                    </div>
                    <Badge variant="info">{parsedData.fileType.toUpperCase()}</Badge>
                  </div>
                  <div className={cn(
                    'p-3 rounded-lg mb-3 border',
                    parsedData.matchedProfileId ? 'bg-success/10 border-success/30' : 'bg-muted border-border',
                  )}>
                    <div className="flex items-center justify-between">
                      <span>
                        {parsedData.matchedProfileId
                          ? <><span className="text-success font-semibold">匹配模板:</span> {parsedData.matchedProfileName}</>
                          : <span className="text-muted-foreground text-xs">未匹配到模板</span>}
                      </span>
                      <SelectField
                        value={selectedProfileId || parsedData.matchedProfileId || ''}
                        onChange={handleProfileSelect}
                        options={[{ value: '', label: '不使用模板' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
                        style={{ width: 220 }}
                      />
                    </div>
                  </div>
                  {parsedData.parseWarnings.length > 0 && (
                    <details className="mb-3">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                        解析信息（{parsedData.parseWarnings.length} 条）
                      </summary>
                      <div className="mt-1 p-2 bg-muted rounded text-xs text-muted-foreground max-h-[120px] overflow-auto">
                        {parsedData.parseWarnings.map((w, i) => <div key={i}>{w}</div>)}
                      </div>
                    </details>
                  )}
                  <div className="overflow-hidden">
                    <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">#</TableHead>
                            {parsedData.detectedFields.slice(0, 5).map((f) => <TableHead key={f}>{f}</TableHead>)}
                            {(probeMap.size > 0 || probing) && <TableHead>状态</TableHead>}
                            {(probeMap.size > 0 || probing) && <TableHead>5h / 7d</TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filePageLoading ? (
                            <TableRow>
                              <TableCell colSpan={parsedData.detectedFields.slice(0, 5).length + ((probeMap.size > 0 || probing) ? 3 : 1)} className="text-center text-muted-foreground py-8">
                                加载中...
                              </TableCell>
                            </TableRow>
                          ) : fileRecords.map((r) => {
                            const email = extractProbeTarget(r.fields, fieldMapping).email.toLowerCase();
                            const probe = probeMap.get(email);
                            return (
                              <TableRow key={r.index}>
                                <TableCell className="text-xs">{r.index + 1}</TableCell>
                                {parsedData.detectedFields.slice(0, 5).map((f) => (
                                  <TableCell key={f} className="text-xs max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap">{String(r.fields[f] ?? '')}</TableCell>
                                ))}
                                {(probeMap.size > 0 || probing) && (
                                  <TableCell>
                                    {probe ? (
                                      <Badge variant={probe.status === 'ok' ? 'success' : probe.status === 'rate_limited' ? 'warning' : 'destructive'}>
                                        {probe.status === 'ok' ? '正常' : probe.status === 'rate_limited' ? '限流' : probe.status === 'token_invalid' ? 'Token失效' : '错误'}
                                      </Badge>
                                    ) : probing ? <span className="text-muted-foreground text-xs">探测中...</span> : <span className="text-muted-foreground">-</span>}
                                  </TableCell>
                                )}
                                {(probeMap.size > 0 || probing) && (
                                  <TableCell>
                                    {probe?.usage ? (
                                      <UsageCell fiveHour={{ used: probe.usage.fiveHourUsed, resetAt: probe.usage.fiveHourResetAt }} sevenDay={{ used: probe.usage.sevenDayUsed, resetAt: probe.usage.sevenDayResetAt }} />
                                    ) : probing ? <UsageCell fiveHour={null} sevenDay={null} loading /> : <span className="text-muted-foreground text-xs">-</span>}
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    <Pagination page={filePage} pageSize={filePageSize} total={parsedData.totalRecords} onPageChange={setFilePage} onPageSizeChange={setFilePageSize} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Step 3 - pool confirm */}
      {step === 2 && dataSource === 'pool' && (
        <Card className="p-8 overflow-hidden">
          <h3 className="text-base font-semibold mb-4 text-center">推送确认</h3>
          <p className="text-sm mb-2 text-center">从账号池选择了 <b>{selectedAccountIds.size}</b> 个账号</p>
          <p className="text-muted-foreground mb-3 text-center">&rarr; 推送到 <b>{selectedChannel?.name}</b></p>
          {planTypeOverride && <p className="text-xs text-center">Plan Type 覆盖: <Badge variant="info">{planTypeOverride}</Badge></p>}
          {selectedGroupIds.length > 0 && <p className="text-xs text-center">分组: {selectedGroupIds.join(', ')}</p>}

          <div className="mt-5 pt-4 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <Checkbox
                checked={checkDuplicates}
                onCheckedChange={(v) => { setCheckDuplicates(!!v); setDuplicateResult(null); }}
              />
              <span className="text-sm">推送前检查远端重复</span>
            </div>

            {checkDuplicates && !duplicateResult && !checking && (
              <Button size="sm" onClick={async () => {
                if (!selectedChannelId) return;
                setChecking(true);
                try {
                  // 先同步远端
                  await post(`/channels/${selectedChannelId}/sync`, {});
                  // 获取选中账号的邮箱
                  const emails = poolAccounts
                    .filter((a) => selectedAccountIds.has(a.id))
                    .map((a) => a.email);
                  const result = await post<{ duplicates: string[]; unique: string[]; remoteTotal: number }>(
                    `/channels/${selectedChannelId}/check-duplicates`,
                    { emails },
                  );
                  setDuplicateResult(result);
                  // 过滤掉重复的账号
                  if (result.duplicates.length > 0) {
                    const dupSet = new Set(result.duplicates.map((e) => e.toLowerCase()));
                    setSelectedAccountIds((prev) => {
                      const next = new Set(prev);
                      for (const acc of poolAccounts) {
                        if (dupSet.has(acc.email.toLowerCase())) next.delete(acc.id);
                      }
                      return next;
                    });
                  }
                } catch (err) {
                  notify({ tone: 'error', title: '检查失败', description: (err as Error).message });
                } finally {
                  setChecking(false);
                }
              }}>开始检查</Button>
            )}
            {checking && <p className="text-sm text-muted-foreground">正在同步并检查远端重复...</p>}
            {duplicateResult && (
              <div className={cn(
                'p-3 rounded-md text-sm border',
                duplicateResult.duplicates.length > 0 ? 'bg-warning/10 border-warning/30' : 'bg-success/10 border-success/30',
              )}>
                <p>远端共 {duplicateResult.remoteTotal} 个账号</p>
                <p className="font-semibold mt-1">
                  {duplicateResult.duplicates.length} 个已存在远端（将跳过），{duplicateResult.unique.length} 个新账号
                </p>
                {duplicateResult.duplicates.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">查看重复邮箱</summary>
                    <div className="mt-1 text-xs text-muted-foreground max-h-[120px] overflow-auto">
                      {duplicateResult.duplicates.map((e) => <div key={e}>{e}</div>)}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 3 - file mapping */}
      {step === 2 && dataSource === 'file' && parsedData && (
        <Card className="p-5 overflow-hidden">
          <h3 className="text-base font-semibold mb-4">字段映射</h3>
          <p className="text-muted-foreground text-xs mb-3">将数据字段映射到推送所需的标准字段</p>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标准字段</TableHead>
                <TableHead>数据源字段</TableHead>
                <TableHead>必填</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allTargetFields.map((field) => {
                const isRequired = currentSchema?.requiredDataFields.includes(field);
                return (
                  <TableRow key={field}>
                    <TableCell className="font-medium">{field} {isRequired && <span className="text-destructive">*</span>}</TableCell>
                    <TableCell>
                      <SelectField
                        value={fieldMapping[field] ?? ''}
                        onChange={(v) => setFieldMapping((prev) => ({ ...prev, [field]: v }))}
                        options={[{ value: '', label: '-- 不映射 --' }, ...parsedData.detectedFields.map((d) => ({ value: d, label: d }))]}
                        className="w-full"
                      />
                    </TableCell>
                    <TableCell>{isRequired ? <Badge variant="destructive">必填</Badge> : <Badge variant="muted">可选</Badge>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {(fileRecords[0] ?? parsedData.sampleRecords[0]) && (
            <div className="mt-5">
              <h4 className="text-sm font-semibold mb-2">第一条数据预览</h4>
              <div className="bg-muted p-3 rounded-md text-sm">
                {Object.entries(fieldMapping).filter(([, v]) => v).map(([std, src]) => (
                  <div key={std} className="mb-1"><span className="font-semibold">{std}</span>: {String((fileRecords[0] ?? parsedData.sampleRecords[0]).fields[src] ?? '(空)')}</div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 pt-4 border-t border-border">
            {!showSaveProfile ? (
              <Button size="sm" onClick={() => setShowSaveProfile(true)}>保存为模板</Button>
            ) : (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">模板名称</label>
                  <TextField value={saveProfileName} onChange={(e) => setSaveProfileName(e.target.value)} placeholder="如：原始 Token 文件" />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">描述（可选）</label>
                  <TextField value={saveProfileDesc} onChange={(e) => setSaveProfileDesc(e.target.value)} placeholder="格式说明" />
                </div>
                <Button variant="primary" size="sm" disabled={!saveProfileName} loading={saving} onClick={handleSaveProfile}>{saving ? '保存中...' : '保存'}</Button>
                <Button size="sm" onClick={() => setShowSaveProfile(false)}>取消</Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 4 */}
      {step === 3 && (
        <Card className="p-5 overflow-hidden">
          <h3 className="text-base font-semibold mb-4">推送执行</h3>
          {!pushing && !summary && (
            <div className="text-center py-5">
              <p className="mb-3">即将推送 <b>{totalItems}</b> 条数据到渠道 <b>{selectedChannel?.name}</b></p>
              <Button variant="primary" onClick={handlePush}>开始推送</Button>
            </div>
          )}
          {(pushing || summary) && (
            <div>
              <div className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <span>{pushing ? '推送中...' : '推送完成'}</span>
                  <span>{logs.length} / {totalItems}</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className={cn(
                    'h-full transition-[width] duration-300',
                    summary ? (summary.failed === 0 ? 'bg-success' : 'bg-warning') : 'bg-primary',
                  )} style={{ width: `${((logs.length / (totalItems || 1)) * 100)}%` }} />
                </div>
              </div>

              {summary && (
                <div className="flex gap-3 mb-4">
                  <div className="flex-1 text-center p-3 bg-success/10 rounded-lg">
                    <div className="text-2xl font-bold text-success">{summary.success}</div>
                    <div className="text-xs text-muted-foreground">成功</div>
                  </div>
                  <div className="flex-1 text-center p-3 bg-destructive/10 rounded-lg">
                    <div className="text-2xl font-bold text-destructive">{summary.failed}</div>
                    <div className="text-xs text-muted-foreground">失败</div>
                  </div>
                  <div className="flex-1 text-center p-3 bg-muted rounded-lg">
                    <div className="text-2xl font-bold">{summary.total}</div>
                    <div className="text-xs text-muted-foreground">总计</div>
                  </div>
                </div>
              )}

              <div className="max-h-[300px] overflow-auto bg-background rounded-lg p-3 text-xs font-mono border border-border">
                {logs.map((log, i) => (
                  <div key={i} className="mb-1">
                    <span className={log.ok ? 'text-success' : 'text-destructive'}>{log.ok ? '[OK]' : '[FAIL]'}</span>
                    {' '}{log.identifier}
                    {log.error && <span className="text-warning"> - {log.error}</span>}
                    <span className="text-muted-foreground"> ({log.ms}ms)</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>

              {summary && (
                <div className="mt-4">
                  <Button variant="primary" onClick={handleReset}>开始新推送</Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Navigation */}
      {step < 3 && (
        <div className="flex gap-2 mt-4 justify-end">
          {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
          <Button variant="primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>下一步</Button>
        </div>
      )}
    </div>
  );
}
