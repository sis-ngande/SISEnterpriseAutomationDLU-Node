import * as fs from 'fs';

/**
 * Port of com.parser.json.JSONFileParser.
 * Resolves tokens of the form: data.<key>[<index>].<parameterKey>
 * e.g. "data.CreatePatient[1].firstName" -> value at 1-based index of the
 * "CreatePatient" array in the backing JSON file.
 */
export class JSONFileParser {
  private readonly jsonObj: Record<string, unknown>;

  constructor(private readonly path: string) {
    try {
      const raw = fs.readFileSync(path, 'utf-8');
      this.jsonObj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Error parsing JSON file - ${path}: ${(e as Error).message}`);
    }
  }

  getJsonFilePath(): string {
    return this.path;
  }

  getValueFromJsonObject(text: string): string | null {
    let normalized = text;
    if (normalized.includes('[num]')) {
      normalized = normalized.replace('[num]', '[1]');
    }

    const openBracket = normalized.indexOf('[');
    const closeBracket = normalized.indexOf(']');
    if (openBracket === -1 || closeBracket === -1) {
      throw new Error(`Error in text - ${normalized}`);
    }

    const testCaseKey = normalized.substring('data.'.length, openBracket);
    const dataSetNo = parseInt(normalized.substring(openBracket + 1, closeBracket), 10);
    if (Number.isNaN(dataSetNo)) {
      throw new Error(`Error referring data. Data index is not proper in text - ${normalized}`);
    }

    const dotAfterBracket = normalized.indexOf('].');
    const parameterKey = normalized.substring(dotAfterBracket + 2);

    try {
      const arr = this.jsonObj[testCaseKey];
      if (!Array.isArray(arr)) {
        throw new Error(`Invalid key - ${testCaseKey}`);
      }
      if (dataSetNo <= 0) {
        throw new Error(`Invalid dataSequence - ${dataSetNo}, must be greater than zero`);
      }
      if (dataSetNo > arr.length) {
        throw new Error(
          `Invalid dataSequence - ${dataSetNo}, greater than max size of data sets - ${arr.length}`
        );
      }
      const entry = arr[dataSetNo - 1];
      if (entry && typeof entry === 'object' && parameterKey in entry) {
        return String((entry as Record<string, unknown>)[parameterKey]);
      }
      throw new Error(`Invalid key - ${parameterKey}, key does not exist`);
    } catch (e) {
      return null;
    }
  }
}
