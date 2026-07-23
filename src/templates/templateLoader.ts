import * as fs from 'fs';
import * as path from 'path';

/**
 * Port of JsonUtils.getJsonFileAsObject + updateOneJsonElement usage pattern
 * seen throughout WebServiceClient/ReUsableWebserviceUtils: load a static
 * request-body skeleton from reqTemplates/*.json, then mutate specific
 * fields before POSTing.
 *
 * Templates are cached by path (the file itself never changes at runtime),
 * but every call returns a fresh deep clone so callers can safely mutate
 * their own copy without affecting other concurrent operations/rows.
 */
export class TemplateLoader {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly templatesDir: string) {}

  load<T = Record<string, unknown>>(templateFileName: string): T {
    const key = templateFileName;
    let parsed = this.cache.get(key);
    if (parsed === undefined) {
      const fullPath = path.join(this.templatesDir, templateFileName);
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      this.cache.set(key, parsed);
    }
    return JSON.parse(JSON.stringify(parsed)) as T;
  }
}

/** Port of JsonUtils.updateOneJsonElement - sets a single top-level field. */
export function updateField<T extends Record<string, unknown>>(obj: T, key: string, value: unknown): T {
  obj[key as keyof T] = value as T[keyof T];
  return obj;
}

function pathTokens(jsonPath: string): (string | number)[] {
  return (jsonPath.match(/[^.[\]]+/g) ?? []).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}

/**
 * Port of JsonUtils.updateObjectJsonXpath - sets a value at a dotted/bracketed
 * path (e.g. "patient.address", "caseProcedures[0].cptCode") on a mutable
 * object graph, mutating obj in place and returning it for chaining.
 */
export function setPath<T>(obj: T, jsonPath: string, value: unknown): T {
  const tokens = pathTokens(jsonPath);
  let cur: any = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    cur = cur[tokens[i]];
  }
  cur[tokens[tokens.length - 1]] = value;
  return obj;
}

/** Port of JsonUtils.getObjectFromJsonXpath - reads a value at a dotted/bracketed path. */
export function getPath(obj: unknown, jsonPath: string): unknown {
  const tokens = pathTokens(jsonPath);
  let cur: any = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

/**
 * Port of JsonUtils.getJSONObjectFromJSONArray - finds the first element whose fieldName
 * matches fieldValue. Case-insensitive, matching the Java original's `.equalsIgnoreCase(value)`.
 */
export function findByField<T extends Record<string, unknown>>(arr: T[], fieldName: string, fieldValue: string): T | undefined {
  const target = fieldValue.toLowerCase();
  return arr.find((item) => String(item[fieldName]).toLowerCase() === target);
}
