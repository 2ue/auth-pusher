import { useState, useEffect } from 'react';
import { get, put, setApiKey } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TextField } from '@/components/TextField';
import { NumberField } from '@/components/NumberField';
import { SelectField } from '@/components/SelectField';
import { buildOpenAiModelOptions } from '@/constants/openaiModels';

interface PlanQuota {
  fiveHourUnits: number;
  sevenDayUnits: number;
  knivesPerUnit: number;
}
interface AppSettings {
  pushIntervalMs: number;
  pushConcurrency: number;
  defaultProbeModel: string;
  defaultTestModel: string;
  planQuotas: Record<string, PlanQuota>;
  apiKey?: string;
  webhookUrl?: string;
}

const DEFAULTS: AppSettings = {
  pushIntervalMs: 200,
  pushConcurrency: 1,
  defaultProbeModel: 'gpt-5.2',
  defaultTestModel: 'gpt-5.2',
  planQuotas: {
    free: { fiveHourUnits: 50, sevenDayUnits: 500, knivesPerUnit: 1 },
    plus: { fiveHourUnits: 80, sevenDayUnits: 1000, knivesPerUnit: 1 },
    pro: { fiveHourUnits: 500, sevenDayUnits: 5000, knivesPerUnit: 1 },
    team: { fiveHourUnits: 500, sevenDayUnits: 5000, knivesPerUnit: 1 },
  },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    get<AppSettings>('/settings').then((s) => setSettings({ ...DEFAULTS, ...s })).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    try {
      const updated = await put<AppSettings>('/settings', settings);
      setSettings({ ...DEFAULTS, ...updated });
      setApiKey(updated.apiKey ?? '');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const handleReset = () => setSettings(DEFAULTS);

  const updateQuota = (plan: string, field: keyof PlanQuota, value: number) => {
    setSettings((s) => ({
      ...s,
      planQuotas: {
        ...s.planQuotas,
        [plan]: { ...s.planQuotas[plan], [field]: value },
      },
    }));
  };

  if (loading) return <p className="text-muted-foreground">加载中...</p>;

  const quotaPlans = Object.keys(settings.planQuotas);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">系统设置</h2>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {saving ? '保存中...' : '保存设置'}
          </Button>
          <Button onClick={handleReset}>恢复默认</Button>
          {saved && <span className="text-success text-sm leading-9">已保存</span>}
        </div>
      </div>

      <div className="space-y-4">
        {/* 推送参数 */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-4">推送参数</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">推送间隔（毫秒）</label>
              <NumberField
                value={settings.pushIntervalMs}
                min={0}
                step={50}
                onChangeValue={(v) => setSettings((s) => ({ ...s, pushIntervalMs: Math.max(0, Number(v || 0)) }))}
              />
              <p className="text-xs text-muted-foreground mt-1">每条数据推送后的等待时间，0 = 不等待</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">推送并发数</label>
              <NumberField
                value={settings.pushConcurrency}
                min={1}
                max={50}
                onChangeValue={(v) => setSettings((s) => ({ ...s, pushConcurrency: Math.max(1, Math.floor(Number(v || 1))) }))}
              />
              <p className="text-xs text-muted-foreground mt-1">同时推送的数据条数，1 = 串行逐条推送</p>
            </div>
          </div>
          <p className="p-3 mt-4 bg-muted rounded-md text-xs text-muted-foreground">
            每个渠道可单独覆盖推送参数，在渠道编辑页面配置。
          </p>
        </Card>

        {/* 安全与通知 */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-4">安全与通知</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">API Key</label>
              <TextField
                type="password"
                value={settings.apiKey ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder="留空则不启用 API 鉴权"
              />
              <p className="text-xs text-muted-foreground mt-1">所有 API 请求需携带此 Key（Header: X-Api-Key），留空则无需鉴权</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Webhook URL</label>
              <TextField
                value={settings.webhookUrl ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, webhookUrl: e.target.value }))}
                placeholder="https://example.com/notify"
              />
              <p className="text-xs text-muted-foreground mt-1">任务完成/失败时 POST 到此 URL，留空不启用</p>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-4">检测与测试模型</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">默认检测额度模型</label>
              <SelectField
                value={settings.defaultProbeModel}
                onChange={(value) => setSettings((s) => ({ ...s, defaultProbeModel: value }))}
                options={buildOpenAiModelOptions(settings.defaultProbeModel)}
              />
              <p className="text-xs text-muted-foreground mt-1">“检测额度”与批量检测直接使用这个模型。</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">默认测试调用模型</label>
              <SelectField
                value={settings.defaultTestModel}
                onChange={(value) => setSettings((s) => ({ ...s, defaultTestModel: value }))}
                options={buildOpenAiModelOptions(settings.defaultTestModel)}
              />
              <p className="text-xs text-muted-foreground mt-1">单条“测试调用”打开弹窗后可临时改模型，批量测试默认用这里。</p>
            </div>
          </div>
        </Card>

        {/* 额度配置 */}
        <Card className="p-0">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold mb-1">额度配置</h3>
            <p className="text-xs text-muted-foreground">配置每种账号类型的额度数与每额度刀数。统计时先算剩余额度，再折算为刀数。</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan Type</TableHead>
                <TableHead>5h 额度数</TableHead>
                <TableHead>7d 额度数</TableHead>
                <TableHead>每额度刀数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotaPlans.map((plan) => (
                <TableRow key={plan}>
                  <TableCell className="font-semibold">{plan}</TableCell>
                  <TableCell>
                    <NumberField
                      value={settings.planQuotas[plan].fiveHourUnits}
                      min={0}
                      onChangeValue={(v) => updateQuota(plan, 'fiveHourUnits', Math.max(0, Number(v || 0)))}
                    />
                  </TableCell>
                  <TableCell>
                    <NumberField
                      value={settings.planQuotas[plan].sevenDayUnits}
                      min={0}
                      onChangeValue={(v) => updateQuota(plan, 'sevenDayUnits', Math.max(0, Number(v || 0)))}
                    />
                  </TableCell>
                  <TableCell>
                    <NumberField
                      value={settings.planQuotas[plan].knivesPerUnit}
                      min={0}
                      onChangeValue={(v) => updateQuota(plan, 'knivesPerUnit', Math.max(0, Number(v || 0)))}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
