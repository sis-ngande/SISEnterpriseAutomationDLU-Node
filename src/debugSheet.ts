import ExcelJS from 'exceljs';

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('src/seeddata/seedData.xlsx');
  wb.eachSheet(s => console.log(JSON.stringify(s.name)));
  const sheet = wb.getWorksheet('SeedData_Cypress');
  console.log('found sheet:', !!sheet);
  if (sheet) {
    console.log('row count', sheet.rowCount);
    for (let r = 1; r <= 10; r++) {
      console.log(r, JSON.stringify(sheet.getRow(r).values));
    }
    const typeValues = new Set();
    for (let r = 3; r <= sheet.rowCount; r++) {
      typeValues.add(sheet.getRow(r).getCell(3).value);
    }
    console.log('distinct col3 (SeedDataType?) values:', [...typeValues].slice(0, 20));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
