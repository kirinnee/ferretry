import { createHash } from 'node:crypto';
import type { TerminalFacts } from '@ferretry/core-vault/contract';
import {
  AgentNameSchema,
  type LoginObservation,
  type PhoneApproval,
  type PhoneApprovalAgentView,
  type PhoneApprovalRaise,
  PhoneApprovalSchema,
  type PhoneApprovalState,
  phoneApprovalWords,
} from '../../../contract/routes/index.ts';
import type { InputActor } from '../vault-inputs.ts';
import { PhoneApprovalError } from './errors.ts';
import { gatedNumber, httpsHost, movedOn } from './gates.ts';
import { approvalFacts, type Matched, matchSignIn, terminalMatchKey } from './match.ts';
import type {
  PhoneApprovalAsksPort,
  PhoneApprovalAudit,
  PhoneApprovalClock,
  PhoneApprovalFacts,
  PhoneApprovalLogins,
  PhoneApprovalNotifier,
  PhoneApprovalObserver,
  PhoneApprovalPagePort,
  PhoneApprovalPushPort,
  PhoneApprovalTerminalPort,
  PhoneApprovalTimers,
} from './ports.ts';

/**
 * APPROVE ON YOUR PHONE (docs/input-requests.md, "Approve on your phone"): a sign-in waits for a push the owner
 * approves on their phone. Nothing is typed, so this is not an input request: it is a card of the daemon's own, built
 * only from what the daemon observed, and settled only by what the daemon sees next. Copied from today's
 * `input-requests/phone-approval.ts` (bb89d054d), with its ports bound to what 5.0 offers.
 *
 * - THE NUMBER COMES ONLY FROM THE PAGE, read by the browser, and only past three gates (`./gates.ts`, I200). An element
 *   the ferret points at is never read (I201). A terminal never shows one: a ferret can print anything into its pane.
 * - NOTHING OF THE FERRET'S IS SHOWN. Its raise names where and gives hints; the card, the ask subject, the push and the
 *   log are `phoneApprovalWords` over the approval's own fields.
 * - SUCCESS IS OBSERVED, NEVER CLAIMED. `moved-on` is set only here, when the page shows a new document that is no
 *   longer the challenge (or the terminal's prompt or program changed). No route sets it, and the owner's only button is
 *   "Not me — stop". A move the ferret could have caused still ends the card, but keeps no fact and tells the ferret no
 *   `secondFactor`.
 * - THE APPROVAL LIVES IN RAM (I205): a restart ends it, and its card is closed by {@link PhoneApprovalService.restore}.
 *   Nothing here is written to disk; the log keeps ids and names, never the number (I207).
 */

/** How often a waiting approval looks at its page or terminal: the login observer's poll. */
const PHONE_APPROVAL_POLL_MS = 1_000;
/** The most approvals one ferret may have waiting at once, and how many it may ask for in an hour. */
const PHONE_APPROVAL_MAX_WAITING_PER_SESSION = 2;
const PHONE_APPROVAL_MAX_RAISES_PER_HOUR = 10;
/** The most pushes one approval makes: the raise and a few new numbers. A page that keeps changing its number stops buzzing. */
const PHONE_APPROVAL_MAX_PUSHES = 4;
const HOUR_MS = 3_600_000;
const WAIT_CEILING_MS = 600_000;

/** Who is calling: the owner (a paired device, or the machine) by who they are, or the ferret itself. */
export type PhoneApprovalCaller = { readonly kind: 'owner'; readonly actor: InputActor } | { readonly kind: 'agent' };

export interface PhoneApprovalDependencies {
  readonly pages: PhoneApprovalPagePort;
  readonly terminals: PhoneApprovalTerminalPort;
  readonly asks: PhoneApprovalAsksPort;
  readonly push: PhoneApprovalPushPort;
  readonly audit: PhoneApprovalAudit;
  readonly clock: PhoneApprovalClock;
  readonly timers: PhoneApprovalTimers;
  /** A fresh approval id: `pa_` and 24 hex digits. */
  readonly ids: () => string;
  /** Whether the ferret could have steered a surface of this kind since `since`. */
  readonly observer: PhoneApprovalObserver;
  /** Saved accounts, by their non-secret listing: which sign-in this is. Absent: every approval is an unknown sign-in. */
  readonly logins?: PhoneApprovalLogins;
  /** Where a sign-in's `secondFactor: 'push'` goes. Absent: none is kept. */
  readonly facts?: PhoneApprovalFacts;
  /** Tells the ferret "Not me" in its terminal. Absent: the ferret learns it on its next `input_wait`. */
  readonly notifier?: PhoneApprovalNotifier;
  /** This machine's host name, for a terminal's `program@host` key. */
  readonly hostName?: string;
}

interface Held {
  approval: PhoneApproval;
  readonly askId: string;
  readonly key: string;
  readonly matched: Matched;
  /** The raise instant, as the observer's clock reads it: an act of the ferret at or after it voids the fact. */
  readonly since: number;
  /** A page: the page it was raised on, by id. A terminal: the ids the pane had (none known: not pinned). */
  readonly names: readonly string[];
  /** The page's document now, and whether the document the approval was raised on was a provider's challenge. */
  document?: string;
  /** The document the approval was raised on: after a ferret act, only its number counts (secrev-1244 R2). */
  readonly raisedDocument?: string;
  readonly raisedOnChallenge: boolean;
  readonly raisedHost?: string;
  /** A terminal's prompt line digest and program at the raise. */
  readonly prompt?: string;
  readonly program?: string;
  /** The number the last push carried, and how many pushes were made. */
  pushedNumber?: string;
  pushes: number;
  /** The fact recorded once the sign-in moved on unsteered: the agent view's `secondFactor`. */
  pushed?: true;
  readonly waiters: Set<() => void>;
}

const FINAL: ReadonlySet<PhoneApprovalState> = new Set(['moved-on', 'timed-out', 'refused', 'gone']);
const instant = (ms: number): string => new Date(ms).toISOString();
const isFinal = (approval: PhoneApproval): boolean => FINAL.has(approval.state);

const digest = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** The note a card closes with, as Asks takes it: a reason. The owner's words ride on the card's own state. */
const SETTLED_REASON: Readonly<Record<Exclude<PhoneApprovalState, 'waiting'>, 'answered' | 'expired' | 'withdrawn'>> = {
  'moved-on': 'answered',
  'timed-out': 'expired',
  refused: 'withdrawn',
  gone: 'withdrawn',
};

/** What a terminal is doing, for whether it moved on: its prompt line and the program at it. */
function terminalLook(facts: TerminalFacts): { readonly prompt: string; readonly program: string } {
  return { prompt: facts.promptLineDigest, program: facts.program ?? facts.foreground.comm };
}

function requireOwner(caller: PhoneApprovalCaller): InputActor {
  if (caller.kind !== 'owner')
    throw new PhoneApprovalError('forbidden', 'only the owner sees and answers a phone approval');
  return caller.actor;
}

export class PhoneApprovalService {
  private readonly held = new Map<string, Held>();
  private readonly raises = new Map<string, number[]>();

  constructor(private readonly deps: PhoneApprovalDependencies) {}

  /** The ferret asks. Nothing in `raise` is shown: everything on the card was observed. */
  async raise(
    ferret: string,
    agentName: string | undefined,
    raise: PhoneApprovalRaise,
  ): Promise<PhoneApprovalAgentView> {
    const now = this.deps.clock.now();
    this.prune(now);
    this.guardCapacity(ferret, raise.target, now);
    const listing = await this.listing();
    const since = now;
    const expiresAt = instant(now + raise.waitSeconds * 1000);
    const id = this.deps.ids();
    const name = AgentNameSchema.safeParse(agentName);
    const base = {
      id,
      sessionId: ferret,
      agentName: name.success ? name.data : 'ferret',
      raisedAt: instant(now),
      expiresAt,
      state: 'waiting' as const,
    };
    let held: Omit<Held, 'askId'>;
    if (raise.target.kind === 'browser') {
      // The raise's `element` is never read (secrev-1244 H1): the ferret could point at text it typed itself.
      const look = await this.deps.pages.look(ferret, raise.target.key);
      if (look === undefined)
        throw new PhoneApprovalError('not_found', `there is no page named ${raise.target.key} in this session`);
      const host = httpsHost(look.read.origin);
      const matched = matchSignIn(host, listing, raise);
      const gated = gatedNumber(look.read, {
        domains: matched.domains,
        providerDomains: matched.providerDomains,
        scripted: this.scripted(ferret),
        now,
      });
      held = {
        approval: PhoneApprovalSchema.parse({
          ...base,
          surface: 'browser',
          ...(host === undefined ? {} : { origin: look.read.origin }),
          ...approvalFacts(matched),
          ...gated,
        }),
        key: raise.target.key,
        matched,
        since,
        names: [look.pageId],
        document: look.read.navigationId,
        raisedDocument: look.read.navigationId,
        raisedOnChallenge: look.read.provider !== undefined,
        ...(host === undefined ? {} : { raisedHost: host }),
        pushes: 0,
        waiters: new Set(),
      };
    } else {
      const seen = await this.deps.terminals.observe(ferret, raise.target.key);
      if (!seen.ok || seen.facts.kind !== 'terminal')
        throw new PhoneApprovalError('not_found', `there is no terminal named ${raise.target.key} in this session`);
      const matched = matchSignIn(terminalMatchKey(seen.facts, this.deps.hostName ?? ''), listing, raise);
      held = {
        // A terminal never shows a number: the ferret can print any text into its own pane.
        approval: PhoneApprovalSchema.parse({
          ...base,
          surface: 'terminal',
          ...approvalFacts(matched),
          numberMissing: 'terminal',
        }),
        key: raise.target.key,
        matched,
        since,
        names: seen.names ?? [],
        raisedOnChallenge: false,
        ...terminalLook(seen.facts),
        pushes: 0,
        waiters: new Set(),
      };
    }
    const words = phoneApprovalWords(held.approval);
    const card = await this.deps.asks.raise(ferret, {
      approvalId: id,
      title: words.title,
      subject: words.subject,
      // Agenda text is every ferret's to read: the place only, never the account (the card reads it on a person route).
      why: words.agendaWhy,
      context: [`Asked by ${held.approval.agentName}.`, words.warning].join('\n'),
      howToResolve:
        'Approve the sign-in on your phone if you expected it; Ferretry sees it go through. If you did not, tap Not me on the card and deny it on your phone.',
    });
    if (!card.ok) throw new PhoneApprovalError('unavailable', card.message);
    const kept: Held = { ...held, askId: card.id };
    this.held.set(id, kept);
    this.noteRaise(ferret, now);
    if (kept.approval.number !== undefined) kept.pushedNumber = kept.approval.number.value;
    // The watch starts first, and a log that cannot be written fails nothing: an approval always times out.
    void this.watch(kept);
    await this.deps.audit
      .record({ event: 'phone-approval.raised', actor: { kind: 'agent' }, approval: kept.approval })
      .catch(() => undefined);
    await this.buzz(kept, words.push);
    return this.view(kept);
  }

  /** What the ferret is told: where the approval stands, and a push once it moved on. Never the number. */
  async agentView(ferret: string, id: string, waitMs: number): Promise<PhoneApprovalAgentView> {
    const held = this.mine(ferret, id);
    if (waitMs > 0 && !isFinal(held.approval)) {
      await Promise.race([
        new Promise<void>(resolve => held.waiters.add(resolve)),
        this.deps.timers.after(Math.min(waitMs, WAIT_CEILING_MS)),
      ]);
    }
    return this.view(held);
  }

  /** The approval an owner's card is drawn from, by its ferret and id; a settled one is kept until the ferret ends. Owner only. */
  get(caller: PhoneApprovalCaller, ferret: string, id: string): PhoneApproval {
    requireOwner(caller);
    return this.mine(ferret, id).approval;
  }

  /** The ferrets it holds approvals for, so a sweep can end those of ferrets that ended. */
  ferrets(): readonly string[] {
    return [...new Set([...this.held.values()].map(held => held.approval.sessionId))];
  }

  /**
   * Whether this ferret has an approval still waiting on the owner's phone — what keeps the Warden from moving the
   * ferret and throwing the sign-in away. A yes or no, nothing about it: it needs no owner.
   */
  hasOpen(ferret: string): boolean {
    for (const { approval } of this.held.values()) if (approval.sessionId === ferret && !isFinal(approval)) return true;
    return false;
  }

  /** The approvals still waiting, for one ferret or all, oldest first. Owner only. */
  list(caller: PhoneApprovalCaller, ferret?: string): readonly PhoneApproval[] {
    requireOwner(caller);
    return [...this.held.values()]
      .map(held => held.approval)
      .filter(approval => !isFinal(approval) && (ferret === undefined || approval.sessionId === ferret))
      .sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
  }

  /**
   * "Not me — stop": the owner did not expect this sign-in. The ferret is told to stop, the card says to deny it on
   * the phone too, and the security log keeps who, where and which ferret. Owner only; a settled approval is left as
   * it ended, so a refused or expired approval is never approved afterwards.
   */
  async refuse(caller: PhoneApprovalCaller, ferret: string, id: string): Promise<PhoneApproval> {
    const actor = requireOwner(caller);
    const held = this.mine(ferret, id);
    if (isFinal(held.approval)) return held.approval;
    await this.settle(held, 'refused', actor);
    return held.approval;
  }

  /** A ferret ended: its approvals end with it. */
  async ferretEnded(ferret: string): Promise<void> {
    for (const held of [...this.held.values()])
      if (held.approval.sessionId === ferret && !isFinal(held.approval)) await this.settle(held, 'gone');
    for (const [id, held] of this.held) if (held.approval.sessionId === ferret) this.held.delete(id);
    this.raises.delete(ferret);
  }

  /** At start: no approval survives a restart, so any card still presenting one is closed. Total. */
  async restore(): Promise<void> {
    const open = await this.deps.asks.open().catch(() => []);
    for (const card of open) await this.deps.asks.close(card.ferret, card.id, 'source-gone').catch(() => undefined);
  }

  private mine(ferret: string, id: string): Held {
    const held = this.held.get(id);
    if (held === undefined || held.approval.sessionId !== ferret)
      throw new PhoneApprovalError('not_found', `no phone approval ${id} in this session`);
    return held;
  }

  private view(held: Held): PhoneApprovalAgentView {
    return {
      id: held.approval.id,
      state: held.approval.state,
      ...(held.approval.state === 'moved-on' && held.pushed === true ? { secondFactor: 'push' as const } : {}),
    };
  }

  private async listing() {
    if (this.deps.logins === undefined) return { accounts: [], signIns: [] };
    return await this.deps.logins.listing().catch(() => ({ accounts: [], signIns: [] }));
  }

  /** A page script this session: no page's number is believed (`tainted` with no act window). */
  private scripted(ferret: string): boolean {
    return this.deps.observer.tainted(ferret, 'browser', Number.POSITIVE_INFINITY);
  }

  /** Ended approvals are kept an hour for their cards, then forgotten. */
  private prune(now: number): void {
    for (const [id, held] of this.held)
      if (isFinal(held.approval) && Date.parse(held.approval.expiresAt) < now - HOUR_MS) this.held.delete(id);
  }

  private guardCapacity(ferret: string, target: PhoneApprovalRaise['target'], now: number): void {
    const waiting = [...this.held.values()].filter(
      held => held.approval.sessionId === ferret && !isFinal(held.approval),
    );
    if (waiting.some(held => held.approval.surface === target.kind && held.key === target.key))
      throw new PhoneApprovalError(
        'conflict',
        `a phone approval is already waiting on ${target.key}; wait for it with input_wait`,
      );
    if (waiting.length >= PHONE_APPROVAL_MAX_WAITING_PER_SESSION)
      throw new PhoneApprovalError('capacity', 'this session already has phone approvals waiting');
    const recent = (this.raises.get(ferret) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= PHONE_APPROVAL_MAX_RAISES_PER_HOUR)
      throw new PhoneApprovalError('capacity', 'too many phone approvals from this session in the last hour');
  }

  private noteRaise(ferret: string, now: number): void {
    this.raises.set(ferret, [...(this.raises.get(ferret) ?? []).filter(at => at > now - HOUR_MS), now]);
  }

  /**
   * The watch: every second until the approval ends. A page is read for its number again (a new number is pushed
   * again, under the same tag), its document change clears the number, and a document that is no longer the
   * challenge ends it as `moved-on`. A terminal ends `moved-on` when its prompt line or program changes. Total.
   */
  private async watch(held: Held): Promise<void> {
    try {
      while (!isFinal(held.approval)) {
        await this.deps.timers.after(PHONE_APPROVAL_POLL_MS);
        if (isFinal(held.approval)) return;
        if (this.deps.clock.now() >= Date.parse(held.approval.expiresAt)) {
          await this.settle(held, 'timed-out');
          return;
        }
        if (held.approval.surface === 'browser') await this.lookAtPage(held);
        else await this.lookAtTerminal(held);
      }
    } catch {
      // A look that cannot be made ends nothing by itself: the approval still times out.
      if (!isFinal(held.approval)) void this.watchAfterError(held);
    }
  }

  private async watchAfterError(held: Held): Promise<void> {
    await this.deps.timers.after(PHONE_APPROVAL_POLL_MS);
    await this.watch(held);
  }

  private async lookAtPage(held: Held): Promise<void> {
    const { sessionId } = held.approval;
    const look = await this.deps.pages.look(sessionId, held.key).catch(() => undefined);
    if (isFinal(held.approval)) return;
    // The page closed, or the name is another page now.
    if (look === undefined || !held.names.includes(look.pageId)) {
      await this.settle(held, 'gone');
      return;
    }
    const read = look.read;
    const host = httpsHost(read.origin);
    const moved = movedOn(held, {
      navigationId: read.navigationId,
      ...(host === undefined ? {} : { host }),
      ...(read.provider === undefined ? {} : { provider: read.provider }),
    });
    if (moved !== undefined) {
      // Only a page that left the identity providers says the sign-in finished; the same host may be a denial.
      await this.settle(held, 'moved-on', undefined, moved === 'left');
      return;
    }
    const now = this.deps.clock.now();
    const changed = held.document !== read.navigationId;
    held.document = read.navigationId;
    // Another document than the one the owner's sign-in was raised on, after the ferret acted on its pages: the ferret
    // may have restarted the challenge until its number matched an attacker's push (secrev-1244 R2). No number.
    const steered =
      read.navigationId !== held.raisedDocument && this.deps.observer.tainted(sessionId, 'browser', held.since);
    const gated: ReturnType<typeof gatedNumber> = steered
      ? { numberMissing: 'steered' }
      : gatedNumber(read, {
          domains: held.matched.domains,
          providerDomains: held.matched.providerDomains,
          scripted: this.scripted(sessionId),
          now,
          ...(held.raisedHost === undefined ? {} : { pinnedHost: held.raisedHost }),
        });
    // A number belongs to the document it was read in: a new document clears it, and only a number read in the new
    // one shows again. The same number in the same document keeps the instant it was first read.
    const kept = held.approval.number;
    const number =
      'number' in gated ? (!changed && kept?.value === gated.number.value ? kept : gated.number) : undefined;
    const { number: _number, numberMissing: _missing, origin: _origin, ...rest } = held.approval;
    held.approval = PhoneApprovalSchema.parse({
      ...rest,
      ...(host === undefined ? {} : { origin: read.origin }),
      ...('number' in gated && number !== undefined ? { number } : 'numberMissing' in gated ? gated : {}),
    });
    if (number !== undefined && number.value !== held.pushedNumber && held.pushes < PHONE_APPROVAL_MAX_PUSHES) {
      held.pushedNumber = number.value;
      await this.buzz(held, phoneApprovalWords(held.approval).push);
    }
  }

  private async lookAtTerminal(held: Held): Promise<void> {
    const seen = await this.deps.terminals.observe(held.approval.sessionId, held.key).catch(() => undefined);
    if (isFinal(held.approval)) return;
    if (seen === undefined) return;
    if (!seen.ok && seen.reason === 'unsupported') return;
    // The pane closed, or the name is another pane now.
    const another = held.names.length > 0 && !(seen.ok ? (seen.names ?? []) : []).some(n => held.names.includes(n));
    if (!seen.ok || seen.facts.kind !== 'terminal' || another) {
      await this.settle(held, 'gone');
      return;
    }
    const now = terminalLook(seen.facts);
    if (now.prompt !== held.prompt || now.program !== held.program) await this.settle(held, 'moved-on');
  }

  /** One push: the raise's, or a new number's. Counted, so a page that keeps changing its number stops buzzing. */
  private async buzz(held: Held, body: string): Promise<void> {
    const secondsLeft = Math.floor((Date.parse(held.approval.expiresAt) - this.deps.clock.now()) / 1000);
    const sequence = held.pushes;
    held.pushes += 1;
    await this.deps.push
      .push(held.approval.sessionId, held.askId, { id: held.approval.id, body, sequence, secondsLeft })
      .catch(() => undefined);
  }

  /**
   * Ends an approval: its state, its card closed, its push taken down, the ferret woken (and, refused, told to stop),
   * the log. `moved-on` keeps `secondFactor: 'push'` on the sign-in only when the move says the sign-in finished
   * (`finished`: a page that left the identity providers, or a terminal) and nothing the ferret did could have moved it.
   */
  private async settle(
    held: Held,
    state: Exclude<PhoneApprovalState, 'waiting'>,
    owner?: InputActor,
    finished = true,
  ): Promise<void> {
    if (isFinal(held.approval)) return;
    const { sessionId } = held.approval;
    const steered =
      state === 'moved-on' &&
      this.deps.observer.tainted(sessionId, held.approval.surface === 'browser' ? 'browser' : 'terminal', held.since);
    held.approval = PhoneApprovalSchema.parse({ ...held.approval, state });
    if (state === 'moved-on' && !steered && finished) {
      held.pushed = true;
      await this.keepFact(held);
    }
    await this.deps.asks.close(sessionId, held.askId, SETTLED_REASON[state]).catch(() => undefined);
    // The push lasts no longer than the card, under its own tag (I208).
    await this.deps.push.clear(sessionId, held.approval.id).catch(() => undefined);
    for (const wake of held.waiters) wake();
    held.waiters.clear();
    if (state === 'refused')
      await this.deps.notifier
        ?.tell(
          sessionId,
          'The owner did not expect this sign-in and said "Not me": stop signing in there, and do not ask again.',
        )
        .catch(() => undefined);
    await this.deps.audit
      .record({
        event: state === 'refused' ? 'phone-approval.refused' : 'phone-approval.settled',
        actor: owner ?? { kind: 'daemon' },
        approval: held.approval,
        ...(steered ? { steered: true } : {}),
      })
      .catch(() => undefined);
  }

  /**
   * `secondFactor: 'push'` on the sign-in, at the place it was seen: the page's host or the terminal's key. Kept under
   * the identity the sign-in already has there when it has one, so the facts a password delivery kept are counted up,
   * never replaced. Total.
   */
  private async keepFact(held: Held): Promise<void> {
    const signIn = held.matched.signIn;
    const facts = this.deps.facts;
    if (signIn === undefined || facts === undefined) return;
    const surface = held.approval.surface === 'browser' ? 'page' : 'terminal';
    const at = held.approval.surface === 'browser' ? held.raisedHost : held.key;
    if (at === undefined) return;
    const listing = await this.listing();
    const kept = listing.signIns.find(each => each.id === signIn)?.observed?.find(each => each.at === at);
    const identity = kept?.surface === surface ? kept.identity : digest(['phone-approval', surface, at]);
    const seen: LoginObservation = { at, surface, identity, secondFactor: 'push' };
    await facts.observeSignIn(signIn, seen).catch(() => undefined);
  }
}
