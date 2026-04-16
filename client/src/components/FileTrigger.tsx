import { forwardRef, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export const FileTrigger = forwardRef<HTMLInputElement, {
  onFiles: (files: FileList | null) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  variant?: 'button' | 'dropzone';
  children: ReactNode;
}>(
  function FileTrigger({
    onFiles,
    accept,
    multiple,
    disabled,
    className,
    style,
    variant = 'button',
    children,
  }, ref) {
    const localRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (!ref) return;
      if (typeof ref === 'function') {
        ref(localRef.current);
        return () => ref(null);
      }
      ref.current = localRef.current;
      return () => { ref.current = null; };
    }, [ref]);

    const handleClick = () => {
      if (!disabled) localRef.current?.click();
    };

    return (
      <>
        {variant === 'dropzone' ? (
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-8 text-center cursor-pointer transition-colors hover:border-primary hover:bg-muted/50',
              disabled && 'opacity-50 cursor-not-allowed',
              className,
            )}
            style={style}
            onClick={handleClick}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                localRef.current?.click();
              }
            }}
          >
            {children}
          </div>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={disabled}
            className={className}
            style={style}
            onClick={handleClick}
          >
            {children}
          </Button>
        )}
        <input
          ref={localRef}
          type="file"
          accept={accept}
          multiple={multiple}
          style={{ display: 'none' }}
          onChange={(e) => onFiles(e.target.files)}
        />
      </>
    );
  },
);
