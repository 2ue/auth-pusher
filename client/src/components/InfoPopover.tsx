import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export function InfoPopover({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center h-6 w-6 rounded-full border border-border hover:border-primary bg-card text-muted-foreground hover:text-primary cursor-pointer transition-colors"
          aria-label={title ?? '查看说明'}
        >
          <Info className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        {title && <div className="text-sm font-bold mb-1.5">{title}</div>}
        <div className="text-xs text-muted-foreground leading-relaxed">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
