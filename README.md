# SIS Automation DLU (Node.js)

Node.js/TypeScript port of the Java DLU seed-data automation framework (source: `SISEnterpriseAutomationDLU` repo). See [NODE_MIGRATION_DESIGN.md](../SISEnterpriseAutomationDLU/NODE_MIGRATION_DESIGN.md) in the original repo for the full architecture and migration design.

## Status

Milestone 1 in progress: `ExcelParser`, `SeedData`, `WebServiceSeedDataProcessor` ported from the Java `com.parser.excel` / `com.seeddata` packages.

## Setup

```bash
npm install
npm run dev -- path/to/seedData.xlsx path/to/testData.json
```

## Validating against the Java baseline

Run the Java `WebServiceSeedDataProcessor.getAllSeedData(...)` against the same Excel file and diff the resulting test-case/row/operation structure against this tool's JSON output before trusting it for real seeding runs.
