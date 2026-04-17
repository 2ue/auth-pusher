/** 任务状态 → Badge 映射 */
export const TASK_STATUS_MAP: Record<string, { label: string; variant: 'muted' | 'info' | 'success' | 'destructive' }> = {
  pending: { label: '等待中', variant: 'muted' },
  running: { label: '执行中', variant: 'info' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  cancelled: { label: '已取消', variant: 'muted' },
};

/** 推送项状态 → Badge 映射 */
export const TASK_ITEM_STATUS_MAP: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'muted' | 'info' }> = {
  success: { label: '成功', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
  skipped: { label: '跳过', variant: 'warning' },
  pending: { label: '等待', variant: 'muted' },
  pushing: { label: '推送中', variant: 'info' },
};
