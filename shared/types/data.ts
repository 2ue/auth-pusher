export interface RawRecord {
  index: number;
  fields: Record<string, unknown>;
}

export interface ParsedData {
  fileId: string;
  totalRecords: number;
  sampleRecords: RawRecord[];
  detectedFields: string[];
  suggestedMapping: Record<string, string>;
  fileType: 'json' | 'csv';
  parseWarnings: string[];
  matchedProfileId?: string;
  matchedProfileName?: string;
}

export interface ParsedRecordPage {
  totalRecords: number;
  records: RawRecord[];
}

export type FieldMapping = Record<string, string>;

export interface MappedDataItem {
  index: number;
  identifier: string;
  fields: Record<string, unknown>;
  valid: boolean;
  validationErrors: string[];
}
