import { parse } from 'csv-parse/sync';
import type { RawRecord } from '../../../shared/types/data.js';

export function parseCsvContent(content: string): { records: RawRecord[]; warnings: string[] } {
  const warnings: string[] = [];

  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  if (rows.length === 0) {
    warnings.push('CSV 文件为空或没有数据行');
    return { records: [], warnings };
  }

  const records: RawRecord[] = rows.map((row, i) => ({
    index: i,
    fields: row,
  }));

  return { records, warnings };
}
