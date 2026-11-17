import {
  isOpenSendRow,
  type LedgerRecord,
  type SendLedger,
  type SendPage,
  type SendPageQuery,
  sendPage,
  sendRecordView,
  type SendRecord,
  type SessionId,
  type WindowKeys,
  windowPage,
} from '../../../contract/index.ts';

/**
 * A PAGE OF A SESSION'S SENDS WITHOUT READING ITS WHOLE LEDGER.
 *
 * `GET /sends` used to read every line of `sends.jsonl` (63-74 MB on a real home: 1-1.8 s to open a chat) to answer a page
 * of 100. The answer is the same page now, cut from two things:
 *
 *  - a small INDEX per session: for every send its id, acceptance instant and whether it is open (a few dozen bytes each),
 *    plus the rows of the open ones (the first page carries every open send, however old). It is built ONCE per session by
 *    reading the ledger, and from then on follows the log by reading only the bytes appended since (the log is append-only).
 *  - the END of the log: the rows of the sends on the page come from the newest bytes of the file, growing the window only
 *    while a row is not in it. A page of the newest sends costs about one megabyte whatever the ledger weighs.
 *
 * The order, the cursor, the open sends and the "no older page" word come from {@link windowPage} over the index, the same
 * function the whole-ledger page used, so the answer is the one it gave. A ledger that cannot read its end is paged from
 * the whole read, as before.
 */

/** A window is never smaller than this: a line may be as long as 1 MiB, and a window starts mid-line. */
const MARGIN_BYTES = 2 * 1024 * 1024;
/** The first window a page's rows are looked for in; it grows fourfold while a row is missing. */
const FIRST_WINDOW_BYTES = 1024 * 1024;
/** Past this a window is no better than the whole log: read it whole instead. */
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;
/** Sessions whose index is kept: the ones a person has open. */
const MAX_INDEXED_SESSIONS = 8;

interface Stub {
  readonly id: string;
  readonly at: string;
  readonly open: boolean;
}

const STUB_KEYS: WindowKeys<Stub> = { id: stub => stub.id, at: stub => stub.at, open: stub => stub.open };

interface Index {
  /** How far into the log the index has read: a size, in bytes. */
  scanned: number;
  readonly stubs: Map<string, Stub>;
  /** The wire rows of the open sends. */
  readonly open: Map<string, SendRecord>;
}

export class SendsPager {
  /** The index of each session, least recently used first. */
  private readonly indexes = new Map<string, Index>();
  /** One page at a time per session: the index is read-modify-written. */
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(private readonly ledger: SendLedger) {}

  /** The page `query` asks for, or `undefined` when its cursor names no send of the session. */
  async page(session: SessionId, query: SendPageQuery): Promise<SendPage | undefined> {
    if (this.ledger.recent === undefined) return sendPage((await this.ledger.list(session)).map(sendRecordView), query);
    const before = this.lanes.get(session) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(async () => await this.cut(session, query));
    this.lanes.set(session, run);
    try {
      return await run;
    } finally {
      if (this.lanes.get(session) === run) this.lanes.delete(session);
    }
  }

  private async cut(session: SessionId, query: SendPageQuery): Promise<SendPage | undefined> {
    const index = await this.following(session);
    const window = windowPage([...index.stubs.values()], query, STUB_KEYS);
    if (window === undefined) return undefined;
    const rows = new Map<string, SendRecord>();
    const wanted = new Set<string>();
    for (const stub of window.items) {
      const open = index.open.get(stub.id);
      if (open === undefined) wanted.add(stub.id);
      else rows.set(stub.id, open);
    }
    if (wanted.size > 0) await this.fetch(session, wanted, rows);
    return {
      sends: window.items.flatMap(stub => {
        const row = rows.get(stub.id);
        return row === undefined ? [] : [row];
      }),
      nextCursor: window.nextCursor,
    };
  }

  /** The rows of `wanted` ids, from the end of the log, a wider window each time one is missing, the whole log last. */
  private async fetch(session: SessionId, wanted: ReadonlySet<string>, rows: Map<string, SendRecord>): Promise<void> {
    const recent = this.ledger.recent?.bind(this.ledger);
    const missing = (): boolean => [...wanted].some(id => !rows.has(id));
    if (recent !== undefined) {
      for (let bytes = FIRST_WINDOW_BYTES; ; bytes = Math.min(bytes * 4, MAX_WINDOW_BYTES)) {
        const tail = await recent(session, bytes);
        for (const record of tail.records)
          if (wanted.has(record.sendId)) rows.set(record.sendId, sendRecordView(record));
        if (!missing()) return;
        if (bytes >= tail.size || bytes >= MAX_WINDOW_BYTES) break;
      }
    }
    for (const record of await this.ledger.list(session)) {
      if (wanted.has(record.sendId)) rows.set(record.sendId, sendRecordView(record));
    }
  }

  /** The session's index, brought up to the log's end: built from the whole log the first time, then by what was appended. */
  private async following(session: SessionId): Promise<Index> {
    const known = this.indexes.get(session);
    const recent = this.ledger.recent?.bind(this.ledger);
    if (known === undefined || recent === undefined) return await this.build(session);
    // Read again as the newest, so the sessions dropped are the ones nobody has looked at.
    this.indexes.delete(session);
    this.indexes.set(session, known);
    const size = (await recent(session, 1)).size;
    if (size < known.scanned) return await this.build(session);
    const appended = size - known.scanned;
    if (appended === 0) return known;
    if (appended + MARGIN_BYTES > MAX_WINDOW_BYTES) return await this.build(session);
    // The window reaches back past where the index stopped (a torn last line then is whole), and a line read twice is the
    // same line: the window holds the latest line of each send in it, so reading it again changes nothing.
    this.absorb(known, (await recent(session, appended + MARGIN_BYTES)).records);
    known.scanned = size;
    return known;
  }

  private async build(session: SessionId): Promise<Index> {
    // The size first: a line appended while the log is read is read again by the next look.
    const size = (await this.ledger.recent?.(session, 1))?.size ?? 0;
    const index: Index = { scanned: size, stubs: new Map(), open: new Map() };
    this.absorb(index, await this.ledger.list(session));
    this.indexes.delete(session);
    this.indexes.set(session, index);
    for (const stale of [...this.indexes.keys()].slice(0, Math.max(0, this.indexes.size - MAX_INDEXED_SESSIONS)))
      this.indexes.delete(stale);
    return index;
  }

  private absorb(index: Index, records: readonly LedgerRecord[]): void {
    for (const record of records) {
      const row = sendRecordView(record);
      const open = isOpenSendRow(row);
      index.stubs.set(row.sendId, { id: row.sendId, at: row.acceptedAt, open });
      if (open) index.open.set(row.sendId, row);
      else index.open.delete(row.sendId);
    }
  }
}
