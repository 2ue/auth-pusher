import type { RawRecord } from '../../../shared/types/data.js';

const ARRAY_KEYS = ['data', 'accounts', 'items', 'records', 'users', 'results', 'list', 'rows'];

export function parseJsonContent(content: string): { records: RawRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${(e as Error).message}`);
  }

  let rawItems: unknown[];

  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // 尝试从常见 key 中找到数组
    let found = false;
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(obj[key])) {
        rawItems = obj[key] as unknown[];
        warnings.push(`从 "${key}" 字段中提取了 ${rawItems.length} 条记录`);
        found = true;
        break;
      }
    }
    if (!found) {
      // 扫描所有值找第一个数组
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          rawItems = value;
          warnings.push(`从 "${key}" 字段中提取了 ${rawItems.length} 条记录`);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      // 单个对象作为一条记录
      rawItems = [obj];
      warnings.push('输入为单个对象，作为一条记录处理');
    }
  } else {
    throw new Error('JSON 内容必须是对象或数组');
  }

  const records: RawRecord[] = [];
  for (let i = 0; i < rawItems!.length; i++) {
    const item = rawItems![i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      records.push({
        index: i,
        fields: flattenObject(item as Record<string, unknown>),
      });
    } else {
      warnings.push(`第 ${i + 1} 条记录不是对象，已跳过`);
    }
  }

  return { records, warnings };
}

/** 扁平化嵌套对象，用点路径作为 key */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // 保留原始 key 同时展开子级
      result[path] = value;
      Object.assign(result, flattenObject(value as Record<string, unknown>, path));
    } else {
      result[path] = value;
    }
  }

  return result;
}
