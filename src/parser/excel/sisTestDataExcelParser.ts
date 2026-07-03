import { ExcelParser } from './excelParser';
import { SEED_DATA_TYPE_LONG_TERM, SEED_DATA_TYPE_SHORT_TERM, TEST_CASE_COL_NAME } from '../../seeddata/iSeedDataProcessor';

/**
 * Port of com.parser.excel.SISTestDataExcelParser (subset used by the
 * seed-data pipeline: isRowSeededOrJIT + getTestCaseRowNumbers).
 */
export class SISTestDataExcelParser {
  private constructor(private readonly excelParser: ExcelParser) {}

  static async create(excelFilePath: string): Promise<SISTestDataExcelParser> {
    const excelParser = await ExcelParser.create(excelFilePath);
    return new SISTestDataExcelParser(excelParser);
  }

  isRowSeededOrJIT(sheetName: string, colName: string, expectedColValue: string, rowNum: number): boolean {
    const cellData = this.excelParser.getCellData(sheetName, colName, rowNum);
    switch (expectedColValue) {
      case SEED_DATA_TYPE_LONG_TERM:
        return cellData.toLowerCase() === SEED_DATA_TYPE_LONG_TERM.toLowerCase() || cellData === '';
      case SEED_DATA_TYPE_SHORT_TERM:
        return cellData.toLowerCase() === SEED_DATA_TYPE_SHORT_TERM.toLowerCase();
      default:
        return cellData.toLowerCase() === expectedColValue.toLowerCase();
    }
  }

  getTestCaseRowNumbers(sheetName: string, colName: string, expectedColValue: string): Set<number> {
    const matchingRows: number[] = [];
    const totalRows = this.excelParser.getRowCount(sheetName);

    for (let rowNum = 3; rowNum <= totalRows; rowNum++) {
      const cellData = this.excelParser.getCellData(sheetName, colName, rowNum);
      switch (expectedColValue) {
        case SEED_DATA_TYPE_LONG_TERM:
          if (cellData.toLowerCase() === SEED_DATA_TYPE_LONG_TERM.toLowerCase() || cellData === '') {
            matchingRows.push(rowNum);
          }
          break;
        case SEED_DATA_TYPE_SHORT_TERM:
          if (cellData.toLowerCase() === SEED_DATA_TYPE_SHORT_TERM.toLowerCase()) {
            matchingRows.push(rowNum);
          }
          break;
        default:
          if (cellData.toLowerCase() === expectedColValue.toLowerCase()) {
            matchingRows.push(rowNum);
          }
      }
    }

    const testCaseRows = new Set<number>();
    for (const row of matchingRows) {
      testCaseRows.add(this.getTestCaseRowInSeedDataSheets(sheetName, row));
    }
    return testCaseRows;
  }

  private getTestCaseRowInSeedDataSheets(sheetName: string, rowNum: number): number {
    let row = rowNum;
    while (this.excelParser.getCellData(sheetName, TEST_CASE_COL_NAME, row).trim() === '') {
      row--;
    }
    return row;
  }
}
