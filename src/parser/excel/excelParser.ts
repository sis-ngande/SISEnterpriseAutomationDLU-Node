import ExcelJS from 'exceljs';
import { JSONFileParser } from '../json/jsonFileParser';

interface SheetHeaderCache {
  /** column name (trimmed) -> 1-based column number, built from header row (row 1) */
  colNameToNum: Map<string, number>;
  headerLastCellNum: number;
}

/**
 * Port of com.parser.excel.ExcelParser (read-focused subset used by the
 * seed-data pipeline). All row/column numbers are 1-based to match the Java
 * source and reduce translation risk.
 *
 * Unlike the Java original, header/column lookups are cached per sheet on
 * first use instead of re-scanning the header row on every call.
 */
export class ExcelParser {
  private workbook!: ExcelJS.Workbook;
  private jsonFileParser: JSONFileParser | null = null;
  private headerCache = new Map<string, SheetHeaderCache>();

  private constructor(
    private readonly excelFilePath: string,
    private readonly jsonFilePath?: string
  ) {}

  static async create(excelFilePath: string, jsonFilePath?: string): Promise<ExcelParser> {
    const parser = new ExcelParser(excelFilePath, jsonFilePath);
    parser.workbook = new ExcelJS.Workbook();
    await parser.workbook.xlsx.readFile(excelFilePath);
    if (jsonFilePath) {
      parser.jsonFileParser = new JSONFileParser(jsonFilePath);
    }
    return parser;
  }

  getExcelFilePath(): string {
    return this.excelFilePath;
  }

  getJsonFilePath(): string | undefined {
    return this.jsonFilePath;
  }

  isSheetExist(sheetName: string): boolean {
    return this.workbook.getWorksheet(sheetName) != null;
  }

  private getSheet(sheetName: string): ExcelJS.Worksheet {
    const sheet = this.workbook.getWorksheet(sheetName);
    if (!sheet) {
      throw new Error(`Sheet not found - ${sheetName}`);
    }
    return sheet;
  }

  private buildHeaderCache(sheetName: string): SheetHeaderCache {
    const cached = this.headerCache.get(sheetName);
    if (cached) return cached;

    const sheet = this.getSheet(sheetName);
    const headerRow = sheet.getRow(1);
    const colNameToNum = new Map<string, number>();
    const lastCellNum = headerRow.cellCount;

    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const value = this.cellRawString(cell);
      if (value) {
        colNameToNum.set(value.trim().toLowerCase(), colNumber);
      }
    });

    const cache: SheetHeaderCache = { colNameToNum, headerLastCellNum: lastCellNum };
    this.headerCache.set(sheetName, cache);
    return cache;
  }

  private cellRawString(cell: ExcelJS.Cell): string {
    if (cell.value == null) return '';
    if (typeof cell.value === 'object' && 'result' in (cell.value as any)) {
      return String((cell.value as any).result ?? '');
    }
    return String(cell.value);
  }

  /** 1-based column number for colName, or 0 if not found (parity with Java: colNum+1 when not found -> 0) */
  getColNumber(sheetName: string, colName: string): number {
    const cache = this.buildHeaderCache(sheetName);
    return cache.colNameToNum.get(colName.trim().toLowerCase()) ?? 0;
  }

  /** Sub-header (row 2) lookup for merged/spanned groups: colName within [colStart, colEnd] */
  private getSubColNumber(sheetName: string, subColName: string, candidateCols: number[]): number {
    const sheet = this.getSheet(sheetName);
    const subHeaderRow = sheet.getRow(2);
    for (const col of candidateCols) {
      const value = this.cellRawString(subHeaderRow.getCell(col)).trim().toLowerCase();
      if (value === subColName.trim().toLowerCase()) {
        return col;
      }
    }
    return -1;
  }

  /**
   * True if the column header at colName has additional spanned sub-columns
   * to its right (header cell(s) immediately following are blank).
   */
  isMergedCell(sheetName: string, colName: string): boolean {
    const colNum = this.getColNumber(sheetName, colName);
    const sheet = this.getSheet(sheetName);
    const headerRow = sheet.getRow(1);
    const nextCell = headerRow.getCell(colNum + 1);
    return this.cellRawString(nextCell).trim() === '';
  }

  /** 1-based column numbers spanned by colName's group (colName's own column + any blank-header columns after it) */
  getMergedColNumbers(sheetName: string, colName: string): number[] {
    const colNum = this.getColNumber(sheetName, colName);
    const columns = [colNum];
    const sheet = this.getSheet(sheetName);
    const headerRow = sheet.getRow(1);
    const lastCol = headerRow.cellCount;
    for (let i = colNum + 1; i <= lastCol; i++) {
      const value = this.cellRawString(headerRow.getCell(i)).trim();
      if (value === '') {
        columns.push(i);
      } else {
        break;
      }
    }
    return columns;
  }

  isColumnEmpty(sheetName: string, colName: string, rowNum: number): boolean {
    const spanned = this.getMergedColNumbers(sheetName, colName);
    for (const colNum of spanned) {
      const data = this.getCellDataByColNum(sheetName, colNum, rowNum);
      if (data != null && data.trim() !== '') {
        return false;
      }
    }
    return true;
  }

  isRowEmpty(sheetName: string, rowNum: number): boolean {
    const totalCols = this.getColumnCount(sheetName, rowNum);
    for (let i = 1; i <= totalCols; i++) {
      const data = this.getCellDataByColNum(sheetName, i, rowNum);
      if (data.trim() !== '') return false;
    }
    return true;
  }

  getRowCount(sheetName: string): number {
    return this.getSheet(sheetName).rowCount;
  }

  getColumnCount(sheetName: string, rowNumber?: number): number {
    if (!this.isSheetExist(sheetName)) return -1;
    const sheet = this.getSheet(sheetName);
    const row = rowNumber != null ? sheet.getRow(rowNumber) : sheet.getRow(1);
    if (!row || row.cellCount === 0) return -1;
    return row.cellCount;
  }

  getAllSheets(exclusiveSheets?: string[]): string[] {
    const names: string[] = [];
    this.workbook.eachSheet((sheet) => {
      if (!exclusiveSheets || !exclusiveSheets.includes(sheet.name)) {
        names.push(sheet.name);
      }
    });
    return names;
  }

  getAllColNames(sheetName: string, afterColName?: string): string[] {
    const sheet = this.getSheet(sheetName);
    const headerRow = sheet.getRow(1);
    const startCol = afterColName ? this.getColNumber(sheetName, afterColName) + 1 : 1;
    const names: string[] = [];
    for (let i = startCol; i <= headerRow.cellCount; i++) {
      const value = this.cellRawString(headerRow.getCell(i)).trim();
      if (value !== '') {
        names.push(value);
      }
    }
    return names;
  }

  /**
   * Core cell-data accessor. Applies the same multi-value (`;`, `,`, `|`) and
   * `data.xxx` JSON-lookup resolution as the Java ExcelParser.getCellData(sheetName, colNum, rowNum).
   */
  getCellDataByColNum(sheetName: string, colNum: number, rowNum: number): string {
    if (rowNum <= 0 || colNum <= 0) return '';
    const sheet = this.getSheet(sheetName);
    const row = sheet.getRow(rowNum);
    if (!row) return '';
    const cell = row.getCell(colNum);
    if (!cell || cell.value == null) return '';

    let text: string;
    if (cell.type === ExcelJS.ValueType.Date) {
      const d = cell.value as Date;
      const yy = String(d.getFullYear()).slice(2);
      text = `${d.getMonth() + 1}/${d.getDate()}/${yy}`;
    } else {
      text = this.cellRawString(cell);
    }

    if (text.includes(';') || text.includes(',') || text.includes('|')) {
      if (text.toLowerCase().includes('data.')) {
        return this.resolveMultiValueJsonLookup(text);
      }
      return text;
    }

    if (text.toLowerCase().startsWith('data.')) {
      return this.jsonFileParser?.getValueFromJsonObject(text) ?? '';
    }
    return text;
  }

  private resolveMultiValueJsonLookup(text: string): string {
    const bySemicolon = text.split(';').map((semiColonKey) => {
      const byComma = semiColonKey.split(',').map((commaKey) => {
        const byPipe = commaKey.split('|').map((pipeKey) => this.jsonFileParser?.getValueFromJsonObject(pipeKey) ?? '');
        return byPipe.join('|');
      });
      return byComma.join(',');
    });
    return bySemicolon.join(';');
  }

  getCellData(sheetName: string, colName: string, rowNum: number): string {
    const colNum = this.getColNumber(sheetName, colName);
    return this.getCellDataByColNum(sheetName, colNum, rowNum);
  }

  /** Merged-cell variant: resolve subColName within colName's spanned group, then read. */
  getCellDataMerged(sheetName: string, colName: string, subColName: string, rowNum: number): string {
    if (this.isMergedCell(sheetName, colName)) {
      const spanned = this.getMergedColNumbers(sheetName, colName);
      const colNum = this.getSubColNumber(sheetName, subColName, spanned);
      return this.getCellDataByColNum(sheetName, colNum, rowNum);
    }
    return this.getCellData(sheetName, colName, rowNum);
  }

  /** Filtered variant: only returns data if rowNum falls within filterColData's used range. */
  getCellDataFiltered(
    sheetName: string,
    filterColName: string,
    filterColData: string,
    dataColName: string,
    dataSubColName: string,
    rowNum: number
  ): string | null {
    const usedRange = this.getUsedRangeRowNumbers(sheetName, filterColName, filterColData);
    if (usedRange.includes(rowNum)) {
      return this.getCellDataMerged(sheetName, dataColName, dataSubColName, rowNum);
    }
    return null;
  }

  getUsedRangeRowNumbers(sheetName: string, colName: string, cellValue: string): number[] {
    const result: number[] = [];
    const totalRows = this.getRowCount(sheetName);
    let startRow = -1;

    for (let r = 2; r <= totalRows; r++) {
      if (!this.isRowEmpty(sheetName, r) && this.getCellData(sheetName, colName, r).trim().toLowerCase() === cellValue.toLowerCase()) {
        result.push(r);
        startRow = r;
        break;
      }
    }

    if (startRow !== -1 && startRow < totalRows) {
      for (let r = startRow + 1; r <= totalRows; r++) {
        const cell = this.getCellData(sheetName, colName, r).trim();
        if (!this.isRowEmpty(sheetName, r) && (cell.toLowerCase() === cellValue.toLowerCase() || cell === '')) {
          result.push(r);
        } else {
          break;
        }
      }
    }

    return result;
  }
}
