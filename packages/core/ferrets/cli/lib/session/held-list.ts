import { type FerretSummary, FerretSummarySchema } from '../../../contract/index.ts';

/**
 * THE FLEET LIST A CLIENT HOLDS (R502, kept half; today's `FyApiClient.list`).
 *
 * Every open surface re-reads the fleet on a beat, and an unchanged one answers `304` instead of its whole list
 * again. One list is held per reader, which is per daemon connection: the held entry is captured BEFORE the request,
 * the request names its tag in `If-None-Match`, and a `304` answers a fresh copy of the held list (a caller can never
 * change what the next caller is given). An answer without an `etag` is a broken list response and is refused.
 */

/** One raw exchange: the shell's transport for `GET /v1/ferrets` with the given headers. */
export type FleetListTransport = (headers: Readonly<Record<string, string>>) => Promise<{
  readonly status: number;
  readonly etag?: string;
  readonly body: string;
}>;

const ListSchema = FerretSummarySchema.array();

export class HeldFleetList {
  #held: { readonly etag: string; readonly body: string } | undefined;

  constructor(private readonly transport: FleetListTransport) {}

  async list(): Promise<readonly FerretSummary[]> {
    const held = this.#held;
    const answer = await this.transport(held === undefined ? {} : { 'if-none-match': held.etag });
    if (held !== undefined && answer.status === 304) return ListSchema.parse(JSON.parse(held.body));
    if (answer.status !== 200) throw new Error(`the fleet read answered ${answer.status}`);
    if (answer.etag === undefined || answer.etag.trim() === '')
      throw new Error('the fleet read did not include an etag');
    const list = ListSchema.parse(JSON.parse(answer.body));
    this.#held = { etag: answer.etag, body: answer.body };
    return list;
  }
}
