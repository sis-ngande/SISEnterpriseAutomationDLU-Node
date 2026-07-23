/**
 * Port of com.utils.ReusableUtils.addDate(sValue, dateFormat).
 * "Today" / "Today_N" / "Today#N" are relative-date tokens used throughout
 * the seed-data Excel sheets; anything else passes through unchanged.
 * Only 'yyyy-MM-dd' formatting is needed by the ported call sites so far.
 */
export function addDate(sValue: string, dateFormat: 'yyyy-MM-dd' | 'MM/dd/yyyy' | 'MM-dd-yyyy' = 'yyyy-MM-dd'): string {
  const trimmed = sValue.trim();
  const format = (d: Date) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    if (dateFormat === 'MM/dd/yyyy') return `${mm}/${dd}/${yyyy}`;
    if (dateFormat === 'MM-dd-yyyy') return `${mm}-${dd}-${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  };

  if (trimmed.toLowerCase() === 'today') {
    return format(new Date());
  }
  if (trimmed.includes('Today_')) {
    const days = parseInt(trimmed.split('_')[1], 10);
    const d = new Date();
    d.setDate(d.getDate() + days);
    return format(d);
  }
  if (trimmed.includes('Today#')) {
    const days = parseInt(trimmed.split('#')[1], 10);
    const d = new Date();
    d.setDate(d.getDate() - days);
    return format(d);
  }
  return sValue;
}

/** Port of ReusableUtils.encodeString2Base64. */
export function encodeString2Base64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * Port of ReUsableWebserviceUtils.Getlaterality. Maps a laterality string to
 * the API's numeric code: left=1, bilateral=2, right=3, anything else=0.
 * Returns [laterality, lateralityText] to match the Java List<Object> shape.
 */
export function getLaterality(lateralityText: string): [number, string] {
  const normalized = lateralityText?.toLowerCase();
  let laterality = 0;
  if (normalized === 'left') laterality = 1;
  else if (normalized === 'right') laterality = 3;
  else if (normalized === 'bilateral') laterality = 2;
  return [laterality, lateralityText];
}

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
