/** Codex rollout IO, through the two declared roots only. No sign-in document is opened. */
import { createHash } from 'node:crypto';
import { openTranscriptBytes } from '@ferretry/core-ferrets/contract';
import type {
  ConversationImport,
  FoundConversation,
  Harness,
  HarnessTailRecord,
  HarnessTranscriptBytes,
  LaunchSpec,
  TranscriptEntry,
  TurnUsage,
} from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { err, ok, seconds, type Instant, type JsonValue, type Result } from '@ferretry/std';
import { CODEX_ROLLOUTS, type CodexRolloutBinding as Binding } from '../../contract/index.ts';
import { cutRollout, rolloutName } from '../lib/fork.ts';
import { CodexTranscriptParser } from '../lib/transcript/codex.ts';
import { ProofCache } from '../lib/transcript/proof-cache.ts';
import { selectCodexRollout } from '../lib/transcript/rollout.ts';
import { markCutWindow, tailRecordOf } from '../lib/transcript/tail-record.ts';

/** The largest rollout copy-on-link copies: a copy is held whole in memory (the owner's rollouts are tens of MB at most). */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/** Said when a copy is asked for while the owner's own Codex history is switched off (or its setting cannot be trusted). */
const HOST_HISTORY_OFF = "Showing Codex's conversations from this computer is turned off.";
const MAX_ROLLOUTS = 4_000;
const MAX_DIRECTORIES = 8_000;
/**
 * Today's rollout index windows: EVERY discovery read is bounded, because a rollout grows without bound while its
 * agent works. The header (`session_meta`) is in the head by construction; the correlation path is named by the
 * opening turn, and a tail window covers a compacted rollout that re-states its brief later. Only the one rollout
 * found to be the ferret's is read whole.
 */
const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 256 * 1024;
/** How long the proof of which rollout is a ferret's may be reused by the stamp and the tail (reads always prove afresh). */
const PROOF_REUSE_MS = 5_000;
/** How much of the end of a rollout one tail read takes: a turn's records are near the end. */
const TAIL_READ_BYTES = 512 * 1024;
const decoder = new TextDecoder();
/** The value with every string in it passed through `mask` (keys and shape untouched). */
const scrubStrings = (value: unknown, mask: (text: string) => string): unknown => {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(item => scrubStrings(item, mask));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, scrubStrings(each, mask)]));
  return value;
};
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface Rollout {
  readonly id: string;
  readonly file: FencedPath;
  readonly folder: string;
  readonly modified: Instant;
  readonly size: number;
}

interface OwnedRollout extends Rollout {
  readonly text: string;
}

/** `length` bytes from `offset`, or nothing when the file is gone or refused. */
async function window(root: RootHandle, file: FencedPath, offset: number, length: number): Promise<string | undefined> {
  return await root
    .readBytes(file, { offset, length })
    .then(bytes => decoder.decode(bytes))
    .catch(() => undefined);
}

/**
 * Whether the rollout's head or tail window contains `needle` (today's `contains`): `undefined` when a window it needed
 * could not be read, which the transcript reader takes as "no" and a recorded proof takes as doubt.
 */
async function contains(root: RootHandle, rollout: Rollout, needle: string): Promise<boolean | undefined> {
  const head = await window(root, rollout.file, 0, HEAD_BYTES);
  if (head?.includes(needle) === true) return true;
  if (rollout.size <= HEAD_BYTES) return head === undefined ? undefined : false;
  const tail = await window(root, rollout.file, Math.max(HEAD_BYTES, rollout.size - TAIL_BYTES), TAIL_BYTES);
  if (tail?.includes(needle) === true) return true;
  return head === undefined || tail === undefined ? undefined : false;
}

type Ports = Pick<KernelPorts, 'roots' | 'clock' | 'redaction' | 'state'>;

/** Header identity is authoritative; a filename alone is never proof of a native conversation. */
function metadata(text: string): { id: string; cwd: string } | undefined {
  for (const line of text.split('\n').slice(0, 8)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'session_meta' && typeof event.payload?.id === 'string')
        return { id: event.payload.id, cwd: typeof event.payload.cwd === 'string' ? event.payload.cwd : '' };
    } catch {
      /* An incomplete header is not identity evidence. */
    }
  }
  return undefined;
}

/**
 * What a walk of the SHARED pool reads (a pool holds every ferret's rollouts, thousands of them): rollouts under day
 * folders from `since` on (Codex files them `sessions/YYYY/MM/DD/`), or the one file for `id`. Neither makes a walk
 * incomplete: a rollout it never opens is one that cannot matter to the question asked.
 */
interface WalkFilter {
  readonly since?: string | undefined;
  readonly id?: string | undefined;
}

/** Whether a folder below `sessions` (`2026`, `2026/11`, `2026/11/16`) can hold a day on or after `since` (`YYYY-MM-DD`). */
function dayWanted(below: string, since: string | undefined): boolean {
  if (since === undefined) return true;
  const parts = below.split('/');
  if (parts.length > 3 || !parts.every(part => /^\d+$/u.test(part))) return true;
  const key = parts.join('-');
  return key >= since.slice(0, key.length);
}

/**
 * Today's sessions walk (`node-codex-rollout-index.ts`): only real folders and real `.jsonl` files, each named entry
 * taken as it IS (`RootHandle.entries`, never followed), so a symbolic link — `rollout-alias.jsonl -> auth.json`, or a
 * folder link back up the home — is skipped and never opened. Every path is checked again by the root port on read.
 */
async function rollouts(root: RootHandle, directory: string): Promise<readonly Rollout[]> {
  return (await walkRollouts(root, directory)).found;
}

/**
 * The walk itself, and whether it SAW EVERYTHING: `complete` is false when a cap stopped it, a folder could not be
 * listed, or a `.jsonl` file's head could not be read as a rollout. Only a complete walk can prove a rollout absent.
 */
async function walkRollouts(
  root: RootHandle,
  directory: string,
  absent?: () => Promise<boolean>,
  only?: WalkFilter,
): Promise<{ readonly found: readonly Rollout[]; readonly complete: boolean }> {
  const pending = [directory];
  const found: Rollout[] = [];
  let visited = 0;
  let complete = true;
  while (pending.length > 0 && found.length < MAX_ROLLOUTS && visited++ < MAX_DIRECTORIES) {
    const relative = pending.shift() as string;
    const path = root.resolve(relative);
    if (!path.ok) {
      complete = false;
      continue;
    }
    const entries = await root.entries(path.value).catch(async () => {
      // A folder that does not exist hides nothing; one that cannot be listed might. Only the walk's own top folder may
      // be absent (a home no rollout was written in yet), and only when `absent` PROVES it is not there (the kernel
      // refuses a missing root folder exactly as it refuses one it may not enter, so the refusal alone proves nothing).
      const proved = relative === directory && absent !== undefined && (await absent().catch(() => false));
      if (!proved) complete = false;
      return [];
    });
    for (const entry of entries) {
      const name = entry.name;
      if (name.includes('/') || name === '.' || name === '..') continue;
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      if (entry.kind === 'directory') {
        if (!dayWanted(childRelative.slice(directory === '' ? 0 : directory.length + 1), only?.since)) continue;
        pending.push(childRelative);
        continue;
      }
      // A link, a device or anything else is not a rollout: only a plain file is ever opened.
      if (entry.kind !== 'file' || !name.endsWith('.jsonl')) continue;
      // Codex names a rollout `rollout-<time>-<id>.jsonl`: a walk for ONE conversation opens only the files that say it.
      // (The header is still what proves it; a name is never identity.)
      if (only?.id !== undefined && !name.endsWith(`-${only.id}.jsonl`)) continue;
      const child = root.resolve(childRelative);
      if (!child.ok) {
        complete = false;
        continue;
      }
      const head = await window(root, child.value, 0, HEAD_BYTES);
      const meta = head === undefined ? undefined : metadata(head);
      if (meta === undefined) complete = false;
      else {
        found.push({ id: meta.id, folder: meta.cwd, file: child.value, modified: entry.modified, size: entry.size });
        if (found.length >= MAX_ROLLOUTS) break;
      }
    }
  }
  return { found, complete: complete && pending.length === 0 && found.length < MAX_ROLLOUTS };
}

export class CodexRollouts {
  readonly #parser = new CodexTranscriptParser();
  constructor(
    private readonly kernel: Ports,
    /** The owner's Codex home (`~/.codex`): the folder that holds `sessions/…`, never the `sessions` folder itself. */
    private readonly historyHome: () => Promise<string | undefined>,
    /** Whether the owner's own history may be read at all, asked live at each call (config `hostHistory`). */
    private readonly hostHistory: () => boolean = () => true,
  ) {}

  /** Asked at every call, so a switch turned off stops the next read; a setting that cannot be read counts as off. */
  private hostHistoryOn(): boolean {
    try {
      return this.hostHistory();
    } catch {
      return false;
    }
  }

  private owner(ferret: FerretId): RootHandle {
    return this.kernel.roots.root('agent-homes', { subfolder: ferret });
  }

  /**
   * Where this ferret's rollouts are read: the ferret's own `sessions` folder, or, when that name is the link to the
   * shared pool (the root never follows a link out of a home), the pool's `sessions` through the pool's own handle. The
   * relative paths are the same either way (`sessions/YYYY/MM/DD/rollout-….jsonl`).
   */
  private async sessions(
    ferret: FerretId,
  ): Promise<{ readonly root: RootHandle; readonly directory: string; readonly pooled: boolean }> {
    const own = this.owner(ferret);
    const at = own.resolve('sessions');
    // A name that cannot be looked at is not the pool's link: the ferret's own folder is then what is read (and refused).
    const linked = at.ok
      ? await Promise.resolve()
          .then(async () => (await own.lstat(at.value))?.kind === 'symlink')
          .catch(() => false)
      : false;
    if (linked) {
      // The link is the pool's only when the pool can be reached: a plugin with no pool reads the ferret's own folder, which
      // refuses a link (nothing is read through it).
      try {
        return { root: this.kernel.roots.historyPool(), directory: 'sessions', pooled: true };
      } catch {
        /* fall through to the ferret's own folder */
      }
    }
    return {
      root: this.kernel.roots.root('agent-homes', { subfolder: `${ferret}/sessions` }),
      directory: '',
      pooled: false,
    };
  }

  /**
   * Whether this ferret's `sessions` folder is PROVED absent, from the listings above it: the ferret's home is not in the
   * agent homes, or `sessions` is not in the ferret's home. Any listing that fails is no proof (`false`).
   */
  private async sessionsAbsent(ferret: FerretId): Promise<boolean> {
    const named = async (root: RootHandle, name: string): Promise<boolean> => {
      const folder = root.resolve('');
      if (!folder.ok) throw new Error('the folder could not be placed');
      return (await root.entries(folder.value)).some(entry => entry.name === name);
    };
    try {
      if (!(await named(this.kernel.roots.root('agent-homes'), ferret))) return true;
      return !(await named(this.owner(ferret), 'sessions'));
    } catch {
      return false;
    }
  }

  private async binding(ferret: FerretId): Promise<Binding | undefined> {
    const read = await this.kernel.state.read(CODEX_ROLLOUTS, ferret);
    if (!read.ok) throw new Error('Codex rollout ownership state is damaged');
    return read.value;
  }

  /** The first day (`YYYY-MM-DD`) a rollout this launch writes can be filed under: two days back, whatever the zone. */
  private sinceDay(): string {
    return new Date(Date.parse(this.kernel.clock.now()) - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** Save the pre-launch baseline; after restart it is still excluded. Resume uses the supplied native id. */
  async launched(spec: LaunchSpec, native?: string): Promise<void> {
    const owner = this.owner(spec.ferret);
    const home = owner.resolve(spec.home);
    const ownHome = owner.resolve('');
    if (!home.ok || !ownHome.ok || home.value !== ownHome.value)
      throw new Error('Codex rollout ownership could not be placed in the ferret home');
    // A new launch (a resume names its own conversation) may prove another rollout: forget the one remembered.
    this.forget(spec.ferret);
    const where = await this.sessions(spec.ferret);
    // The shared pool holds every ferret's rollouts: a new conversation can only be among the last days' (a day or two of
    // slack for the clock's zone), and a resume names its conversation, so neither reads the pool whole.
    const since = where.pooled && native === undefined ? this.sinceDay() : undefined;
    const existing =
      where.pooled && native !== undefined
        ? { found: [], complete: true }
        : await walkRollouts(
            where.root,
            where.directory,
            where.pooled ? async () => false : async () => await this.sessionsAbsent(spec.ferret),
            { since },
          );
    await this.kernel.state.write(
      CODEX_ROLLOUTS,
      {
        format: 1,
        home: home.value,
        baseline: existing.found.map(item => item.id),
        // Whether that baseline saw EVERY rollout already there: one it missed (a folder or a header it could not read)
        // is not excluded, and the correlation marker is per HOME, so it could later pass for this launch's.
        baselineComplete: existing.complete,
        ...(since === undefined ? {} : { since }),
        ...(native === undefined ? {} : { native }),
      },
      spec.ferret,
    );
  }

  /**
   * Whether `codex resume <native>` would find its conversation in THIS ferret's home (`<home>/sessions/**`): `true` when
   * a rollout there names it, `false` only when a COMPLETE walk found none, `undefined` on any doubt (a cap, a folder or
   * a file that could not be read), so a resume is never given up on a guess.
   */
  async has(ferret: FerretId, native: string): Promise<boolean | undefined> {
    try {
      const where = await this.sessions(ferret);
      // A pooled ferret resumes a conversation any ferret on this harness wrote: it is looked for in the pool, by the one
      // id (the file name narrows the walk; the header still proves it).
      const walked = await walkRollouts(
        where.root,
        where.directory,
        where.pooled ? async () => false : async () => await this.sessionsAbsent(ferret),
        where.pooled ? { id: native } : undefined,
      );
      if (walked.found.some(rollout => rollout.id === native)) return true;
      return walked.complete ? false : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The conversation this ferret's last launch is PROVED to have written (`Harness.provedConversation`): proved afresh,
   * from the launch's binding (its baseline and the correlation marker only it typed, or the native id it resumed), never
   * by folder or recency. It is RECORDED and resumed, so it is proved STRICTLY: `undefined` on any doubt — no binding, a
   * home that is not the ferret's own, none or two candidates, a walk now that did not see everything (a cap, a folder or
   * a header it could not read, a correlation window it could not read), or, for a launch that named no conversation, a
   * baseline that did not see everything (or a binding from before that was recorded, which is treated the same way).
   */
  async provedConversation(
    ferret: FerretId,
  ): Promise<{ readonly id: string; readonly file: string; readonly home: string } | undefined> {
    try {
      const found = await this.proveAfresh(ferret, true);
      return found === undefined
        ? undefined
        : { id: found.rollout.id, file: found.rollout.file, home: found.binding.home };
    } catch {
      return undefined;
    }
  }

  /** The rollout proved to be the ferret's, found once and remembered: a stamp asked every half second must not walk the home. */
  readonly #proved = new ProofCache<FerretId, Rollout>(PROOF_REUSE_MS);

  /** Drops what was proved about this ferret (a relaunch, a stop): the next read proves it afresh. */
  forget(ferret: FerretId): void {
    this.#proved.forget(ferret);
  }

  /**
   * The rollout proved to be this ferret's (never guessed by folder or recency), or `undefined` while none is. A read
   * (`remembered` false) proves it afresh every time, so ambiguity is seen the moment it appears; the stamp and the tail,
   * asked every half second, may rely on a proof at most {@link PROOF_REUSE_MS} old.
   */
  private async proved(
    ferret: FerretId,
    remembered = false,
  ): Promise<{ readonly root: RootHandle; readonly rollout: Rollout } | undefined> {
    const root = (await this.sessions(ferret)).root;
    const known = remembered ? this.#proved.fresh(ferret, Date.parse(this.kernel.clock.now())) : undefined;
    if (known !== undefined) {
      const stat = await root.stat(known.file).catch(() => undefined);
      if (stat?.kind === 'file') return { root, rollout: { ...known, size: stat.size, modified: stat.modified } };
    }
    const fresh = await this.proveAfresh(ferret);
    return fresh === undefined ? undefined : { root: fresh.root, rollout: fresh.rollout };
  }

  /** The proof itself, from the binding and the files on disk, never from the remembered one (which it replaces). */
  private async proveAfresh(
    ferret: FerretId,
    strict = false,
  ): Promise<{ readonly root: RootHandle; readonly rollout: Rollout; readonly binding: Binding } | undefined> {
    const where = await this.sessions(ferret);
    const root = where.root;
    this.#proved.forget(ferret);
    const binding = await this.binding(ferret);
    if (binding === undefined) return undefined;
    const ownHome = this.owner(ferret).resolve('');
    if (!ownHome.ok || ownHome.value !== binding.home) return undefined;
    // STRICT (a proof that is recorded): a launch that named no conversation is proved only against a baseline that saw
    // everything, and only by a walk now that sees everything, so a rollout either one missed cannot be passed over or
    // taken for this launch's. The transcript reader keeps its own (unrecorded) proof.
    if (strict && binding.native === undefined && binding.baselineComplete !== true) return undefined;
    // In the shared pool a conversation this launch named is looked for by its id alone, and a new one only among the
    // days since the launch: other ferrets' rollouts are never candidates (and the correlation marker is per HOME).
    const walked = await walkRollouts(
      root,
      where.directory,
      where.pooled ? async () => false : async () => await this.sessionsAbsent(ferret),
      where.pooled ? { since: binding.since, id: binding.native } : undefined,
    );
    if (strict && !walked.complete) return undefined;
    const candidates = walked.found;
    let chosen: Rollout | undefined;
    if (binding.native !== undefined) {
      const matches = candidates.filter(candidate => candidate.id === binding.native);
      chosen = matches.length === 1 ? matches[0] : undefined;
    } else {
      const needle = `${binding.home}/codex-correlation/unreachable`;
      const evidence = [];
      for (const candidate of candidates) {
        const correlated = await contains(root, candidate, needle);
        // A window that could not be read may hide this launch's marker: doubt, for a recorded proof.
        if (strict && correlated === undefined) return undefined;
        evidence.push({ id: candidate.id, file: candidate.file, correlated: correlated === true });
      }
      const selected = selectCodexRollout(evidence, { baseline: binding.baseline });
      chosen = selected === undefined ? undefined : candidates.find(candidate => candidate.file === selected.file);
    }
    if (chosen === undefined) return undefined;
    // A proof older than PROOF_REUSE_MS is proved again before it is used, so it is dead weight: dropped here.
    this.#proved.remember(ferret, chosen, Date.parse(this.kernel.clock.now()));
    return { root, rollout: chosen, binding };
  }

  private async owned(ferret: FerretId): Promise<OwnedRollout | undefined> {
    const found = await this.proved(ferret);
    if (found === undefined) return undefined;
    const text = await found.root.readText(found.rollout.file).catch(() => undefined);
    return text === undefined ? undefined : { ...found.rollout, text };
  }

  /** One stat of the proved rollout (`Harness.transcriptStamp`). */
  readonly stamp: NonNullable<Harness['transcriptStamp']> = async ferret => {
    const found = await this.proved(ferret, true).catch(() => undefined);
    if (found === undefined) return undefined;
    return { file: found.rollout.file, size: found.rollout.size, mtimeMs: Date.parse(found.rollout.modified) };
  };

  /**
   * The proved rollout as a windowed, UNMASKED byte handle (`Harness.transcriptBytes`, G162): read in windows, an opaque
   * token and no path, bound to the ONE object it opened. Its one consumer (Conversation's reader) masks every answer it
   * cuts from these bytes.
   *
   * NEVER the remembered proof (that is a filename, and a name can be given to another file within its window): the
   * ownership is proved afresh, the file is opened, and the proof is then CHECKED ON THE OPENED OBJECT itself (its
   * header names the proved conversation and, until the harness has recorded the native id, its correlation marker is
   * in the head or tail), so a file swapped in between the proof and the open is never handed over as the ferret's.
   * Once held, a later replacement is caught by the handle on every read.
   */
  readonly bytes: NonNullable<Harness['transcriptBytes']> = async ferret => {
    try {
      const found = await this.proveAfresh(ferret);
      if (found === undefined) return undefined;
      const handle = await openTranscriptBytes(found.root, found.rollout.file, 'codex', sha256Hex, {
        clock: this.kernel.clock,
      });
      if (handle === undefined) return undefined;
      if (await this.#ownsOpened(handle, found.rollout, found.binding)) return handle;
      await handle.close();
      return undefined;
    } catch {
      // A rollout the root refuses (a link put where the file was) is no proved transcript; the refusal is not passed on.
      return undefined;
    }
  };

  /** Whether the object a handle holds is the rollout the proof chose: judged on what the DESCRIPTOR reads, not on a name. */
  async #ownsOpened(handle: HarnessTranscriptBytes, rollout: Rollout, binding: Binding): Promise<boolean> {
    try {
      const head = decoder.decode(await handle.read(0, HEAD_BYTES));
      if (metadata(head)?.id !== rollout.id) return false;
      if (binding.native !== undefined) return true;
      const needle = `${binding.home}/codex-correlation/unreachable`;
      if (head.includes(needle)) return true;
      const size = (await handle.stat())?.size ?? 0;
      if (size <= HEAD_BYTES) return false;
      const tail = decoder.decode(await handle.read(Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES));
      return tail.includes(needle);
    } catch {
      return false;
    }
  }

  /** The newest `limit` records of the proved rollout, without their text (`Harness.transcriptTail`). */
  readonly tail: NonNullable<Harness['transcriptTail']> = async (ferret, limit) => {
    const found = await this.proved(ferret, true).catch(() => undefined);
    if (found === undefined) return { kind: 'unresolved' };
    const read = await found.root.readTail(found.rollout.file, TAIL_READ_BYTES).catch(() => undefined);
    if (read === undefined) return { kind: 'unreadable' };
    const lines = decoder.decode(read.bytes).split('\n');
    const partial = read.size > read.bytes.length;
    // The window may start mid-record, and the last line may be one the harness has not finished: neither is read.
    if (partial) lines.shift();
    lines.pop();
    // The one sentence a record may carry is masked whole, then cut, before it leaves the harness.
    const records = await this.kernel.redaction.read(scope => {
      const parsed: HarnessTailRecord[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          for (const event of this.#parser.parseRecord(JSON.parse(line), {
            source: found.rollout.file,
            line: index + 1,
            sessionId: found.rollout.id,
          }).events) {
            const record = tailRecordOf(event, text => scope.text(text));
            if (record !== undefined) parsed.push(record);
          }
        } catch {
          /* A line that is not a record says nothing about the turn. */
        }
      }
      return parsed;
    });
    // A window that reads no message, work or turn boundary whole cannot say where the turn stands (the newest record is
    // larger than it, or only bookkeeping follows the cut one): a turn at work, never "no records", so one idle-looking
    // frame cannot end it. The window is never widened.
    return { kind: 'read', records: markCutWindow(records, partial).slice(-limit) };
  };

  private events(rollout: OwnedRollout) {
    // Ignore only the unflushed suffix, so a partially appended record is seen once it is complete.
    const lines = rollout.text.split('\n');
    lines.pop();
    return lines.flatMap((line, index) => {
      try {
        return this.#parser.parseRecord(JSON.parse(line), {
          source: rollout.file,
          line: index + 1,
          sessionId: rollout.id,
        }).events;
      } catch {
        return [];
      }
    });
  }

  readonly transcript: Harness['transcript'] = {
    read: async (ferret, after, limit) => {
      const rollout = await this.owned(ferret);
      if (rollout === undefined) return [];
      const entries = this.events(rollout).map(
        (event, index): TranscriptEntry => ({
          id: `${rollout.id}:${event.line}:${event.blockIndex ?? index}:${event.kind}`,
          at: (event.timestamp ?? rollout.modified) as Instant,
          role: event.role === 'developer' ? 'system' : event.role,
          ...('text' in event ? { text: event.text } : {}),
          data: event as unknown as JsonValue,
        }),
      );
      const start = after === undefined ? 0 : entries.findIndex(entry => entry.id === after) + 1;
      if (after !== undefined && start === 0) return [];
      const page = entries.slice(start, limit === undefined ? undefined : start + Math.max(0, limit));
      // Each string is masked ON ITS OWN, never the page's JSON: a secret holding a quote, a backslash, a newline or a
      // control character is ESCAPED by JSON.stringify and so would not match its own words (ports-pending, G162).
      return await this.kernel.redaction.read(scope =>
        page.map(
          (entry): TranscriptEntry => ({
            ...entry,
            ...(entry.text === undefined ? {} : { text: scope.text(entry.text) }),
            ...(entry.data === undefined ? {} : { data: scrubStrings(entry.data, scope.text) as JsonValue }),
          }),
        ),
      );
    },
    find: async (ferret, id) => (await this.transcript.read(ferret)).find(entry => entry.id === id),
    follow: (ferret, signal) => this.follow(ferret, signal),
  };

  private async *follow(ferret: FerretId, signal: AbortSignal): AsyncIterable<TranscriptEntry> {
    let after: string | undefined;
    while (!signal.aborted) {
      for (const entry of await this.transcript.read(ferret, after)) {
        if (signal.aborted) return;
        after = entry.id;
        yield entry;
      }
      if (!signal.aborted)
        await this.kernel.clock.sleep(seconds(1), signal).catch(error => {
          if (!signal.aborted) throw error;
        });
    }
  }

  readonly usage: Harness['usage'] = {
    turns: async (ferret, since) => {
      const rollout = await this.owned(ferret);
      if (rollout === undefined) return [];
      const turns: TurnUsage[] = [];
      let model: string | undefined;
      let turn = 0;
      let lastTotal: number | undefined;
      for (const event of this.events(rollout)) {
        if (event.kind === 'settings') model = event.settings.model ?? model;
        if (event.kind === 'turn' && event.state === 'started') turn++;
        if (event.kind !== 'usage') continue;
        const total = event.usage.sessionTotalTokens;
        if (total !== undefined && total === lastTotal) continue;
        lastTotal = total;
        const at = (event.timestamp ?? rollout.modified) as Instant;
        if (since !== undefined && at < since) continue;
        turns.push({
          turn,
          at,
          ...(model === undefined ? {} : { model }),
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          cacheReadTokens: event.usage.cachedInputTokens,
          cacheWriteTokens: event.usage.cacheCreationInputTokens,
        });
      }
      return await this.kernel.redaction.read(scope => JSON.parse(scope.text(JSON.stringify(turns))) as TurnUsage[]);
    },
  };

  /**
   * Copy-on-link (docs/design/shared-history.md, 3.2): the owner's own `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`
   * copied into the shared pool at the same relative path, so a ferret started on it resumes the copy. The original is read
   * through the read-only `harness-history` root and is never written, linked or locked; the copy is written whole and only
   * if the pool has nothing at that name. The rollout's own header must name the id (a file name is never identity).
   */
  async import(input: ConversationImport): Promise<Result<void, { readonly reason: string }>> {
    const refuse = (reason: string): Result<void, { readonly reason: string }> => err({ reason });
    const named = new RegExp(`^sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]*-${input.id}\\.jsonl$`, 'u');
    if (!this.hostHistoryOn()) return refuse(HOST_HISTORY_OFF);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.id) || !named.test(input.source))
      return refuse('That is not a Codex rollout file of this id.');
    try {
      const directory = await this.historyHome();
      if (directory === undefined || !directory.startsWith('/'))
        return refuse("Codex's history folder is not known on this machine.");
      const history = this.kernel.roots.root('harness-history', { subfolder: directory });
      const from = history.resolve(input.source);
      const pool = this.kernel.roots.historyPool();
      const to = pool.resolve(input.source);
      if (!from.ok || !to.ok) return refuse('That rollout file is outside the folders Ferretry may use.');
      if ((await pool.lstat(to.value)) !== undefined) return ok(undefined);
      const found = await history.stat(from.value);
      if (found?.kind !== 'file') return refuse('That rollout file is not there any more.');
      if (found.size > MAX_IMPORT_BYTES) return refuse('That rollout file is too large to copy (over 256 MB).');
      const head = await window(history, from.value, 0, HEAD_BYTES);
      if (head === undefined || metadata(head)?.id !== input.id)
        return refuse('That rollout file does not belong to that conversation.');
      const folder = pool.resolve(input.source.slice(0, input.source.lastIndexOf('/')));
      if (!folder.ok) return refuse('That rollout file is outside the folders Ferretry may use.');
      await pool.makeDirectory(folder.value, { mode: 0o700 });
      await pool.writeBytes(to.value, await history.readBytes(from.value, MAX_IMPORT_BYTES), { exclusive: true });
      return ok(undefined);
    } catch {
      return refuse('The rollout could not be copied.');
    }
  }
  /**
   * Fork (`Harness.fork`): the ferret's PROVED rollout, cut at a turn into a NEW rollout in the shared pool, under a new id
   * and today's day folder, keyed to the folder the new ferret works in. The source is only read: never written, moved or
   * locked. The new file is created only if nothing is at its name; `discard` takes back that one file (the one this call
   * made, checked by identity), so a start that never happens leaves nothing behind but what `discard` removes.
   */
  readonly fork: NonNullable<Harness['fork']> = async (from, at, into) => {
    const found = await this.proved(from);
    const binding = await this.binding(from);
    if (found === undefined || binding === undefined)
      throw new Error('this ferret has no conversation of its own yet, so there is nothing to fork');
    if (found.rollout.size > MAX_IMPORT_BYTES) throw new Error('the conversation is too large to copy (over 256 MB)');
    let pool: RootHandle;
    try {
      pool = this.kernel.roots.historyPool();
    } catch {
      throw new Error('this Codex keeps no shared history, so it cannot hold a forked conversation');
    }
    const id = crypto.randomUUID();
    const cut = cutRollout(await found.root.readText(found.rollout.file, MAX_IMPORT_BYTES), at, {
      id,
      folder: into.folder,
      marker: `${binding.home}/codex-correlation/unreachable`,
    });
    if (cut.kind === 'refused') throw new Error(cut.reason);
    const name = rolloutName(id, new Date(this.kernel.clock.now()));
    const file = pool.resolve(name);
    const folder = pool.resolve(name.slice(0, name.lastIndexOf('/')));
    if (!file.ok || !folder.ok) throw new Error('the forked conversation cannot be placed in the shared history');
    await pool.makeDirectory(folder.value, { mode: 0o700 });
    await pool.writeBytes(file.value, new TextEncoder().encode(cut.text), { exclusive: true });
    const made = await pool.fileIdentity(file.value);
    return {
      from,
      ...(at === undefined ? {} : { at }),
      harnessConversation: id,
      discard: async () => {
        // Only the very file this fork made: gone already, or a different file at the name, is left as it is.
        const now = await pool.fileIdentity(file.value);
        if (made !== undefined && now?.device === made.device && now.inode === made.inode)
          await pool.remove(file.value);
      },
    };
  };

  readonly conversations: Harness['conversations'] = {
    list: async folder => {
      if (!this.hostHistoryOn()) return [];
      const history = await this.historyHome();
      if (history === undefined) return [];
      // The walk starts at `sessions` and never follows a link, so no listing can reach a Codex auth document.
      const files = await rollouts(this.kernel.roots.root('harness-history', { subfolder: history }), 'sessions');
      const found: FoundConversation[] = files
        .filter(file => folder === undefined || file.folder === folder)
        .map(file => ({ id: file.id, folder: file.folder, updatedAt: file.modified }));
      return await this.kernel.redaction.read(
        scope => JSON.parse(scope.text(JSON.stringify(found))) as FoundConversation[],
      );
    },
  };
}
