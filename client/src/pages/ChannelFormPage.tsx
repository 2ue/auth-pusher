import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { get, post, put } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { TextField } from '@/components/TextField';
import { TextAreaField } from '@/components/TextAreaField';
import { NumberField } from '@/components/NumberField';
import { SelectField } from '@/components/SelectField';
import { cn } from '@/lib/utils';

interface PusherFieldSchema {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'json';
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  defaultValue?: unknown;
  description?: string;
  secret?: boolean;
}

interface PusherSchema {
  type: string;
  name: string;
  description: string;
  configFields: PusherFieldSchema[];
}

interface ChannelConfig {
  id: string;
  name: string;
  pusherType: string;
  enabled: boolean;
  pusherConfig: Record<string, unknown>;
  fieldMapping: Record<string, string>;
  pushIntervalMs?: number;
  pushConcurrency?: number;
  defaultAccountFilter?: {
    planType?: string;
    excludeDisabled?: boolean;
    excludeExpired?: boolean;
  };
}

export default function ChannelFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = !!id;

  const [schemas, setSchemas] = useState<PusherSchema[]>([]);
  const [name, setName] = useState('');
  const [pusherType, setPusherType] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [pushIntervalMs, setPushIntervalMs] = useState<string>('');
  const [pushConcurrency, setPushConcurrency] = useState<string>('');
  const [defaultAccountFilter, setDefaultAccountFilter] = useState<{
    planType?: string;
    excludeDisabled?: boolean;
    excludeExpired?: boolean;
  }>({ excludeDisabled: true, excludeExpired: true });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // SUB2API groups
  const [groups, setGroups] = useState<{ id: number; name: string; account_count: number }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  useEffect(() => {
    get<PusherSchema[]>('/pushers').then(setSchemas);
  }, []);

  useEffect(() => {
    if (isEdit) {
      get<ChannelConfig>(`/channels/${id}`).then((ch) => {
        setName(ch.name);
        setPusherType(ch.pusherType);
        setEnabled(ch.enabled);
        setConfig(ch.pusherConfig);
        if (ch.pushIntervalMs != null) setPushIntervalMs(String(ch.pushIntervalMs));
        if (ch.pushConcurrency != null) setPushConcurrency(String(ch.pushConcurrency));
        if (ch.defaultAccountFilter) {
          setDefaultAccountFilter({
            planType: ch.defaultAccountFilter.planType ?? '',
            excludeDisabled: ch.defaultAccountFilter.excludeDisabled !== false,
            excludeExpired: ch.defaultAccountFilter.excludeExpired !== false,
          });
        }
        // Parse group_ids from pusherConfig
        const existing = String(ch.pusherConfig?.group_ids ?? '');
        if (existing) {
          const ids = existing.split(',').map(Number).filter((n) => !isNaN(n));
          setSelectedGroupIds(ids);
        }
      });
    }
  }, [id]);

  // Fetch groups for sub2api
  useEffect(() => {
    if (pusherType === 'sub2api' && isEdit && id) {
      setGroupsLoading(true);
      get<{ id: number; name: string; account_count: number }[]>(`/channels/${id}/groups`)
        .then(setGroups)
        .catch(() => setGroups([]))
        .finally(() => setGroupsLoading(false));
    } else {
      setGroups([]);
    }
  }, [pusherType, id]);

  const currentSchema = schemas.find((s) => s.type === pusherType);

  // 连接相关的字段 key（其余归入推送参数）
  const connectionKeys = new Set(['base_url', 'token', 'admin_key', 'auth_mode', 'proxy_url', 'timeout_seconds']);
  const connectionFields = currentSchema?.configFields.filter((f) => connectionKeys.has(f.key)) ?? [];
  const pushParamFields = currentSchema?.configFields.filter((f) => !connectionKeys.has(f.key) && f.key !== 'group_ids') ?? [];

  const handleTypeChange = (type: string) => {
    setPusherType(type);
    const schema = schemas.find((s) => s.type === type);
    if (schema && !isEdit) {
      const defaults: Record<string, unknown> = {};
      for (const f of schema.configFields) {
        if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
      }
      setConfig(defaults);
    }
  };

  const updateConfig = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('请输入渠道名称'); return; }
    if (!pusherType) { setError('请选择推送类型'); return; }
    setSaving(true);
    try {
      // Merge group_ids into pusherConfig for sub2api
      const finalConfig = { ...config };
      if (pusherType === 'sub2api' && selectedGroupIds.length > 0) {
        finalConfig.group_ids = selectedGroupIds.join(',');
      }

      const body: Record<string, unknown> = {
        name: name.trim(), pusherType, enabled, pusherConfig: finalConfig,
        pushIntervalMs: pushIntervalMs ? Number(pushIntervalMs) : undefined,
        pushConcurrency: pushConcurrency ? Number(pushConcurrency) : undefined,
        defaultAccountFilter: {
          planType: defaultAccountFilter.planType || undefined,
          excludeDisabled: defaultAccountFilter.excludeDisabled,
          excludeExpired: defaultAccountFilter.excludeExpired,
        },
      };
      if (isEdit) await put(`/channels/${id}`, body);
      else await post('/channels', body);
      navigate('/channels');
    } catch (err) {
      setError((err as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-5">
        {isEdit ? '编辑渠道' : '新建渠道'}
      </h2>

      <form onSubmit={handleSubmit}>
        <Card className="p-6 mb-4">
          <h3 className="text-sm font-semibold mb-4">基础信息</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">渠道名称 <span className="text-destructive">*</span></label>
              <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="如：生产环境 SUB2API" />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">推送类型 <span className="text-destructive">*</span></label>
              <SelectField
                value={pusherType}
                onChange={handleTypeChange}
                options={[
                  { value: '', label: '选择推送类型' },
                  ...schemas.map((schema) => ({
                    value: schema.type,
                    label: schema.name,
                    hint: schema.description,
                  })),
                ]}
              />
            </div>

            {isEdit && (
              <div>
                <label className="block text-sm font-medium mb-1.5">状态</label>
                <SelectField
                  value={enabled ? 'true' : 'false'}
                  onChange={(v) => setEnabled(v === 'true')}
                  options={[
                    { value: 'true', label: '启用' },
                    { value: 'false', label: '禁用' },
                  ]}
                />
              </div>
            )}
          </div>
        </Card>

        {connectionFields.length > 0 && (
          <Card className="p-6 mb-4">
            <h3 className="text-sm font-semibold mb-4">连接配置</h3>
            <div className="grid grid-cols-2 gap-4">
              {connectionFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium mb-1.5">
                    {field.label} {field.required && <span className="text-destructive">*</span>}
                  </label>
                  {field.type === 'select' ? (
                    <SelectField
                      value={String(config[field.key] ?? field.defaultValue ?? '')}
                      onChange={(v) => updateConfig(field.key, v)}
                      options={(field.options ?? []).map((opt) => ({ value: opt.value, label: opt.label }))}
                    />
                  ) : (
                    <TextField
                      type={field.secret ? 'password' : 'text'}
                      value={String(config[field.key] ?? '')}
                      onChange={(e) => updateConfig(field.key, e.target.value)}
                      placeholder={field.placeholder}
                    />
                  )}
                  {field.description && <p className="text-xs text-muted-foreground mt-1">{field.description}</p>}
                </div>
              ))}
            </div>
          </Card>
        )}

        {pusherType && (
          <Card className="p-6 mb-4">
            <h3 className="text-sm font-semibold mb-4">推送参数</h3>

            {/* SUB2API: Groups Selection */}
            {pusherType === 'sub2api' && isEdit && groups.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1.5">推送分组</label>
                <div className="flex items-center gap-2 mb-2">
                  <Button type="button" size="sm" onClick={() => setSelectedGroupIds(groups.map((g) => g.id))}>全选</Button>
                  <Button type="button" size="sm" onClick={() => setSelectedGroupIds([])}>清空</Button>
                  <span className="text-muted-foreground text-xs leading-7">已选 {selectedGroupIds.length} / {groups.length}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 max-h-[240px] overflow-auto">
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
              </div>
            )}
            {pusherType === 'sub2api' && isEdit && groupsLoading && (
              <p className="text-muted-foreground text-xs mb-4">拉取分组中...</p>
            )}

            {/* 渠道特有推送参数（从 schema 中提取） */}
            {pushParamFields.length > 0 && (
              <div className="grid grid-cols-2 gap-4 mb-4">
                {pushParamFields.map((field) => (
                  <div key={field.key} className={field.type === 'json' ? 'col-span-2' : ''}>
                    <label className="block text-sm font-medium mb-1.5">{field.label}</label>
                    {field.type === 'select' ? (
                      <SelectField
                        value={String(config[field.key] ?? field.defaultValue ?? '')}
                        onChange={(v) => updateConfig(field.key, v)}
                        options={(field.options ?? []).map((opt) => ({ value: opt.value, label: opt.label }))}
                      />
                    ) : field.type === 'json' ? (
                      <TextAreaField
                        rows={3}
                        value={typeof config[field.key] === 'string'
                          ? config[field.key] as string
                          : JSON.stringify(config[field.key] ?? '', null, 2)}
                        onChange={(e) => updateConfig(field.key, e.target.value)}
                        placeholder={field.placeholder}
                      />
                    ) : field.type === 'number' ? (
                      <NumberField
                        value={String(config[field.key] ?? field.defaultValue ?? '')}
                        onChangeValue={(v) => updateConfig(field.key, v ? Number(v) : undefined)}
                        placeholder={field.placeholder}
                      />
                    ) : (
                      <TextField
                        value={String(config[field.key] ?? '')}
                        onChange={(e) => updateConfig(field.key, e.target.value)}
                        placeholder={field.placeholder}
                      />
                    )}
                    {field.description && <p className="text-xs text-muted-foreground mt-1">{field.description}</p>}
                  </div>
                ))}
              </div>
            )}

            {/* 推送执行参数 */}
            <Separator className="my-4" />
            <label className="block text-sm font-medium mb-3">执行控制</label>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">推送间隔 (ms)</label>
                <NumberField
                  value={pushIntervalMs}
                  min={0}
                  step={50}
                  onChangeValue={setPushIntervalMs}
                  placeholder="留空则使用全局设置"
                />
                <p className="text-xs text-muted-foreground mt-1">留空则使用全局设置</p>
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">推送并发数</label>
                <NumberField
                  value={pushConcurrency}
                  min={1}
                  max={50}
                  onChangeValue={setPushConcurrency}
                  placeholder="留空则使用全局设置"
                />
                <p className="text-xs text-muted-foreground mt-1">留空则使用全局设置（1 = 串行）</p>
              </div>
            </div>

            {/* 账号筛选默认值 */}
            <Separator className="my-4" />
            <label className="block text-sm font-medium mb-3">账号筛选默认值</label>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">账号类型</label>
                <SelectField
                  value={defaultAccountFilter.planType ?? ''}
                  onChange={(v) => setDefaultAccountFilter((f) => ({ ...f, planType: v }))}
                  options={[
                    { value: '', label: '全部' },
                    { value: 'free', label: 'free' },
                    { value: 'plus', label: 'plus' },
                    { value: 'pro', label: 'pro' },
                    { value: 'team', label: 'team' },
                  ]}
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={defaultAccountFilter.excludeDisabled !== false}
                    onCheckedChange={(v) => setDefaultAccountFilter((f) => ({ ...f, excludeDisabled: !!v }))}
                  />
                  <span className="text-sm">排除已禁用</span>
                </label>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={defaultAccountFilter.excludeExpired !== false}
                    onCheckedChange={(v) => setDefaultAccountFilter((f) => ({ ...f, excludeExpired: !!v }))}
                  />
                  <span className="text-sm">排除已过期</span>
                </label>
              </div>
            </div>
          </Card>
        )}

        {error && <div className="text-destructive text-sm mb-4">{error}</div>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
          <Button type="button" onClick={() => navigate('/channels')}>取消</Button>
        </div>
      </form>
    </div>
  );
}
