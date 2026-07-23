import { runAutomation, DEFAULT_EXCEL_PATH, TagResult } from './runner';

const SEED_DATA_TYPES = ['All'];

function printTimingTable(results: TagResult[]) {
  const rows = results.map((r) => ({
    Tag: r.tag,
    Rows: r.rows,
    OK: r.okCount,
    Failed: r.failCount,
    Patients: r.patientCount,
    'Time (s)': (r.durationMs / 1000).toFixed(2),
  }));

  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  console.log('\n=== Per-tag timing ===');
  console.table(rows);
  console.log(`Total time across all tags: ${(totalMs / 1000).toFixed(2)}s`);
}

async function main() {
  const excelPath = process.argv[2] ?? DEFAULT_EXCEL_PATH;
  const jsonPath = process.argv[3];
  const baseUrl = process.env.BASE_URL;

  if (!baseUrl) {
    console.error('BASE_URL environment variable is required (e.g. BASE_URL=https://... npx ts-node src/index.ts).');
    console.error('Alternatively, use the web UI (npm run web) to set the URL and Tag without env vars.');
    process.exit(1);
  }

  const results: TagResult[] = [];
  for (const tag of SEED_DATA_TYPES) {
    results.push(await runAutomation({ baseUrl, tag, excelPath, jsonPath }));
  }

  printTimingTable(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
