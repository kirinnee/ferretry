import { z } from 'zod';
import type { AuthoritySignal, DaemonClient } from '../client/daemon-client.ts';
import { CHANGE_REFUSALS } from '../ui/change-authority.ts';
import type { Authority, Axis } from './view-place.tsx';

/**
 * THE ONE PER-DAEMON GRANTS CACHE (shell contract S1, M6). Every reader of "what may this device do on that machine"
 * — a view's place, a `useEveryDaemon` row, `useChangeAuthority`, Runtimes' apply panel, the locked list — reads it,
 * so a machine is asked `GET /v1/grants` once per trigger, not once per control.
 *
 * - **Never `open` before the grants are read.** A machine starts `unknown`; only a read moves it.
 * - **A locked machine (ruling #54, option (a), no Gate change).** The read goes out through the client's no-pause
 *   `readGrants`, so a `401 unlock_required` (read by Access's handler, the shell parses no code) makes the machine
 *   `locked` at once — never `unknown` waiting for "on screen", never `unreadable`. The read waits for the unlock by
 *   being SENT AGAIN on the triggers (ruling #55: re-send, never a parked read).
 * - **Re-read on real signals only:** a confirm `true` the client heard of, a capability refusal, every inventory
 *   change (start, a reconnect, `kernel.plugins-changed`), the feed coming back, the app returning to the foreground,
 *   and (best effort) the handler's own change. A `401 unlock_required` sets `locked` with no read.
 * - **Stale answers are ignored (R3 m2):** every request notes the client's generation, which each confirm bumps; an
 *   answer or a signal from an older generation changes nothing.
 * - **Offline keeps the last answer:** a read that reaches nothing leaves the state as it was.
 *
 * The grants body is capability names, booleans and refusal reasons only (Gate's guard); nothing secret is held.
 */

const RowSchema = z.object({
  capability: z.string(),
  use: z.boolean(),
  useRefusal: z.enum(CHANGE_REFUSALS),
  configure: z.boolean(),
  configureRefusal: z.enum(CHANGE_REFUSALS),
});
const GrantsBodySchema = z.object({ capabilities: z.array(RowSchema) });
type Row = z.infer<typeof RowSchema>;

type State =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly rows: ReadonlyMap<string, Row> };

const UNKNOWN: Authority = Object.freeze({ kind: 'unknown' });
const LOCKED: Authority = Object.freeze({ kind: 'locked' });
const UNREADABLE: Authority = Object.freeze({ kind: 'unreadable' });
const OPEN: Authority = Object.freeze({ kind: 'open' });
const STEP_UP: Authority = Object.freeze({ kind: 'step-up' });
const UNDETERMINED: Authority = Object.freeze({ kind: 'refused', refusal: 'undetermined' });
const NOT_GRANTED: Authority = Object.freeze({ kind: 'refused', refusal: 'not-granted' });
const DEVICE_NOT_GRANTED: Authority = Object.freeze({ kind: 'refused', refusal: 'device-not-granted' });

/** The part of a daemon's client the cache reads through: the no-pause read, the generation and the signals. */
export type GrantsReader = Pick<DaemonClient, 'readGrants' | 'generation' | 'onAuthority'>;

interface Entry {
  readonly client: GrantsReader;
  readonly stop: () => void;
  state: State;
  reading: boolean;
  again: boolean;
  /** Bumped by every answer set: a read that was sent before a later set is older than it and is dropped. */
  sequence: number;
}

const NOTHING_LOCKED: readonly string[] = Object.freeze([]);

export class GrantsCache {
  readonly #entries = new Map<string, Entry>();
  readonly #changed: () => void;
  #locked: readonly string[] = NOTHING_LOCKED;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  /** Starts listening to one daemon's client. A second attach for the same daemon replaces the first. */
  attach(daemon: string, client: GrantsReader): void {
    this.drop(daemon);
    const entry: Entry = {
      client,
      state: { kind: 'unknown' },
      reading: false,
      again: false,
      sequence: 0,
      stop: client.onAuthority(signal => this.#heard(daemon, entry, signal)),
    };
    this.#entries.set(daemon, entry);
  }

  /** The daemon was unpaired: nothing it said is kept. */
  drop(daemon: string): void {
    const entry = this.#entries.get(daemon);
    if (entry === undefined) return;
    entry.stop();
    this.#entries.delete(daemon);
    this.#publish();
  }

  /** A re-read trigger for one daemon (an inventory change, the feed back). One read in flight at a time. */
  refresh(daemon: string): void {
    const entry = this.#entries.get(daemon);
    if (entry !== undefined) this.#read(daemon, entry);
  }

  /** A re-read trigger for every daemon (the app came back to the foreground). */
  refreshAll(): void {
    for (const [daemon, entry] of this.#entries) this.#read(daemon, entry);
  }

  /** Best effort (the handler's own change): re-read only the machines that wait on their unlock. */
  refreshLocked(): void {
    for (const [daemon, entry] of this.#entries) if (entry.state.kind === 'locked') this.#read(daemon, entry);
  }

  /** Every machine whose grants read answered "unlock first": THE one locked set (R3 m5). Stable between changes. */
  locked(): readonly string[] {
    return this.#locked;
  }

  isLocked(daemon: string): boolean {
    return this.#entries.get(daemon)?.state.kind === 'locked';
  }

  /** This daemon's answer as an opaque token: a new one each time the answer is set, the same one in between. */
  stateOf(daemon: string): unknown {
    return this.#entries.get(daemon)?.state;
  }

  /** What this device may do with (capability, axis) on this daemon. */
  authority(daemon: string, capability: string, axis: Axis): Authority {
    const state = this.#entries.get(daemon)?.state;
    if (state === undefined || state.kind === 'unknown') return UNKNOWN;
    if (state.kind === 'locked') return LOCKED;
    if (state.kind === 'unreadable') return UNREADABLE;
    const row = state.rows.get(capability);
    if (row === undefined) return UNDETERMINED;
    const allowed = axis === 'use' ? row.use : row.configure;
    if (allowed) return OPEN;
    const refusal = axis === 'use' ? row.useRefusal : row.configureRefusal;
    if (refusal === 'step-up-required') return STEP_UP;
    if (refusal === 'not-granted') return NOT_GRANTED;
    if (refusal === 'device-not-granted') return DEVICE_NOT_GRANTED;
    return UNDETERMINED;
  }

  #heard(daemon: string, entry: Entry, signal: AuthoritySignal): void {
    if (this.#entries.get(daemon) !== entry) return;
    if (signal.kind !== 'confirmed' && signal.generation !== entry.client.generation) return;
    if (signal.kind === 'locked') this.#set(entry, { kind: 'locked' });
    else this.#read(daemon, entry);
  }

  #read(daemon: string, entry: Entry): void {
    if (entry.reading) {
      entry.again = true;
      return;
    }
    entry.reading = true;
    const sent = entry.sequence;
    void entry.client
      .readGrants({ noPause: true })
      .then(
        read => {
          if (this.#entries.get(daemon) !== entry || read.generation !== entry.client.generation) return;
          // A `locked` signal (or any answer) set after this read was sent is fresher than what it says (m4).
          if (entry.sequence !== sent) return;
          if (read.answer === undefined) return; // reached nothing: offline keeps the last answer
          if (read.need?.kind === 'unlock') return this.#set(entry, { kind: 'locked' });
          const body = read.answer.status === 200 ? GrantsBodySchema.safeParse(read.answer.body) : undefined;
          this.#set(
            entry,
            body?.success === true
              ? { kind: 'read', rows: new Map(body.data.capabilities.map(row => [row.capability, row])) }
              : { kind: 'unreadable' },
          );
        },
        () => {
          // The read could not be admitted (the client stopped, or Gate itself is blocked there).
          if (this.#entries.get(daemon) === entry) this.#set(entry, { kind: 'unreadable' });
        },
      )
      .finally(() => {
        entry.reading = false;
        if (!entry.again || this.#entries.get(daemon) !== entry) return;
        entry.again = false;
        this.#read(daemon, entry);
      });
  }

  #set(entry: Entry, state: State): void {
    entry.state = state;
    entry.sequence += 1;
    this.#publish();
  }

  #publish(): void {
    const locked = [...this.#entries].filter(([, entry]) => entry.state.kind === 'locked').map(([daemon]) => daemon);
    const same = locked.length === this.#locked.length && locked.every((daemon, i) => daemon === this.#locked[i]);
    if (!same) this.#locked = locked.length === 0 ? NOTHING_LOCKED : Object.freeze(locked);
    this.#changed();
  }
}
