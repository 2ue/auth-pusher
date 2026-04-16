import type { RawRecord, MappedDataItem, FieldMapping } from '../../../shared/types/data.js';

/** 从对象中按点路径取值 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  // 先尝试直接取（扁平化后的 key 可能包含点）
  if (path in obj) return obj[path];

  // 再按点路径逐层深入
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 将原始记录按字段映射转换为标准数据项
 */
export function applyFieldMapping(
  records: RawRecord[],
  mapping: FieldMapping,
  requiredFields: string[],
): MappedDataItem[] {
  return records.map((record) => {
    const fields: Record<string, unknown> = {};
    const validationErrors: string[] = [];

    for (const [standardField, sourcePath] of Object.entries(mapping)) {
      if (!sourcePath) continue;
      const value = getByPath(record.fields, sourcePath);
      if (value !== undefined && value !== null && value !== '') {
        fields[standardField] = value;
      }
    }

    // 验证必填字段
    for (const req of requiredFields) {
      if (!fields[req] && fields[req] !== 0 && fields[req] !== false) {
        validationErrors.push(`缺少必填字段: ${req}`);
      }
    }

    // 用 email 或第一个字段值作为标识符
    const identifier = String(fields.email ?? fields.name ?? fields.token ?? `#${record.index}`);

    return {
      index: record.index,
      identifier,
      fields,
      valid: validationErrors.length === 0,
      validationErrors,
    };
  });
}
