export type OperationParams = Map<string, string>;
export type OperationMap = Map<string, OperationParams>;

/** Port of com.seeddata.SeedData */
export class SeedData {
  constructor(
    public readonly testCase: string,
    public readonly rowNumber: number,
    public readonly operations: OperationMap
  ) {}

  equals(other: SeedData): boolean {
    return (
      other.testCase.toLowerCase() === this.testCase.toLowerCase() &&
      other.rowNumber === this.rowNumber
    );
  }
}
