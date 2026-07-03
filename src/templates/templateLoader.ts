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
