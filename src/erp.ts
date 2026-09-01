/**
 * The shared context every module needs: the client, the tenant, and the
 * prefix that makes idempotency keys unique per run.
 *
 * It lives in its own module because the four service modules all need it and
 * `main.ts` imports all four: holding it there would make each of them import
 * the entry point back, and a cycle that ESM resolves only by evaluation order.
 */

import type { RociaDbClient } from "@rocia/rociadb-sdk";

/**
 * Graphs and buckets are never declared either: they exist from the first
 * node or file written to them.
 */
export const GRAPH = "erp";
export const BUCKET = "attachments";

export class Erp {
  readonly client: RociaDbClient;
  readonly tenant: string;
  /** Unique per run, so nothing this demo writes is deduplicated against a previous one. */
  readonly run: string;

  constructor(client: RociaDbClient, tenant: string, run: string) {
    this.client = client;
    this.tenant = tenant;
    this.run = run;
  }

  /**
   * An idempotency key for one write.
   *
   * The server deduplicates on `(tenantId, operation, requestId)` for 24
   * hours. A *stable* key is what makes an interrupted import safe to replay
   * — but if this demo reused the same keys on every run, a second run after
   * a cleanup would write nothing at all: the server would see yesterday's
   * writes replayed. So the prefix changes per run, and the key is stable
   * within one.
   */
  key(name: string): string {
    return `${this.run}:${name}`;
  }
}
