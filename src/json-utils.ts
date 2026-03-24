import * as fs from "fs";

const UTF8_BOM = 0xfeff;

// 兼容某些编辑器写入的 UTF-8 BOM，避免 JSON.parse 在启动阶段直接失败。
export function stripUtf8Bom(text: string): string {
  if (!text) return text;
  return text.charCodeAt(0) === UTF8_BOM ? text.slice(1) : text;
}

export function parseJsonText<T = any>(text: string): T {
  return JSON.parse(stripUtf8Bom(text)) as T;
}

export function readJsonFile<T = any>(filePath: string): T {
  return parseJsonText<T>(fs.readFileSync(filePath, "utf-8"));
}

export function readJsonFileOr<T>(filePath: string, fallback: T): T {
  try {
    return readJsonFile<T>(filePath);
  } catch {
    return fallback;
  }
}
