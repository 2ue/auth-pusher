import { useState, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type ControlSize = 'md' | 'sm';

export function TextAreaField({
  className,
  style,
  disabled,
  size,
  onFocus,
  onBlur,
  rows = 4,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  size?: ControlSize;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div
      className={cn(
        'rounded-lg border border-input bg-card dark:bg-[#0a1628] transition-colors',
        size === 'sm' ? 'text-xs' : 'text-sm',
        focused && 'ring-1 ring-ring border-primary',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      style={style}
    >
      <textarea
        {...props}
        rows={rows}
        disabled={disabled}
        className="w-full min-w-0 bg-transparent px-3 py-2 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed resize-y"
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
      />
    </div>
  );
}
