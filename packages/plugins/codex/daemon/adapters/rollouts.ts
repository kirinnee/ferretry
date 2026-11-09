/** Codex rollout IO, through the two declared roots only. No sign-in document is opened. */
import type {
  FoundConversation,
  Harness,
  HarnessTailRecord,
  LaunchSpec,
  TranscriptEntry,
  TurnUsage,
} from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { seconds, type Instant, type JsonValue } from '@ferretry/std';
import { CODEX_ROLLOUTS, type CodexRolloutBinding as Binding } from '../../contract/index.ts';
import { CodexTranscriptParser } from '../lib/transcript/codex.ts';
import { ProofCache } from '../lib/transcript/proof-cache.ts';
import { selectCodexRollout } from '../lib/transcript/rollout.ts';
import { markCutWindow, tailRecordOf } from '../lib/transcript/tail-record.ts';

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

/** Whether the rollout's head or tail window contains `needle` (today's `contains`). */
async function contains(root: RootHandle, rollout: Rollout, needle: string): Promise<boolean> {
  if ((await window(root, rollout.file, 0, HEAD_BYTES))?.includes(needle) === true) return true;
  if (rollout.size <= HEAD_BYTES) return false;
  const tail = await window(root, rollout.file, Math.max(HEAD_BYTES, rollout.size - TAIL_BYTES), TAIL_BYTES);
  return tail?.includes(needle) === true;
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
 * Today's sessions walk (`node-codex-rollout-index.ts`): only real folders and real `.jsonl` files, each named entry
 * taken as it IS (`RootHandle.entries`, never followed), so a symbolic link — `rollout-alias.jsonl -> auth.json`, or a
 * folder link back up the home — is skipped and never opened. Every path is checked again by the root port on read.
 */
async function rollouts(root: RootHandle, directory: string): Promise<readonly Rollout[]> {
  const pending = [directory];
  const found: Rollout[] = [];
  let visited = 0;
  while (pending.length > 0 && found.length < MAX_ROLLOUTS && visited++ < MAX_DIRECTORIES) {
    const relative = pending.shift() as string;
    const path = root.resolve(relative);
    if (!path.ok) continue;
    const entries = await root.entries(path.value).catch(() => []);
    for (const entry of entries) {
      const name = entry.name;
      if (name.includes('/') || name === '.' || name === '..') continue;
      const childRelative = relative === '' ? name : `${relative}/${name}`;
      if (entry.kind === 'directory') {
        pending.push(childRelative);
        continue;
      }
      // A link, a device or anything else is not a rollout: only a plain file is ever opened.
      if (entry.kind !== 'file' || !name.endsWith('.jsonl')) continue;
      const child = root.resolve(childRelative);
      if (!child.ok) continue;
      const head = await window(root, child.value, 0, HEAD_BYTES);
      const meta = head === undefined ? undefined : metadata(head);
      if (meta !== undefined) {
        found.push({ id: meta.id, folder: meta.cwd, file: child.value, modified: entry.modified, size: entry.size });
        if (found.length >= MAX_ROLLOUTS) break;
      }
    }
  }
  return found;
}

export class CodexRollouts {
  readonly #parser = new CodexTranscriptParser();
  constructor(
    private readonly kernel: Ports,
    private readonly historyDirectory: () => Promise<string | undefined>,
  ) {}

  private owner(ferret: FerretId): RootHandle {
    return this.kernel.roots.root('agent-homes', { subfolder: ferret });
  }

  private async binding(ferret: FerretId): Promise<Binding | undefined> {
    const read = await this.kernel.state.read(CODEX_ROLLOUTS, ferret);
    if (!read.ok) throw new Error('Codex rollout ownership state is damaged');
    return read.value;
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
    const root = this.kernel.roots.root('agent-homes', { subfolder: `${spec.ferret}/sessions` });
    const existing = await rollouts(root, '');
    await this.kernel.state.write(
      CODEX_ROLLOUTS,
      {
        format: 1,
        home: home.value,
        baseline: existing.map(item => item.id),
        ...(native === undefined ? {} : { native }),
      },
      spec.ferret,
    );
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
    const root = this.kernel.roots.root('agent-homes', { subfolder: `${ferret}/sessions` });
    const known = remembered ? this.#proved.fresh(ferret, Date.parse(this.kernel.clock.now())) : undefined;
    if (known !== undefined) {
      const stat = await root.stat(known.file).catch(() => undefined);
      if (stat?.kind === 'file') return { root, rollout: { ...known, size: stat.size, modified: stat.modified } };
    }
    this.#proved.forget(ferret);
    const binding = await this.binding(ferret);
    if (binding === undefined) return undefined;
    const ownHome = this.owner(ferret).resolve('');
    if (!ownHome.ok || ownHome.value !== binding.home) return undefined;
    const candidates = await rollouts(root, '');
    let chosen: Rollout | undefined;
    if (binding.native !== undefined) {
      const matches = candidates.filter(candidate => candidate.id === binding.native);
      chosen = matches.length === 1 ? matches[0] : undefined;
    } else {
      const needle = `${binding.home}/codex-correlation/unreachable`;
      const evidence = [];
      for (const candidate of candidates)
        evidence.push({ id: candidate.id, file: candidate.file, correlated: await contains(root, candidate, needle) });
      const selected = selectCodexRollout(evidence, { baseline: binding.baseline });
      chosen = selected === undefined ? undefined : candidates.find(candidate => candidate.file === selected.file);
    }
    if (chosen === undefined) return undefined;
    // A proof older than PROOF_REUSE_MS is proved again before it is used, so it is dead weight: dropped here.
    this.#proved.remember(ferret, chosen, Date.parse(this.kernel.clock.now()));
    return { root, rollout: chosen };
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
      return await this.kernel.redaction.read(
        scope => JSON.parse(scope.text(JSON.stringify(page))) as TranscriptEntry[],
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

  readonly conversations: Harness['conversations'] = {
    list: async folder => {
      const history = await this.historyDirectory();
      if (history === undefined) return [];
      // The root is scoped to sessions and the walk never follows a link, so no listing can reach a Codex auth document.
      const files = await rollouts(this.kernel.roots.root('harness-history', { subfolder: history }), '');
      const found: FoundConversation[] = files
        .filter(file => folder === undefined || file.folder === folder)
        .map(file => ({ id: file.id, folder: file.folder, updatedAt: file.modified }));
      return await this.kernel.redaction.read(
        scope => JSON.parse(scope.text(JSON.stringify(found))) as FoundConversation[],
      );
    },
  };
}
