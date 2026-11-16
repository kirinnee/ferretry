/**
 * One live writer per harness conversation (docs/design/account-model.md H2, §9.3) — the rules, shared by the two halves
 * that must agree on them: `fy history claim` (the wrapper's claim before it `exec`s the harness, with no daemon to ask)
 * and the daemon's own launches.
 *
 * Every runtime of a harness shares one history pool, so a ferret, another ferret and a person's own terminal can reach
 * the same conversation. A claim names the conversation a launch will WRITE; a conversation another live writer holds
 * refuses the claim with that writer named, and a lease whose writer is gone is taken over without anyone's permission,
 * because a dead writer cannot be harmed by it.
 *
 * Pure but for the {@link ConversationLeaseDisk} it is handed: the files, the cross-process lock and the host's record of
 * when a process started are an adapter's (`cli/adapters/history`), never read here. A contract imports only zod, so the
 * store is written against that port and the daemon half binds its own.
 */
import { z } from 'zod';

/**
 * The exit status `fy history claim` answers when another session is writing the conversation: the ONE status a wrapper
 * turns into not launching (75, `EX_TEMPFAIL`). Every other failure of `fy` launches anyway, because a lease bug must
 * never stop a person's own CLI from starting — except a wrapper the daemon launched (`FY_SESSION_ID` set), whose claim
 * is what moves the daemon's lease onto the harness's own pid: it cannot do that, so it exits 75 too (the Warden leaves a
 * 75 alone, so it is never revived into the same refusal).
 */
export const HISTORY_CLAIM_HELD_EXIT_CODE = 75;

/** The harnesses that keep a conversation history to lease. */
export const HistoryHarnessSchema = z.enum(['claude', 'codex']);
export type HistoryHarness = z.infer<typeof HistoryHarnessSchema>;

/**
 * A harness conversation id as it may be used for a lease file name.
 *
 * Both harnesses name conversations with UUIDs. The grammar is wider than a UUID so a future id shape still leases, and
 * narrow enough that an id can never be a path: no separator, no NUL, no dot (so neither `.` nor `..` nor a hidden name),
 * a leading letter or digit (so never an option), and at most 128 characters. Parsed at every boundary an id comes in
 * through — a launch's arguments, `fy history claim` — so a store is handed a {@link ConversationId} and never a string
 * it would have to judge itself.
 */
export const ConversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .brand<'ConversationId'>();
export type ConversationId = z.infer<typeof ConversationIdSchema>;

/** Who is writing a conversation. A daemon-launched writer names its session; a terminal one does not. */
const ConversationLeaseHolderSchema = z.strictObject({
  pid: z.number().int().positive(),
  /**
   * The holder's start time, compared only with another read on the same host (Linux clock ticks, macOS epoch
   * seconds). Absent when the platform could not report it: the pid alone then decides.
   */
  start: z.number().int().positive().optional(),
  /** The Ferretry session writing it, when a daemon launched the writer. */
  session: z.string().min(1).optional(),
  /** The runtime (wrapper name) it runs on, for the refusal sentence only. */
  runtime: z.string().min(1).optional(),
});
type ConversationLeaseHolder = z.infer<typeof ConversationLeaseHolderSchema>;

export const ConversationLeaseRecordSchema = z.strictObject({
  v: z.literal(1),
  harness: HistoryHarnessSchema,
  conversation: ConversationIdSchema,
  holder: ConversationLeaseHolderSchema,
  since: z.iso.datetime({ offset: true }),
});
export type ConversationLeaseRecord = z.infer<typeof ConversationLeaseRecordSchema>;

/** What a claimant asks for. Its start time is read by the store, never trusted from the caller. */
export interface ConversationLeaseClaim {
  readonly harness: HistoryHarness;
  readonly conversation: ConversationId;
  readonly holder: Omit<ConversationLeaseHolder, 'start'>;
}

/**
 * Whether the session named on an existing lease is still writing, as far as the caller can tell.
 *
 * Only a daemon can answer `live` or `over`: it holds the session records. A terminal claim answers `unknown`, and the
 * holder's process then decides alone.
 */
export type ConversationHolderStanding = 'live' | 'over' | 'unknown';

/** What the store observed about an existing lease before deciding. */
export interface ConversationLeaseFacts {
  /** The existing holder's start time read NOW; `undefined` when that pid is gone. */
  readonly holderStart: number | undefined;
  readonly holderSession: ConversationHolderStanding;
}

/**
 * How a claim lands.
 *
 * `renew` is the same writer claiming again (a revive of the same session, or a daemon-launched wrapper upgrading the
 * daemon's lease to its own pid); `take-over` replaces a stale lease.
 */
export type ConversationLeaseDecision = 'create' | 'renew' | 'take-over' | 'held';

/**
 * Whether a lease's holder is the claimant itself.
 *
 * A session is compared by session alone: every session one daemon launches carries that daemon's pid, so a pid match
 * between two of them proves nothing. Only two sessionless claims compare pids.
 */
function sameHolder(
  existing: ConversationLeaseHolder,
  claim: ConversationLeaseClaim['holder'],
  facts: ConversationLeaseFacts,
): boolean {
  if (existing.session !== undefined || claim.session !== undefined) return existing.session === claim.session;
  return existing.pid === claim.pid && existing.start !== undefined && existing.start === facts.holderStart;
}

/** Whether the process recorded on a lease is the one still running under that pid. */
function holderProcessAlive(existing: ConversationLeaseHolder, facts: ConversationLeaseFacts): boolean {
  if (facts.holderStart === undefined) return false;
  return existing.start === undefined || existing.start === facts.holderStart;
}

/**
 * The one rule for one live writer per conversation (H2).
 *
 * A lease naming a session the daemon knows is decided by that session, NOT by the pid: a daemon that restarts leaves its
 * own pid dead while the pane it launched keeps writing, so a pid verdict there would let a second writer in. Everything
 * else is decided by the holder's pid and start time, so a reused pid is stale. An unreadable lease is `undefined` here
 * and is created over: it proves no holder, and refusing on it would need a person to delete a file.
 */
export function decideConversationLease(
  existing: ConversationLeaseRecord | undefined,
  claim: ConversationLeaseClaim,
  facts: ConversationLeaseFacts,
): ConversationLeaseDecision {
  if (existing === undefined) return 'create';
  if (sameHolder(existing.holder, claim.holder, facts)) return 'renew';
  if (existing.holder.session !== undefined && facts.holderSession !== 'unknown')
    return facts.holderSession === 'live' ? 'held' : 'take-over';
  return holderProcessAlive(existing.holder, facts) ? 'held' : 'take-over';
}

/** `2026-10-13 14:02 UTC`: a wall time a person can compare with their own, with its zone said. */
function leaseSince(since: string): string {
  return `${since.slice(0, 10)} ${since.slice(11, 16)} UTC`;
}

/**
 * C0, DEL and C1 controls, the line and paragraph separators, and the bidirectional marks and isolates. A lease file is
 * written by whoever claims, so a holder's session or runtime can carry them, and a sentence printed to a person's
 * terminal (or into a log) must never redraw the line or reorder the text around them.
 */
const TERMINAL_CONTROLS = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu;

/** `text` as a person can safely read it on a terminal: the controls dropped. */
function printable(text: string): string {
  return text.replace(TERMINAL_CONTROLS, '');
}

/**
 * The refusal sentence, naming who holds the conversation and how to free it. It names a pid or a session, never a path.
 * The holder's session and runtime come from a file, so they are printed without their control characters.
 */
export function conversationLeaseRefusal(record: ConversationLeaseRecord): string {
  const holder = record.holder;
  const session = holder.session === undefined ? undefined : printable(holder.session);
  const who =
    session === undefined
      ? `another ${record.harness} running as process ${holder.pid}`
      : `session ${session}${holder.runtime === undefined ? '' : ` on ${printable(holder.runtime)}`}`;
  const remedy =
    session === undefined
      ? 'close that one first; only one writer may hold a conversation at a time'
      : `stop or resume session ${session} instead; only one writer may hold a conversation at a time`;
  return `conversation ${record.conversation} is being written by ${who} since ${leaseSince(record.since)}: ${remedy}`;
}

/** A claim refused because another live writer holds the conversation. */
export class ConversationLeaseHeldError extends Error {
  constructor(readonly lease: ConversationLeaseRecord) {
    super(conversationLeaseRefusal(lease));
    this.name = 'ConversationLeaseHeldError';
  }
}

/** The value of `flag` in `args`, as `flag value` or `flag=value`; `undefined` when absent or bare. */
function flagValue(args: readonly string[], flags: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    for (const flag of flags) {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (arg === flag) {
        const next = args[index + 1];
        return next === undefined || next.startsWith('-') ? undefined : next;
      }
    }
  }
  return undefined;
}

/** An id that is safe to lease, or nothing. */
function leasable(candidate: string | undefined): ConversationId | undefined {
  return candidate === undefined ? undefined : ConversationIdSchema.safeParse(candidate).data;
}

/**
 * The conversation a launch will WRITE, read from its arguments (the executable excluded).
 *
 * Claude: `--session-id <id>` names the conversation being written. `--resume <id>` / `-r <id>` continues one — unless
 * `--fork-session` is also given, which writes a NEW conversation and only reads the resumed one, so nothing is leased
 * for the resumed id. Codex: `resume <id>` (also under `exec`). A bare `--resume`, `--continue`, `resume --last` and the
 * in-app picker choose the conversation after launch, so they name nothing here — declared gap G3.
 */
export function conversationFromArguments(
  harness: HistoryHarness,
  args: readonly string[],
): ConversationId | undefined {
  if (harness === 'claude') {
    const created = leasable(flagValue(args, ['--session-id']));
    if (created !== undefined) return created;
    if (args.includes('--fork-session')) return undefined;
    return leasable(flagValue(args, ['--resume', '-r']));
  }
  const resume = args.indexOf('resume');
  if (resume < 0) return undefined;
  for (const arg of args.slice(resume + 1)) {
    if (arg === '--last') return undefined;
    if (arg.startsWith('-')) continue;
    const id = leasable(arg);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The most a lease file can be: it is a few hundred bytes, and anything larger is not one, whatever it holds. A disk
 * reads at most this many and says `undefined` for a larger file, so a sparse file costs its writer nothing and is never
 * read whole.
 */
export const MAX_LEASE_BYTES = 64 * 1024;

/**
 * What a store needs of a disk. One lease is one small file per conversation under its harness's pool; the pool has
 * one cross-process lock that every read-decide-write runs under, so two claimants can never both decide a lease is
 * theirs. A disk reaches nothing by a name it was not given: a conversation id is a {@link ConversationId}.
 */
export interface ConversationLeaseDisk {
  /** Runs `work` while holding the harness pool's exclusive lock, waiting a bounded time for another claimant. */
  exclusive<T>(harness: HistoryHarness, work: () => Promise<T>): Promise<T>;
  /** The lease file's text, or `undefined` when there is none, it is not a regular file, or it is over {@link MAX_LEASE_BYTES}. */
  read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined>;
  /** Replaces the lease whole (a reader sees the old lease or the new one, never part). */
  write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void>;
  remove(harness: HistoryHarness, conversation: ConversationId): Promise<void>;
  /** Every name in the pool's lease folder; a name that is not a conversation id is skipped by the caller. */
  list(harness: HistoryHarness): Promise<readonly string[]>;
  /** Tells one run of a pid apart from a later process that reuses the number; `undefined` when the pid is gone. */
  startOf(pid: number): Promise<number | undefined>;
}

/** What a claim answers: the lease it holds now, or the live holder that refused it. */
export type ConversationLeaseOutcome =
  | {
      readonly kind: 'claimed';
      readonly decision: Exclude<ConversationLeaseDecision, 'held'>;
      readonly lease: ConversationLeaseRecord;
    }
  | { readonly kind: 'held'; readonly lease: ConversationLeaseRecord };

/** A lease as stored, or `undefined` when there is none or it is not a lease for this conversation (which proves no holder). */
function parsedLease(text: string | undefined, conversation: ConversationId): ConversationLeaseRecord | undefined {
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ConversationLeaseRecordSchema.safeParse(json);
  return parsed.success && parsed.data.conversation === conversation ? parsed.data : undefined;
}

/** The lease store: decides each claim and release against a {@link ConversationLeaseDisk}, under its lock. */
export class ConversationLeaseStore {
  constructor(
    private readonly disk: ConversationLeaseDisk,
    private readonly now: () => Date,
  ) {}

  /**
   * Claims `claim`, or reports the live holder. `standing` answers whether the session an existing lease names is still
   * writing; a caller that cannot know answers `unknown`.
   */
  async claim(
    claim: ConversationLeaseClaim,
    standing: (session: string) => Promise<ConversationHolderStanding>,
  ): Promise<ConversationLeaseOutcome> {
    const conversation = ConversationIdSchema.parse(claim.conversation);
    return await this.disk.exclusive(claim.harness, async () => {
      const existing = parsedLease(await this.disk.read(claim.harness, conversation), conversation);
      const decision = decideConversationLease(existing, claim, {
        holderStart: existing === undefined ? undefined : await this.disk.startOf(existing.holder.pid),
        holderSession: existing?.holder.session === undefined ? 'unknown' : await standing(existing.holder.session),
      });
      // Only an existing lease can be held, so `existing` is defined here.
      if (decision === 'held') return { kind: 'held', lease: existing as ConversationLeaseRecord };
      const start = await this.disk.startOf(claim.holder.pid);
      const lease: ConversationLeaseRecord = {
        v: 1,
        harness: claim.harness,
        conversation,
        holder: { ...claim.holder, ...(start === undefined ? {} : { start }) },
        // A renewal is the same writer, so the conversation has been written by it since it first took it.
        since: decision === 'renew' && existing !== undefined ? existing.since : this.now().toISOString(),
      };
      await this.disk.write(claim.harness, conversation, `${JSON.stringify(lease)}\n`);
      return { kind: 'claimed', decision, lease };
    });
  }

  /** Removes every lease `session` holds, in every pool. Returns the conversations it released. */
  async releaseSession(session: string): Promise<readonly string[]> {
    const released: string[] = [];
    for (const harness of HistoryHarnessSchema.options) {
      await this.disk.exclusive(harness, async () => {
        for (const name of await this.disk.list(harness)) {
          // The lock, a temporary, and any name this store never writes.
          const conversation = ConversationIdSchema.safeParse(name).data;
          if (conversation === undefined) continue;
          const lease = parsedLease(await this.disk.read(harness, conversation), conversation);
          if (lease?.holder.session !== session) continue;
          await this.disk.remove(harness, conversation);
          released.push(lease.conversation);
        }
      });
    }
    return released;
  }
}
