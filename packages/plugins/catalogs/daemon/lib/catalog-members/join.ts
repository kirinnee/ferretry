/**
 * ONE JOIN, from a record a stranger sent to a sealed outcome (docs/relay-protocol.md §14 "Member sessions").
 *
 * ## The order, which is contract
 *
 * 1. The per-peer budget of FAILED joins (direct only; a relayed session has no peer worth keying by).
 * 2. The stateless checks: the share code's shape, the member key, the box key, the client name, and the proof
 *    over this session's transcript. Any failure is the generic refusal and SPENDS NOTHING.
 * 2b. A code that names a person who already has a passkey needs ONE of that person's passkeys proved first
 *    ({@link MemberJoinProver}); a code the owner marked "They need a new passkey" and a person's first browser need
 *    none. A missing or failed proof is a refusal that SPENDS NOTHING — the code stays live — and the admission step
 *    checks the same rule again, so nothing here is the only lock.
 * 3. The admission step, synchronously (2b-1): the code is looked up, checked, spent and a slot reserved.
 * 4. AWAIT the admission's `persisted` — the burn is on disk before anything is answered, a refusal included.
 * 5. `commit`, then the answer. A reservation lapses after thirty seconds, so it is committed or released in a
 *    `finally` and is never held across anything slow: the proof was checked before it was taken, and the audit
 *    is written after it was given up.
 *
 * Every refusal is the SAME refusal. Nothing here says why to the browser; the owner's log may.
 */
import {
  type DaemonCarrier,
  CatalogShareCodeSchema,
  MEMBER_JOIN_ATTEMPTS_PER_MINUTE,
  type MemberJoinedResponse,
  MemberClientNameSchema,
} from '../boundary.ts';
import { MemberBoxKeySchema, MemberKeySchema } from '../relay-wire/index.ts';
import type { AuditEntry } from '../audit.ts';
import type {
  MemberJoinAnswer,
  MemberJoinAttempt,
  MemberJoinCarrier,
  MemberJoinOptionsAttempt,
  MemberJoinOptionsResult,
  MemberJoinResult,
} from './member-session.ts';
import type { MemberJoinProver } from './join-proof.ts';
import type { CatalogMemberService, JoinNeeded, JoinProven } from './service.ts';
import type { MemberAuditSink } from './ports.ts';

const MINUTE_MS = 60_000;

/** The most peers the failed-join budget remembers; past it the oldest windows go first. */
const BUDGET_PEERS_MAX = 4_096;

/**
 * FAILED JOINS PER PEER, in a fixed one-minute window.
 *
 * A peer that has failed {@link MEMBER_JOIN_ATTEMPTS_PER_MINUTE} times this minute is refused without anything
 * being looked at. Only failures count: a person who joins is not limited, and a stranger guessing codes is.
 * The map is bounded, so a flood of distinct peers cannot grow it.
 */
export class FailedJoinBudget {
  readonly #windows = new Map<string, { startedAt: number; failures: number }>();

  spent(peer: string, now: number): boolean {
    const window = this.#windows.get(peer);
    return (
      window !== undefined && now - window.startedAt < MINUTE_MS && window.failures >= MEMBER_JOIN_ATTEMPTS_PER_MINUTE
    );
  }

  fail(peer: string, now: number): void {
    const window = this.#windows.get(peer);
    if (window !== undefined && now - window.startedAt < MINUTE_MS) {
      window.failures += 1;
      return;
    }
    this.#windows.delete(peer);
    if (this.#windows.size >= BUDGET_PEERS_MAX) this.#evict(now);
    this.#windows.set(peer, { startedAt: now, failures: 1 });
  }

  /** Expired windows first; when every window is live, the oldest one. */
  #evict(now: number): void {
    for (const [peer, window] of this.#windows) if (now - window.startedAt >= MINUTE_MS) this.#windows.delete(peer);
    const oldest = this.#windows.keys().next();
    if (this.#windows.size >= BUDGET_PEERS_MAX && !oldest.done) this.#windows.delete(oldest.value);
  }
}

/** What the `joined` answer says about the machine, read at the moment of the join. */
export interface MemberJoinPublisher {
  readonly daemonId: string;
  readonly daemonName: string;
  readonly carriers: readonly DaemonCarrier[];
  readonly memberUnlockDays: number;
}

export interface MemberJoinDeps {
  readonly members: Pick<CatalogMemberService, 'ready' | 'joinNeed' | 'admitJoin' | 'commit' | 'release'>;
  readonly proof: Pick<MemberJoinProver, 'options' | 'verify'>;
  readonly publisher: () => MemberJoinPublisher;
  readonly audit: MemberAuditSink;
  readonly now: () => number;
  /** Runs a callback once, after this many milliseconds. */
  readonly after: (run: () => void, ms: number) => void;
}

/** The join record's fields as a stranger spelled them, judged by the share API's own schemas. */
function wellFormed(attempt: MemberJoinAttempt): boolean {
  return (
    CatalogShareCodeSchema.safeParse(attempt.code).success &&
    MemberKeySchema.safeParse(attempt.memberKey).success &&
    MemberBoxKeySchema.safeParse(attempt.boxKey).success &&
    MemberClientNameSchema.safeParse(attempt.clientName).success
  );
}

const REFUSED: MemberJoinResult = { ok: false };

type Attempted = { readonly joined: MemberJoinedResponse } | { readonly why: string };

/** The `join-options` record's fields as a stranger spelled them. */
function optionsWellFormed(attempt: MemberJoinOptionsAttempt): boolean {
  return (
    CatalogShareCodeSchema.safeParse(attempt.code).success &&
    MemberKeySchema.safeParse(attempt.memberKey).success &&
    attempt.origin.length > 0 &&
    attempt.origin.length <= 256
  );
}

const OPTIONS_REFUSED: MemberJoinOptionsResult = { ok: false };

export class MemberJoinGate {
  readonly #budget = new FailedJoinBudget();
  /** Per share: when a proof refusal was last written. */
  readonly #proofWritten = new Map<string, number>();
  /** Per carrier: when a refusal was last written, how many were left out since, and the last one's reason. */
  readonly #written = new Map<string, { at: number; folded: number; reason: string; armed: boolean }>();

  constructor(private readonly deps: MemberJoinDeps) {}

  /** Never throws: anything that goes wrong is the one refusal. */
  async join(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<MemberJoinResult> {
    const peer = carrier.kind === 'direct' ? carrier.rateLimitKey : undefined;
    if (peer !== undefined && this.#budget.spent(peer, this.deps.now())) {
      await this.#refused(carrier, 'budget');
      return REFUSED;
    }
    const attempted = await this.#attempt(attempt, carrier);
    if ('joined' in attempted) return { ok: true, response: attempted.joined };
    if (peer !== undefined) this.#budget.fail(peer, this.deps.now());
    await this.#refused(carrier, attempted.why);
    return REFUSED;
  }

  /**
   * What a join with this code needs, spending nothing: the same refusal for an unknown code, a dead one, a person
   * who is gone, a person who may not join without the owner's say-so, and a person with no passkey that answers at
   * this page. Never throws.
   */
  async options(attempt: MemberJoinOptionsAttempt, carrier: MemberJoinCarrier): Promise<MemberJoinOptionsResult> {
    const peer = carrier.kind === 'direct' ? carrier.rateLimitKey : undefined;
    if (peer !== undefined && this.#budget.spent(peer, this.deps.now())) {
      await this.#refused(carrier, 'budget');
      return OPTIONS_REFUSED;
    }
    const answered = await this.#options(attempt);
    if ('answer' in answered) return { ok: true, answer: answered.answer };
    if (peer !== undefined) this.#budget.fail(peer, this.deps.now());
    await this.#refused(carrier, answered.why);
    if (answered.needed !== undefined) await this.#proofRefused(answered.needed, answered.why);
    return OPTIONS_REFUSED;
  }

  async #options(
    attempt: MemberJoinOptionsAttempt,
  ): Promise<{ readonly answer: MemberJoinAnswer } | { readonly why: string; readonly needed?: JoinNeeded }> {
    try {
      if (!optionsWellFormed(attempt)) return { why: 'malformed' };
      if (!(await attempt.prove())) return { why: 'proof' };
      const { members } = this.deps;
      await members.ready();
      const needed = members.joinNeed(attempt.code, this.deps.now());
      if (needed === undefined) return { why: 'share_refused' };
      if (needed.need === 'blocked') return { why: 'approval-required', needed };
      if (needed.need === 'first-browser') return { answer: { kind: 'open', why: 'first-browser' } };
      if (needed.need === 'owner-approved') return { answer: { kind: 'open', why: 'owner-approved' } };
      const options = await this.deps.proof.options(
        { shareId: needed.shareId, memberId: needed.memberId, memberKey: attempt.memberKey },
        attempt.origin,
      );
      if (options === undefined) return { why: 'no-passkey-here', needed };
      return { answer: { kind: 'challenge', memberLabel: needed.memberLabel, options } };
    } catch {
      return { why: 'failed' };
    }
  }

  async #attempt(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<Attempted> {
    try {
      if (!wellFormed(attempt)) return { why: 'malformed' };
      if (!(await attempt.prove())) return { why: 'proof' };
      return await this.#admit(attempt, carrier);
    } catch {
      return { why: 'failed' };
    }
  }

  async #admit(attempt: MemberJoinAttempt, carrier: MemberJoinCarrier): Promise<Attempted> {
    const { members } = this.deps;
    // Read BEFORE anything is spent, so a machine that cannot describe itself refuses a join that costs no code.
    const publisher = this.deps.publisher();
    await members.ready();
    const proven = await this.#proven(attempt);
    if ('why' in proven) return proven;
    const admission = members.admitJoin(attempt.code, this.deps.now(), proven.proven);
    const held = admission.ok ? admission.reservation : undefined;
    let committed = false;
    let joined: Awaited<ReturnType<typeof members.commit>>;
    try {
      // The burn is on disk before the browser hears anything, the refusal's included.
      await admission.persisted;
      if (!admission.ok) return { why: admission.reason };
      joined = await members.commit(admission.reservation, {
        memberKey: attempt.memberKey,
        boxKey: attempt.boxKey,
        clientName: attempt.clientName,
      });
      committed = true;
    } finally {
      if (held !== undefined && !committed) await members.release(held).catch(() => undefined);
    }
    if (held?.entry === 'proof' || held?.entry === 'owner-approved') {
      await this.#record({
        event: held.entry === 'proof' ? 'catalog.member.join-proved' : 'catalog.member.new-passkey-used',
        actor: { kind: 'anonymous' },
        subject: joined.memberId,
        outcome: 'succeeded',
        detail: { shareId: held.shareId, keyId: joined.keyId, carrier: carrier.kind },
      });
    }
    await this.#record({
      event: 'catalog.member.joined',
      actor: { kind: 'anonymous' },
      subject: joined.memberId,
      outcome: 'succeeded',
      detail: {
        memberLabel: text(joined.label),
        keyId: joined.keyId,
        clientName: text(attempt.clientName),
        carrier: carrier.kind,
      },
    });
    return {
      joined: {
        memberId: joined.memberId,
        keyId: joined.keyId,
        label: joined.label,
        daemonId: publisher.daemonId,
        daemonName: publisher.daemonName,
        catalogCount: joined.catalogCount,
        carriers: [...publisher.carriers],
        passkeyWindowEndsAt: joined.passkeyWindowEndsAt,
        memberUnlockDays: publisher.memberUnlockDays,
      },
    };
  }

  /**
   * The proof a code asks for, judged BEFORE anything is spent. A person's first browser and an invite the owner
   * marked need none, so they pass with nothing proven; a code that asks for a proof and has none that holds is the
   * one refusal, with the code left live.
   */
  async #proven(attempt: MemberJoinAttempt): Promise<{ readonly proven?: JoinProven } | { readonly why: string }> {
    const needed = this.deps.members.joinNeed(attempt.code, this.deps.now());
    if (needed === undefined || needed.need === 'first-browser' || needed.need === 'owner-approved') return {};
    if (needed.need === 'blocked') {
      await this.#proofRefused(needed, 'approval-required');
      return { why: 'approval-required' };
    }
    const subject = { shareId: needed.shareId, memberId: needed.memberId, memberKey: attempt.memberKey };
    if (attempt.passkey === undefined || !(await this.deps.proof.verify(subject, attempt.passkey))) {
      await this.#proofRefused(needed, attempt.passkey === undefined ? 'proof-required' : 'proof-failed');
      return { why: 'proof-required' };
    }
    return { proven: { shareId: needed.shareId, memberId: needed.memberId } };
  }

  /** IDs only, and at most one per share per minute: a holder of one code cannot flood the log with refusals. */
  async #proofRefused(needed: JoinNeeded, reason: string): Promise<void> {
    const now = this.deps.now();
    const last = this.#proofWritten.get(needed.shareId);
    if (last !== undefined && now - last < MINUTE_MS) return;
    this.#proofWritten.delete(needed.shareId);
    if (this.#proofWritten.size >= BUDGET_PEERS_MAX) {
      const oldest = this.#proofWritten.keys().next();
      if (!oldest.done) this.#proofWritten.delete(oldest.value);
    }
    this.#proofWritten.set(needed.shareId, now);
    await this.#record({
      event: 'catalog.member.join-proof-refused',
      actor: { kind: 'anonymous' },
      subject: needed.memberId,
      outcome: 'refused',
      detail: { shareId: needed.shareId, reason },
    });
  }

  /**
   * A flood of bad codes must not flood the general audit store: one entry per carrier per minute, the first at
   * once, each saying how many refusals it stands for. What is left out is written when the minute ends, so a
   * burst's tail is never missing from the log.
   */
  async #refused(carrier: MemberJoinCarrier, why: string): Promise<void> {
    const now = this.deps.now();
    const last = this.#written.get(carrier.kind);
    if (last !== undefined && now - last.at < MINUTE_MS) {
      last.folded += 1;
      last.reason = why;
      if (!last.armed) {
        last.armed = true;
        this.deps.after(() => void this.#flush(carrier.kind, last), last.at + MINUTE_MS - now);
      }
      return;
    }
    this.#written.set(carrier.kind, { at: now, folded: 0, reason: why, armed: false });
    await this.#write(carrier.kind, why, (last?.folded ?? 0) + 1);
  }

  /** The minute is over: write what it left out, and start a quiet minute. A newer window is not this one's to flush. */
  async #flush(kind: string, window: { folded: number; reason: string }): Promise<void> {
    if (this.#written.get(kind) !== window) return;
    this.#written.set(kind, { at: this.deps.now(), folded: 0, reason: window.reason, armed: false });
    await this.#write(kind, window.reason, window.folded);
  }

  async #write(carrier: string, reason: string, count: number): Promise<void> {
    await this.#record({
      event: 'catalog.member.join-refused',
      actor: { kind: 'anonymous' },
      outcome: 'refused',
      detail: { carrier, reason, count },
    });
  }

  async #record(entry: AuditEntry): Promise<void> {
    await this.deps.audit.record(entry).catch(() => undefined);
  }
}

/** One line, bounded: an audit text is single-line and at most 160 characters. */
function text(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 160);
}
