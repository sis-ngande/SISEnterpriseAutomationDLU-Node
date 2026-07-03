import { SeedData } from './seedData';

/** Port of com.seeddata.ISeedDataProcessor constants + contract */
export const SEED_DATA_TYPE_LONG_TERM = 'SD';
export const SEED_DATA_TYPE_SHORT_TERM = 'JIT';
export const TEST_CASE_COL_NAME = 'TestCase';
export const TEST_CASES_FILTER_COL_NAME = 'SeedDataType';

export interface ISeedDataProcessor {
  getAllSeedDataForType(seedDataType: string): Promise<SeedData[]>;
  getAllSeedDataForSheet(sheetName: string, seedDataType: string): Promise<SeedData[]>;
  getAllSeedDataExcluding(exclusiveSheetNames: string[], seedDataType: string): Promise<SeedData[]>;
}
