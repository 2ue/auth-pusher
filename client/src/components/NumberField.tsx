import { useCallback, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

function getPrecision(step: number) {
  const value = String(step);
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

function clampNumber(value: number, min?: number, max?: number) {
  let next = value;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return next;
}

function formatNumber(value: number, step: number) {
  const precision = getPrecision(step);
  if (precision === 0) return String(Math.round(value));
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

export function NumberField({
  value,
  onChangeValue,
  min,
  max,
  step = 1,
  className,
  style,
  disabled,
  placeholder,
}: {
  value: number | string;
  onChangeValue: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const displayValue = value === 0 ? '0' : (value ? String(value) : '');

  const commitValue = useCallback((raw: string) => {
    if (!raw || raw === '-' || raw === '.' || raw === '-.') {
      onChangeValue('');
      return;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    onChangeValue(formatNumber(clampNumber(parsed, min, max), step));
  }, [max, min, onChangeValue, step]);

  const nudge = useCallback((direction: 1 | -1) => {
    if (disabled) return;
    const parsed = Number(displayValue);
    const base = Number.isFinite(parsed) ? parsed : (typeof min === 'number' ? min : 0);
    const next = clampNumber(base + direction * step, min, max);
    onChangeValue(formatNumber(next, step));
  }, [disabled, displayValue, max, min, onChangeValue, step]);

  return (
    <div
      className={cn(
        'flex items-center rounded-lg border border-input bg-card dark:bg-[#0a1628] h-9 text-sm transition-colors',
        focused && 'ring-1 ring-ring border-primary',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      style={style}
    >
      <input
        type="text"
        inputMode={step % 1 === 0 ? 'numeric' : 'decimal'}
        value={displayValue}
        disabled={disabled}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent px-3 outline-none placeholder:text-muted-foreground"
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          commitValue(e.target.value.trim());
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/,/g, '.').trimStart();
          if (/^-?\d*(\.\d*)?$/.test(raw)) {
            onChangeValue(raw);
          }
        }}
      />
      <div className="flex flex-col border-l border-border h-full">
        <button
          type="button"
          className="flex-1 px-2 hover:bg-muted text-muted-foreground text-xs leading-none disabled:opacity-50"
          onClick={() => nudge(1)}
          disabled={disabled}
          aria-label="increase"
        >
          +
        </button>
        <button
          type="button"
          className="flex-1 px-2 hover:bg-muted text-muted-foreground text-xs leading-none border-t border-border disabled:opacity-50"
          onClick={() => nudge(-1)}
          disabled={disabled}
          aria-label="decrease"
        >
          -
        </button>
      </div>
    </div>
  );
}
