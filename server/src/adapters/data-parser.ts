import type { RawRecord } from '../../../shared/types/data.js';
import { parseJsonContent } from './json-parser.js';
import { parseCsvContent } from './csv-parser.js';
import fs from 'node:fs';
import path from 'node:path';

export type FileType = 'json' | 'csv';

export function detectFileType(filename: string): FileType {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  return 'json';
}

export function parseFileContent(
  content: string,
  fileType: FileType,
): { records: RawRecord[]; warnings: string[] } {
  switch (fileType) {
    case 'csv':
      return parseCsvContent(content);
    case 'json':
      return parseJsonContent(content);
    default:
      throw new Error(`不支持的文件格式: ${fileType}`);
  }
}

/**
 * 扫描目录中的所有 JSON 文件，每个文件作为一条记录合并
 */
export function parseDirectory(dirPath: string): { records: RawRecord[]; warnings: string[] } {
  if (!fs.existsSync(dirPath)) throw new Error(`目录不存在: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`路径不是目录: ${dirPath}`);

  const files = fs.readdirSync(dirPath)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();

  if (files.length === 0) throw new Error('目录中没有 JSON 文件');

  const records: RawRecord[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(dirPath, files[i]);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push({ index: i, fields: flattenForDir(parsed as Record<string, unknown>) });
      } else if (Array.isArray(parsed)) {
        // 文件本身是数组，每项作为一条记录
        for (const item of parsed) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            records.push({ index: records.length, fields: flattenForDir(item as Record<string, unknown>) });
          }
        }
        warnings.push(`${files[i]} 包含 ${parsed.length} 条记录`);
      } else {
        warnings.push(`${files[i]} 不是有效的 JSON 对象，已跳过`);
      }
    } catch (e) {
      warnings.push(`${files[i]} 解析失败: ${(e as Error).message}`);
    }
  }

  warnings.unshift(`从目录中读取了 ${files.length} 个文件，解析出 ${records.length} 条记录`);
  return { records, warnings };
}

/** 扁平化嵌套对象（与 json-parser 中相同逻辑） */
function flattenForDir(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[p] = value;
      Object.assign(result, flattenForDir(value as Record<string, unknown>, p));
    } else {
      result[p] = value;
    }
  }
  return result;
}

/**
 * 合并多个文件内容，每个文件作为一条记录
 */
export function parseMultipleFiles(
  files: { filename: string; content: string }[],
): { records: RawRecord[]; warnings: string[] } {
  const records: RawRecord[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const { filename, content } = files[i];
    const fileType = detectFileType(filename);
    try {
      const result = parseFileContent(content, fileType);
      for (const rec of result.records) {
        records.push({ index: records.length, fields: rec.fields });
      }
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings.map((w) => `[${filename}] ${w}`));
      }
    } catch (e) {
      warnings.push(`${filename} 解析失败: ${(e as Error).message}`);
    }
  }

  warnings.unshift(`从 ${files.length} 个文件中解析出 ${records.length} 条记录`);
  return { records, warnings };
}

/** 从记录集中提取所有不重复的字段名 */
export function extractFieldNames(records: RawRecord[]): string[] {
  const fields = new Set<string>();
  for (const record of records.slice(0, 100)) {
    for (const key of Object.keys(record.fields)) {
      // 跳过嵌套对象值的 key（只保留叶子节点和点路径）
      const value = record.fields[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) continue;
      fields.add(key);
    }
  }
  return Array.from(fields).sort();
}
