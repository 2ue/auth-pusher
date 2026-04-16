import { cn } from '@/lib/utils';

function formatReset(resetAt: string | undefined, mode: '5h' | '7d'): string {
  if (!resetAt) return '';
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return '';
  const totalMin = Math.floor(ms / 60000);
  const totalH = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (mode === '5h') return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return d > 0 ? `${d}d${h}h` : `${h}h${m}m`;
}

export default function UsageBar({ label, used, resetAt, color, mode }: {
  label: string; used: number; resetAt?: string;
  color?: 'indigo' | 'emerald'; mode?: '5h' | '7d';
}) {
  const pct = Math.min(used, 120);
  const barColor = used >= 100 ? 'bg-destructive' : used >= 80 ? 'bg-warning' : 'bg-success';
  const textColor = used >= 100 ? 'text-destructive' : used >= 80 ? 'text-warning' : 'text-muted-foreground';
  const resetText = formatReset(resetAt, mode ?? '5h');

  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          'inline-block w-6 text-center text-[10px] font-semibold rounded px-0.5 py-px',
          color === 'emerald' ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
        )}
      >
        {label}
      </span>
      <div className="w-12 h-[5px] bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full transition-[width] duration-300', barColor)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className={cn('text-[10px] font-medium min-w-[28px] text-right', textColor)}>
        {Math.round(used)}%
      </span>
      {resetText && <span className="text-[10px] text-muted-foreground">{resetText}</span>}
    </div>
  );
}

export function UsageCell({ fiveHour, sevenDay, loading }: {
  fiveHour: { used: number; resetAt: string } | null;
  sevenDay: { used: number; resetAt: string } | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-1">
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-xs text-muted-foreground">...</span>
      </div>
    );
  }
  if (!fiveHour && !sevenDay) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {fiveHour && <UsageBar label="5h" used={fiveHour.used} resetAt={fiveHour.resetAt} color="indigo" mode="5h" />}
      {sevenDay && <UsageBar label="7d" used={sevenDay.used} resetAt={sevenDay.resetAt} color="emerald" mode="7d" />}
    </div>
  );
}
