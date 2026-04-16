export interface FileRecord {
  id: string;
  /** 批次ID：同一次上传的多个文件共享同一个 batchId */
  batchId: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  associatedTaskIds: string[];
}
