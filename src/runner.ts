import path from 'path';
import { WebServiceSeedDataProcessor } from './seeddata/webServiceSeedDataProcessor';
import { WebServiceClient } from './client/webservice/webServiceClient';
import { ResponseCache } from './client/webservice/responseCache';
import { SeedData } from './seeddata/seedData';

export const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '../reqTemplates');
export const DEFAULT_EXCEL_PATH = path.resolve(__dirname, '../src/seeddata/seedData.xlsx');

// Rows sharing a TestCase are frequently dependent on each other (one row creates a
// resource - a room, an insurance carrier, a period/batch - that a later row in the same
// TestCase consumes), matching the Java original's guarantee that everything runs strictly
// line-by-line with no concurrency. Grouping by TestCase and running each group's rows
// sequentially preserves that guarantee; different groups still run concurrently for throughput.
export const DEFAULT_GROUP_CONCURRENCY = 10; // testCase groups run per wave
export const DEFAULT_WAVE_PAUSE_MS = 5000; // breathing gap between waves, so the backend/DB isn't under sustained non-stop load

export interface RunOptions {
  baseUrl: string;
  tag: string;
  excelPath?: string;
  jsonPath?: string;
  templatesDir?: string;
  groupConcurrency?: number;
  wavePauseMs?: number;
  onEvent?: (event: RunEvent) => void;
}

export type RunEvent =
  | { type: 'parsed'; totalRows: number; totalGroups: number; startedAt: number }
  | { type: 'waveStart'; waveNum: number; totalWaves: number; groups: number; rows: number }
  | { type: 'row'; testCase: string; rowNumber: number; result: 'ok' | 'fail'; message?: string; isPatient?: boolean }
  | { type: 'waveDone'; waveNum: number; ok: number; fail: number }
  | { type: 'summary'; tag: string; okCount: number; failCount: number; patientCount: number; durationMs: number };

export interface GroupResult {
  testCase: string;
  rows: number;
  ok: number;
  fail: number;
  patients: number;
}

export interface TagResult {
  tag: string;
  rows: number;
  okCount: number;
  failCount: number;
  patientCount: number;
  durationMs: number;
}

async function runRow(sd: SeedData, baseUrl: string, templatesDir: string, onEvent?: (event: RunEvent) => void): Promise<'ok' | 'fail'> {
  const client = new WebServiceClient(baseUrl, new ResponseCache(), templatesDir);
  const isPatient = sd.operations.has('PatientCreation');
  try {
    await client.callWebService(sd);
    console.log(`[OK] testCase=${sd.testCase} row=${sd.rowNumber}`);
    if (isPatient) {
      const facility = sd.operations.get('PatientCreation')?.get('facility');
      console.log(`  -> patient created in facility=${facility} testCase=${sd.testCase} row=${sd.rowNumber}`);
    }
    onEvent?.({ type: 'row', testCase: sd.testCase, rowNumber: sd.rowNumber, result: 'ok', isPatient });
    return 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[FAIL] testCase=${sd.testCase} row=${sd.rowNumber}:`, err);
    onEvent?.({ type: 'row', testCase: sd.testCase, rowNumber: sd.rowNumber, result: 'fail', message, isPatient });
    return 'fail';
  }
}

/** Rows in the same testCase group run one after another - never concurrently with each other. */
async function runGroup(
  testCase: string,
  rows: SeedData[],
  baseUrl: string,
  templatesDir: string,
  onEvent?: (event: RunEvent) => void
): Promise<GroupResult> {
  let ok = 0;
  let fail = 0;
  let patients = 0;

  for (const sd of rows) {
    const result = await runRow(sd, baseUrl, templatesDir, onEvent);
    if (result === 'ok') {
      ok++;
      if (sd.operations.has('PatientCreation')) patients++;
    } else {
      fail++;
    }
  }

  return { testCase, rows: rows.length, ok, fail, patients };
}

/** Groups seedData by testCase (case-insensitive), preserving first-seen group order and each group's row order. */
function groupByTestCase(seedData: SeedData[]): Map<string, SeedData[]> {
  const groups = new Map<string, SeedData[]>();
  for (const sd of seedData) {
    const key = sd.testCase.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.push(sd);
    } else {
      groups.set(key, [sd]);
    }
  }
  return groups;
}

export async function runAutomation(options: RunOptions): Promise<TagResult> {
  const {
    baseUrl,
    tag,
    excelPath = DEFAULT_EXCEL_PATH,
    jsonPath,
    templatesDir = DEFAULT_TEMPLATES_DIR,
    groupConcurrency = DEFAULT_GROUP_CONCURRENCY,
    wavePauseMs = DEFAULT_WAVE_PAUSE_MS,
    onEvent,
  } = options;

  const startedAt = Date.now();

  const processor = await WebServiceSeedDataProcessor.create(excelPath, jsonPath);
  const seedData = await processor.getAllSeedDataForType(tag);
  const groups = groupByTestCase(seedData);
  const groupEntries = Array.from(groups.entries());

  console.log(
    `\n=== [${tag}] Parsed ${seedData.length} seed-data rows from ${excelPath} into ${groupEntries.length} testCase group(s) ===`
  );
  onEvent?.({ type: 'parsed', totalRows: seedData.length, totalGroups: groupEntries.length, startedAt });

  let okCount = 0;
  let failCount = 0;
  let patientCount = 0;
  const totalWaves = Math.ceil(groupEntries.length / groupConcurrency);

  for (let i = 0; i < groupEntries.length; i += groupConcurrency) {
    const wave = groupEntries.slice(i, i + groupConcurrency);
    const waveNum = i / groupConcurrency + 1;
    const waveRowCount = wave.reduce((sum, [, rows]) => sum + rows.length, 0);
    console.log(
      `\n-- [${tag}] Wave ${waveNum}: ${wave.length} group(s), ${waveRowCount} row(s) (groups ${i + 1}-${i + wave.length} of ${groupEntries.length}) --`
    );
    onEvent?.({ type: 'waveStart', waveNum, totalWaves, groups: wave.length, rows: waveRowCount });

    const results = await Promise.all(wave.map(([testCase, rows]) => runGroup(testCase, rows, baseUrl, templatesDir, onEvent)));

    let waveOk = 0;
    let waveFail = 0;
    for (const r of results) {
      okCount += r.ok;
      failCount += r.fail;
      patientCount += r.patients;
      waveOk += r.ok;
      waveFail += r.fail;
    }
    console.log(`-- [${tag}] Wave ${waveNum} done: ${waveOk} ok / ${waveFail} fail --`);
    onEvent?.({ type: 'waveDone', waveNum, ok: waveOk, fail: waveFail });

    if (i + groupConcurrency < groupEntries.length) {
      await new Promise((resolve) => setTimeout(resolve, wavePauseMs));
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `\n[${tag}] Summary: ${okCount} row(s) succeeded, ${failCount} row(s) failed, ${patientCount} patient(s) created, ${(
      durationMs / 1000
    ).toFixed(2)}s`
  );
  onEvent?.({ type: 'summary', tag, okCount, failCount, patientCount, durationMs });

  return { tag, rows: seedData.length, okCount, failCount, patientCount, durationMs };
}
