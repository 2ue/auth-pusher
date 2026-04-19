export interface UsageSnapshot {
  fiveHourUsed: number;
  fiveHourResetAt: string;
  sevenDayUsed: number;
  sevenDayResetAt: string;
}

export type AccountUsageStatus = 'ok' | 'error' | 'token_invalid' | 'rate_limited';

export interface AccountProbeState {
  status: AccountUsageStatus;
  usage: UsageSnapshot | null;
  errorMessage: string;
  probedAt: string;
}

export type AccountSourceType = 'local' | 'remote';

export interface Account {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  organizationId: string;
  planType: string;
  tags: string[];
  disabled: boolean;
  expiredAt: string;
  sourceType: AccountSourceType;
  source: string;
  sourceChannelId?: string;
  importedAt: string;
  pushHistory: PushHistoryEntry[];
  lastProbe: AccountProbeState | null;
  batchId?: string;
  deletedAt?: string;
  deleteReason?: string;
}

export interface PushHistoryEntry {
  channelId: string;
  channelName: string;
  taskId: string;
  status: 'success' | 'failed';
  at: string;
}

export interface AccountStats {
  total: number;
  byPlanType: Record<string, number>;
  bySourceType: Record<string, number>;
  expired: number;
  expiringSoon: number;
  disabled: number;
  recentImported: number;
  quota: {
    totalAccounts: number;
    availableNow: number;
    oneHour: number;
    fiveHour: number;
    sevenDay: number;
    oneWeek: number;
    oneMonth: number;
  };
}

export interface AccountQuery {
  planType?: string;
  expired?: boolean;
  disabled?: boolean;
  notPushedTo?: string;
  search?: string;
  tags?: string[];
  sourceType?: AccountSourceType;
  source?: string;
  sourceChannelId?: string;
  importDateFrom?: string;
  importDateTo?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  batchId?: string;
  limit?: number;
  offset?: number;
}
