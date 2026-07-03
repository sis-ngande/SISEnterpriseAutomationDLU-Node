import { ExcelParser } from '../parser/excel/excelParser';
import { SISTestDataExcelParser } from '../parser/excel/sisTestDataExcelParser';
import { SeedData, OperationMap } from './seedData';
import { TEST_CASE_COL_NAME, TEST_CASES_FILTER_COL_NAME } from './iSeedDataProcessor';

/**
 * Port of com.seeddata.WebServiceSeedDataProcessor.
 * Reads the seed-data Excel workbook and converts it into SeedData[] objects
 * ready to be handed off to a WebServiceClient/StoredProcClient for execution.
 */
export class WebServiceSeedDataProcessor {
  private constructor(
    private readonly excelParser: ExcelParser,
    private readonly sisTestDataExcelParser: SISTestDataExcelParser
  ) {}

  static async create(excelFilePath: string, jsonFilePath?: string): Promise<WebServiceSeedDataProcessor> {
    const excelParser = await ExcelParser.create(excelFilePath, jsonFilePath);
    const sisTestDataExcelParser = await SISTestDataExcelParser.create(excelFilePath);
    return new WebServiceSeedDataProcessor(excelParser, sisTestDataExcelParser);
  }

  async getAllSeedDataForType(seedDataType: string): Promise<SeedData[]> {
    const listSeedData: SeedData[] = [];
    for (const sheetName of this.excelParser.getAllSheets()) {
      listSeedData.push(...(await this.getAllSeedDataForSheet(sheetName, seedDataType)));
    }
    return listSeedData;
  }

  async getAllSeedDataExcluding(exclusiveSheetNames: string[], seedDataType: string): Promise<SeedData[]> {
    const listSeedData: SeedData[] = [];
    for (const sheetName of this.excelParser.getAllSheets(exclusiveSheetNames)) {
      listSeedData.push(...(await this.getAllSeedDataForSheet(sheetName, seedDataType)));
    }
    return listSeedData;
  }

  async getAllSeedDataForSheet(sheetName: string, seedDataType: string): Promise<SeedData[]> {
    const listSeedData: SeedData[] = [];

    // all operation columns after the SeedDataType filter column
    const colNames = this.excelParser.getAllColNames(sheetName, TEST_CASES_FILTER_COL_NAME);

    // rows whose SeedDataType matches, rolled up to their owning test-case row
    const testCaseRowNums = this.sisTestDataExcelParser.getTestCaseRowNumbers(
      sheetName,
      TEST_CASES_FILTER_COL_NAME,
      seedDataType
    );

    for (const testCaseRowNum of testCaseRowNums) {
      const testCase = this.excelParser.getCellData(sheetName, TEST_CASE_COL_NAME, testCaseRowNum);

      const usedRangeRowNums = this.excelParser.getUsedRangeRowNumbers(sheetName, TEST_CASE_COL_NAME, testCase);

      for (const usedRangeRowNum of usedRangeRowNums) {
        if (
          !this.sisTestDataExcelParser.isRowSeededOrJIT(sheetName, TEST_CASES_FILTER_COL_NAME, seedDataType, usedRangeRowNum)
        ) {
          continue;
        }

        const operations: OperationMap = new Map();

        for (const colName of colNames) {
          if (this.excelParser.isColumnEmpty(sheetName, colName, usedRangeRowNum)) {
            continue;
          }

          const subColParams = new Map<string, string>();
          const spannedColNums = this.excelParser.getMergedColNumbers(sheetName, colName);

          for (const colNum of spannedColNums) {
            const subColName = this.excelParser.getCellDataByColNum(sheetName, colNum, 2);
            const testColData = this.excelParser.getCellDataFiltered(
              sheetName,
              TEST_CASE_COL_NAME,
              testCase,
              colName,
              subColName,
              usedRangeRowNum
            );
            subColParams.set(subColName, testColData ?? '');
          }

          operations.set(colName, subColParams);
        }

        listSeedData.push(new SeedData(testCase, usedRangeRowNum, operations));
      }
    }

    return listSeedData;
  }
}
