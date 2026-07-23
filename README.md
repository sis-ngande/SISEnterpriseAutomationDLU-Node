# SeedForge

Node.js/TypeScript port of the Java DLU seed-data automation framework (source: `SISEnterpriseAutomationDLU` repo). It reads a seed-data Excel workbook, converts each tagged row into a sequence of operations (create room, create patient, etc.), and fires those operations at a live SIS webservice API to seed test data into an environment.

See [NODE_MIGRATION_DESIGN.md](../SISEnterpriseAutomationDLU/NODE_MIGRATION_DESIGN.md) in the original repo for the full architecture and migration design this port follows.

## Status

Ported so far from the Java `com.parser.excel` / `com.seeddata` / `com.client.webservice` / `com.utils` packages:

- Excel parsing (`ExcelParser`, `SISTestDataExcelParser`) and the `SeedData` model
- Session handling, dictionary lookups (`WebserviceUtils`)
- Two fully working operations: **Room Details** (`createNewRoom`) and **PatientCreation** (`createJustAPatient`, including the address sub-builder)
- Batch/concurrent execution of rows (12 rows at a time)

Not yet ported (these operations are logged and skipped, not thrown, so one unimplemented operation doesn't abort the rest of the row): `MedicationCreation`, `createPreferenceCards`, `createPhysicianOpNotes`, `createNewDiscounts`, `createInsuranceContract`, `updateStateReportPhysician`. Within `PatientCreation`, four detail sub-builders are also unported and will throw if the corresponding Excel column is non-blank: `patientAdditionalDetails`, `patientPhoneDetails`, `patientEmergencyContactDetails`, `patientEmployerDetails`.

## Folder structure

```
src/
  index.ts                          Entry point - runs the full pipeline (see "How it runs" below)
  debugSheet.ts                     Ad-hoc script for inspecting a workbook's sheets/rows during development

  parser/
    excel/
      excelParser.ts                Low-level Excel reader (ExcelJS-based): sheet/column/cell lookups,
                                     merged-header resolution, multi-value (`;`/`,`/`|`) and `data.xxx`
                                     JSON-lookup cell resolution
      sisTestDataExcelParser.ts     Higher-level row filtering: matches rows by `SeedDataType` column value
                                     and rolls sub-rows up to their owning test-case row
    json/
      jsonFileParser.ts             Resolves `data.<key>[<index>].<parameterKey>` tokens against an
                                     external JSON test-data file (see sample-testdata-example.json)

  seeddata/
    iSeedDataProcessor.ts           Shared constants (SeedDataType values, column names) and the
                                     ISeedDataProcessor contract
    seedData.ts                     SeedData model: testCase, rowNumber, and an ordered
                                     operation-name -> params map
    webServiceSeedDataProcessor.ts  Turns a workbook into SeedData[] by combining ExcelParser +
                                     SISTestDataExcelParser
    seedData.xlsx                   The seed-data workbook used for local runs

  client/webservice/
    webserviceUtils.ts              Session login/org-switch handling, generic HTTP request execution,
                                     and dictionary-item id lookups (Religion, Race, etc.)
    webServiceClient.ts             Dispatches each row's operations (Room Details, PatientCreation, ...)
                                     to the matching API call(s); builds request bodies from templates
    responseCache.ts                Per-row key/value store replacing the Java client's shared response
                                     map, so concurrent rows can't cross-contaminate captured IDs
    iWebServiceResponseKeys.ts      String constants for ResponseCache keys and status values

  templates/
    templateLoader.ts               Loads + deep-clones a JSON request template from reqTemplates/,
                                     with an `updateField` helper for mutating individual fields

  utils/
    reusableUtils.ts                Shared helpers: `addDate` (resolves "Today"/"Today_N"/"Today#N"
                                     tokens) and `generateRandomNumeric`

reqTemplates/                       Static JSON request-body skeletons, one per API call:
  UserDetails.json                    login credentials used by createSession
  AddRoomType.json / AddRoom.json     used by createNewRoom
  CreatePatient.json                  used by createJustAPatient

test/                                Jest smoke tests (ts-jest)
```

## How it runs (`src/index.ts`)

1. Loads the Excel workbook (path from `argv[2]`, JSON test-data file from `argv[3]`) via `WebServiceSeedDataProcessor.create(...)`.
2. Calls `processor.getAllSeedDataForType('All')`, which walks every sheet and returns one `SeedData` per test-case row whose `SeedDataType` column matches `'All'` (case-insensitive). Change this string to filter by a different tag (e.g. the `SD`/`JIT` constants in `iSeedDataProcessor.ts`).
3. Processes rows in **batches of 12** (`BATCH_SIZE` in `index.ts`): each batch's rows run concurrently via `p-limit`, one `WebServiceClient` per row (so sessions/state never leak across rows); the script waits for a batch to finish before starting the next.
4. For each row, `WebServiceClient.callWebService(sd)` iterates that row's operations in Excel column order and dispatches them by name (`Room Details` -> `createNewRoom`, `PatientCreation` -> `createJustAPatient`, anything else -> logged as skipped/unknown).
5. Prints `[OK]`/`[FAIL]` per row (with the created patient's facility, if any), then a final summary: rows succeeded, rows failed, patients created.

## APIs used

All requests go to `BASE_URL` (hardcoded in `index.ts`) + the relative path below. Bodies are loaded from `reqTemplates/*.json` and mutated per-row via `updateField`.

| Method | Path | Purpose | Called from |
|---|---|---|---|
| POST | `/login/loginuser` | Log in, get session token | `WebserviceUtils.createSession` |
| GET | `/User/UserOrgMap` | Resolve the organization id for a facility name | `WebserviceUtils.createSession` |
| POST | `/UserSession/UserSessionOrg/{orgId}` | Switch the session to that org | `WebserviceUtils.createSession` |
| GET | `Dictionary/v2` | List dictionaries (e.g. Religion, Race) | `WebserviceUtils.getDictionaryDetails` |
| GET | `Dictionary/v2/{dictionaryId}/All` | List items within a dictionary, to resolve an id by value | `WebserviceUtils.getDictionaryDetails` |
| POST | `/RoomType/Add` | Create a room type | `WebServiceClient.createNewRoom` |
| POST | `/Room/Add` | Create a room (references the room type + org id) | `WebServiceClient.createNewRoom` |
| POST | `/PatientData/Gemini/CreatePatient/2030` | Create a patient | `WebServiceClient.createJustAPatient` |

## Setup

```bash
npm install
```

## Running

```bash
# Quick dev run (compiles on the fly, no build step)
npm run dev -- path/to/seedData.xlsx path/to/testData.json

# Or directly with ts-node
npx ts-node src/index.ts path/to/seedData.xlsx path/to/testData.json

# Production-style: build once, then run the compiled JS
npm run build
npm start -- path/to/seedData.xlsx
```

`testData.json` (the second argument) is optional - only needed if your Excel cells contain `data.<key>[<index>].<parameterKey>` tokens (see `jsonFileParser.ts` and `sample-testdata-example.json` for the expected shape).

## Configuration

`BASE_URL` and `BATCH_SIZE` are currently hardcoded constants at the top of `src/index.ts` - edit them directly to point at a different environment or change concurrency. `reqTemplates/UserDetails.json` holds the login credentials used by default (a specific user/password can also be passed to `createSession` directly).

## Testing

```bash
npm test
```

Runs the Jest smoke tests under `test/` via `ts-jest`.

## Validating against the Java baseline

Run the Java `WebServiceSeedDataProcessor.getAllSeedData(...)` against the same Excel file and diff the resulting test-case/row/operation structure against this tool's JSON output before trusting it for real seeding runs.
