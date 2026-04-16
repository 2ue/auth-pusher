import type { AccountQuery } from './account.js';

export interface QuotaSummary {
  totalAccounts: number;
  availableNow: number;
  oneHour: number;
  fiveHour: number;
  sevenDay: number;
  oneWeek: number;
  oneMonth: number;
}

export interface QuotaArchiveScope extends Omit<AccountQuery, 'limit' | 'offset'> {
  ids?: string[];
}

export interface QuotaArchive {
  id: string;
  scopeKey: string;
  scope: QuotaArchiveScope;
  quota: QuotaSummary;
  total: number;
  processed: number;
  successCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  rateLimitedCount: number;
  createdAt: string;
}
