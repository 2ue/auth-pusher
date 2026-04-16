export interface DataProfile {
  id: string;
  name: string;
  description: string;
  multiFile: boolean;
  recordsPath: string;
  fieldMapping: Record<string, string>;
  fingerprint: string[];
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}
