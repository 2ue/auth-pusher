import { Button } from '@/components/ui/button';
import { SelectField } from './SelectField';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const SIZES = [10, 20, 50, 100];

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safeP = Math.min(page, totalPages - 1);

  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm text-muted-foreground">
      <span>共 {total} 条</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={safeP <= 0} onClick={() => onPageChange(safeP - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs min-w-[60px] text-center">{safeP + 1} / {totalPages}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={safeP >= totalPages - 1} onClick={() => onPageChange(safeP + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <SelectField
          value={String(pageSize)}
          size="sm"
          onChange={(v) => {
            onPageSizeChange(Number(v));
            onPageChange(0);
          }}
          options={SIZES.map((s) => ({ value: String(s), label: `${s} 条` }))}
          style={{ width: 80 }}
        />
      </div>
    </div>
  );
}
