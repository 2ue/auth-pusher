export interface PlanQuota {
  /** 5 小时窗口可用额度数 */
  fiveHourUnits: number;
  /** 7 天窗口可用额度数 */
  sevenDayUnits: number;
  /** 每 1 个额度可折算的刀数 */
  knivesPerUnit: number;
}

export interface AppSettings {
  /** 推送间隔（毫秒） */
  pushIntervalMs: number;
  /** 推送并发数（1 = 串行） */
  pushConcurrency: number;
  /** 默认检测额度模型 */
  defaultProbeModel: string;
  /** 默认测试调用模型 */
  defaultTestModel: string;
  /** 每种 planType 的额度配置 */
  planQuotas: Record<string, PlanQuota>;
  /** API 鉴权密钥，为空则不启用鉴权 */
  apiKey?: string;
  /** Webhook 通知 URL，任务完成/失败时推送（留空不启用） */
  webhookUrl?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
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
