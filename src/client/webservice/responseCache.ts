/**
 * Replaces the Java WebServiceClient's shared instance field `mapWebServiceResponses`.
 *
 * In the Java original this map lives on the WebServiceClient instance and is
 * reused across every operation processed by that instance. Per the
 * concurrency design (see NODE_MIGRATION_DESIGN.md section 4), concurrent
 * rows must NOT share this state - each row gets its own ResponseCache
 * instance so parallel row processing can't cross-contaminate IDs captured
 * by one row's operations (e.g. insuranceCarrierId, patientId).
 */
export class ResponseCache {
  private readonly values = new Map<string, unknown>();

  put(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  getString(key: string): string | undefined {
    const v = this.values.get(key);
    return v == null ? undefined : String(v);
  }
}
