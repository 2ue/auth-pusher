import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ControlSize = 'md' | 'sm';

export const TextField = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    prefix?: ReactNode;
    suffix?: ReactNode;
    size?: ControlSize;
  }
>(function TextField(
  { className, style, disabled, prefix, suffix, size = 'md', onFocus, onBlur, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-input bg-card dark:bg-[#0a1628] px-3 transition-colors',
        size === 'sm' ? 'h-7 text-xs' : 'h-9 text-sm',
        focused && 'ring-1 ring-ring border-primary',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      style={style}
    >
      {prefix && <div className="text-muted-foreground shrink-0">{prefix}</div>}
      <input
        ref={ref}
        {...props}
        disabled={disabled}
        className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
      />
      {suffix && <div className="text-muted-foreground shrink-0">{suffix}</div>}
    </div>
  );
});
