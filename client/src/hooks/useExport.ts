import { useState } from 'react';
import { getApiKeyHeader } from '../api/client';
import { buildExportFilename } from '../utils/data-helpers';
import type { ExportOptions } from '../components/ExportDialog';

export interface ExportRow {
  index: number;
  email: string;
  accountId: string;
  planType: string;
}

export function useExport() {
  const [exporting, setExporting] = useState(false);

  async function sendExport(
    fileId: string,
    rows: ExportRow[],
    fieldMapping: Record<string, string>,
    options: ExportOptions,
    downloadSlug: string,
  ) {
    const items = rows.map((row) => ({
      index: row.index,
      filename: buildExportFilename(row.index, row.email, row.accountId),
      email: row.email,
      accountId: row.accountId,
      planType: options.planTypeOverride || row.planType || undefined,
      planField: fieldMapping.plan_type || undefined,
    }));

    const downloadName = `${downloadSlug}-${options.format}${options.mode === 'merged' ? '-merged' : ''}-${new Date().toISOString().slice(0, 10)}`;

    const response = await fetch('/api/data/export-accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getApiKeyHeader(),
      },
      body: JSON.stringify({
        fileId,
        format: options.format,
        mode: options.mode,
        downloadName,
        items,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const ext = options.mode === 'merged' ? 'json' : 'zip';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${downloadName}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    return { count: items.length, mode: options.mode };
  }

  return { exporting, setExporting, sendExport };
}
