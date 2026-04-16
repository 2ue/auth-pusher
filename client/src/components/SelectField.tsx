import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

type ControlSize = 'md' | 'sm';

export function SelectField({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled,
  className,
  style,
  size = 'md',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  size?: ControlSize;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const preferredHeight = 280;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openUpward = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(preferredHeight, Math.max(140, openUpward ? spaceAbove : spaceBelow));

    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      top: openUpward ? Math.max(viewportPadding, rect.top - maxHeight - 8) : Math.min(window.innerHeight - maxHeight - viewportPadding, rect.bottom + 8),
      width: rect.width,
      maxHeight,
      zIndex: 2200,
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleWindowChange = () => updateMenuPosition();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, updateMenuPosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        className={cn(
          'flex items-center justify-between w-full rounded-md border border-input bg-transparent dark:bg-[#0a1628] px-3 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-7 text-xs' : 'h-9',
          open && 'ring-1 ring-ring',
          className,
        )}
        style={style}
        onClick={() => setOpen((c) => !c)}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={cn('ml-2 h-4 w-4 shrink-0 opacity-50 transition-transform', open && 'rotate-180')} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
          style={menuStyle}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none hover:bg-muted',
                option.value === value && 'bg-primary/10 text-primary',
                option.disabled && 'pointer-events-none opacity-50',
              )}
              disabled={option.disabled}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="flex-1 truncate text-left">{option.label}</span>
              {option.hint && <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>}
              {option.value === value && (
                <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                  <Check className="h-4 w-4" />
                </span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
