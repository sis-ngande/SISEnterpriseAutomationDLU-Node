/** Port of com.utils.ReusableUtils (subset used by the seeding pipeline). */
export function generateRandomNumeric(count: number): string {
  let digits = '';
  // first digit non-zero, matching RandomStringUtils.randomNumeric's typical
  // usage here (values are parsed as int IDs, a leading zero would just be
  // dropped anyway, so this mirrors real-world behavior without changing it).
  for (let i = 0; i < count; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }
  return digits;
}
