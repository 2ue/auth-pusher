import type { AppSettings } from '../../../shared/types/settings.js';
import db from './db.js';

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

const stmtGet = db.prepare<[string], { key: string; value: string }>('SELECT key, value FROM settings WHERE key = ?');
const stmtUpsert = db.prepare<[string, string]>('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const stmtAll = db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings');

export function load(): AppSettings {
  const rows = stmtAll.all();
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try { raw[row.key] = JSON.parse(row.value); } catch { raw[row.key] = row.value; }
  }
  return normalizeSettings(raw as Partial<AppSettings>);
}

export function save(settings: AppSettings): void {
  const normalized = normalizeSettings(settings);
  const entries: Array<[string, unknown]> = [
    ['pushIntervalMs', normalized.pushIntervalMs],
    ['pushConcurrency', normalized.pushConcurrency],
    ['defaultProbeModel', normalized.defaultProbeModel],
    ['defaultTestModel', normalized.defaultTestModel],
    ['planQuotas', normalized.planQuotas],
  ];
  // Preserve optional keys
  if (settings.apiKey !== undefined) {
    entries.push(['apiKey', settings.apiKey]);
  }
  if (settings.webhookUrl !== undefined) {
    entries.push(['webhookUrl', settings.webhookUrl]);
  }

  const saveMany = db.transaction(() => {
    for (const [key, value] of entries) {
      stmtUpsert.run(key, JSON.stringify(value));
    }
  });
  saveMany();
}

export function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const rawPlanQuotas = (input.planQuotas ?? {}) as unknown as Record<string, Record<string, unknown>>;
  const planNames = new Set([
    ...Object.keys(DEFAULTS.planQuotas),
    ...Object.keys(rawPlanQuotas),
  ]);

  const result: AppSettings = {
    pushIntervalMs: Math.max(0, Number(input.pushIntervalMs ?? DEFAULTS.pushIntervalMs)),
    pushConcurrency: Math.max(1, Math.floor(Number(input.pushConcurrency ?? DEFAULTS.pushConcurrency))),
    defaultProbeModel: String(input.defaultProbeModel ?? DEFAULTS.defaultProbeModel).trim() || DEFAULTS.defaultProbeModel,
    defaultTestModel: String(input.defaultTestModel ?? DEFAULTS.defaultTestModel).trim() || DEFAULTS.defaultTestModel,
    planQuotas: Object.fromEntries(
      Array.from(planNames).map((plan) => {
        const fallback = DEFAULTS.planQuotas[plan] ?? { fiveHourUnits: 0, sevenDayUnits: 0, knivesPerUnit: 1 };
        const raw = rawPlanQuotas[plan] ?? {};
        return [plan, {
          fiveHourUnits: Math.max(0, Number(raw.fiveHourUnits ?? fallback.fiveHourUnits)),
          sevenDayUnits: Math.max(0, Number(raw.sevenDayUnits ?? fallback.sevenDayUnits)),
          knivesPerUnit: Math.max(0, Number(raw.knivesPerUnit ?? fallback.knivesPerUnit)),
        }];
      }),
    ),
  };

  if (input.apiKey !== undefined) result.apiKey = input.apiKey;
  if (input.webhookUrl !== undefined) result.webhookUrl = input.webhookUrl;

  return result;
}
