import { useState, useEffect } from 'react';
import { get, upload } from '../api/client';

/* ── 共享类型 ── */

export interface ParsedData {
  fileId: string;
  totalRecords: number;
  sampleRecords: { index: number; fields: Record<string, unknown> }[];
  detectedFields: string[];
  suggestedMapping: Record<string, string>;
  fileType: string;
  parseWarnings: string[];
  matchedProfileId?: string;
  matchedProfileName?: string;
  batchId?: string;
  fileCount?: number;
}

export interface ParsedRecordPage {
  totalRecords: number;
  records: { index: number; fields: Record<string, unknown> }[];
}

export interface DataProfileItem {
  id: string;
  name: string;
  fieldMapping: Record<string, string>;
  builtin?: boolean;
}

/* ── Hook ── */

export function useFileImport() {
  const [profiles, setProfiles] = useState<DataProfileItem[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [records, setRecords] = useState<ParsedRecordPage['records']>([]);
  const [uploading, setUploading] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});

  useEffect(() => {
    get<DataProfileItem[]>('/profiles').then(setProfiles);
  }, []);

  async function loadAllRecords(fileId: string, totalRecords: number): Promise<ParsedRecordPage['records']> {
    setLoadingRecords(true);
    try {
      const all: ParsedRecordPage['records'] = [];
      const limit = 500;
      for (let offset = 0; offset < totalRecords; offset += limit) {
        const pageData = await get<ParsedRecordPage>(`/data/records/${encodeURIComponent(fileId)}?offset=${offset}&limit=${limit}`);
        all.push(...pageData.records);
        if (pageData.records.length < limit) break;
      }
      setRecords(all);
      return all;
    } finally {
      setLoadingRecords(false);
    }
  }

  async function handleFileUpload(
    fileList: FileList | null,
    mode: 'replace' | 'append' = 'replace',
  ): Promise<{ action: 'replace' | 'append'; added?: number; duplicated?: number } | null> {
    if (!fileList || fileList.length === 0) return null;
    setUploading(true);
    setUploadError('');

    if (mode === 'replace') {
      setParsedData(null);
      setRecords([]);
    }

    try {
      if (mode === 'append' && parsedData) {
        const formData = new FormData();
        for (let index = 0; index < fileList.length; index++) {
          formData.append('files', fileList[index]);
        }
        const result = await upload<{
          fileId: string;
          totalRecords: number;
          added: number;
          duplicated: number;
          detectedFields: string[];
          parseWarnings: string[];
        }>(`/data/append/${encodeURIComponent(parsedData.fileId)}`, formData);

        setParsedData((current) => current ? {
          ...current,
          totalRecords: result.totalRecords,
          detectedFields: Array.from(new Set([...current.detectedFields, ...result.detectedFields])),
          parseWarnings: [...current.parseWarnings, ...result.parseWarnings],
          fileCount: (current.fileCount ?? 1) + fileList.length,
        } : current);
        await loadAllRecords(result.fileId, result.totalRecords);
        return { action: 'append', added: result.added, duplicated: result.duplicated };
      }

      const formData = new FormData();
      let data: ParsedData;
      if (fileList.length === 1) {
        formData.append('file', fileList[0]);
        data = await upload<ParsedData>('/data/parse', formData);
      } else {
        for (let index = 0; index < fileList.length; index++) {
          formData.append('files', fileList[index]);
        }
        data = await upload<ParsedData>('/data/parse-multi', formData);
      }

      setParsedData(data);
      setFieldMapping(data.suggestedMapping);
      setSelectedProfileId(data.matchedProfileId ?? '');
      await loadAllRecords(data.fileId, data.totalRecords);
      return { action: 'replace' };
    } catch (err) {
      setUploadError((err as Error).message);
      return null;
    } finally {
      setUploading(false);
    }
  }

  function handleProfileSelect(profileId: string) {
    setSelectedProfileId(profileId);
    if (!profileId) return;
    const matched = profiles.find((profile) => profile.id === profileId);
    if (matched) {
      setFieldMapping(matched.fieldMapping);
    }
  }

  return {
    profiles,
    selectedProfileId,
    parsedData,
    records,
    uploading,
    loadingRecords,
    uploadError,
    fieldMapping,
    setFieldMapping,
    handleFileUpload,
    handleProfileSelect,
  };
}
