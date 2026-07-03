import path from 'path';
import { WebServiceSeedDataProcessor } from './seeddata/webServiceSeedDataProcessor';
import { SEED_DATA_TYPE_LONG_TERM } from './seeddata/iSeedDataProcessor';

async function main() {
  const excelPath = process.argv[2] ?? path.resolve(__dirname, '../seedData/seedData.xlsx');
  const jsonPath = process.argv[3];

  const processor = await WebServiceSeedDataProcessor.create(excelPath, jsonPath);
  const seedData = await processor.getAllSeedDataForType(SEED_DATA_TYPE_LONG_TERM);

  console.log(`Parsed ${seedData.length} seed-data rows from ${excelPath}`);
  for (const sd of seedData.slice(0, 5)) {
    console.log(JSON.stringify({ testCase: sd.testCase, rowNumber: sd.rowNumber, operations: Object.fromEntries(
      Array.from(sd.operations.entries()).map(([op, params]) => [op, Object.fromEntries(params)])
    ) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
