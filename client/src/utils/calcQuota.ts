export interface PlanQuota {
  fiveHourUnits: number;
  sevenDayUnits: number;
  knivesPerUnit: number;
}

export interface AccountProbeData {
  planType: string;
  fiveHourUsed: number;
  fiveHourResetAt: string;
  sevenDayUsed: number;
  sevenDayResetAt: string;
}

export interface QuotaResult {
  totalAccounts: number;
  availableNow: number;
  oneHour: number;
  fiveHour: number;
  sevenDay: number;
  oneWeek: number;
  oneMonth: number;
}

export function calcQuota(
  accounts: AccountProbeData[],
  quotas: Record<string, PlanQuota>,
): QuotaResult {
  const now = Date.now();
  const oneHourLater = now + 60 * 60 * 1000;

  let availableNow = 0, oneHour = 0, fiveHour = 0, sevenDay = 0;

  for (const a of accounts) {
    const q = quotas[a.planType] ?? quotas['free'] ?? { fiveHourUnits: 50, sevenDayUnits: 500, knivesPerUnit: 1 };
    const quota5h = q.fiveHourUnits;
    const quota7d = q.sevenDayUnits;
    const knivesPerUnit = q.knivesPerUnit || 1;

    const rem5hUnits = Math.max(0, Math.round(quota5h * (100 - a.fiveHourUsed) / 100));
    const rem7dUnits = Math.max(0, Math.round(quota7d * (100 - a.sevenDayUsed) / 100));
    const currentUnits = Math.min(rem5hUnits, rem7dUnits);

    // 1h: 5h 窗口是否在 1h 内重置
    const resetAt5h = a.fiveHourResetAt ? new Date(a.fiveHourResetAt).getTime() : 0;
    const willReset = resetAt5h > 0 && resetAt5h <= oneHourLater;
    availableNow += Math.round(currentUnits * knivesPerUnit);
    oneHour += Math.round(Math.min(willReset ? quota5h : rem5hUnits, rem7dUnits) * knivesPerUnit);

    // 5h: 所有 5h 窗口至少重置一次
    fiveHour += Math.round(Math.min(quota5h, rem7dUnits) * knivesPerUnit);

    // 7d: 当前剩余
    sevenDay += Math.round(rem7dUnits * knivesPerUnit);
  }

  return {
    totalAccounts: accounts.length,
    availableNow,
    oneHour,
    fiveHour,
    sevenDay,
    oneWeek: sevenDay,
    oneMonth: Math.round(sevenDay * (30 / 7)),
  };
}
