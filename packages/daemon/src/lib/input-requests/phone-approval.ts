import { createHash } from 'node:crypto';
import {
  type AccountRef,
  type AgendaId,
  AgentNameSchema,
  chosenSignIn,
  type InputActor,
  type InputTargetFacts,
  type LoginObservation,
  PHONE_APPROVAL_DIRECTION,
  type PhoneApproval,
  type PhoneApprovalAgentView,
  type PhoneApprovalNumber,
  type PhoneApprovalNumberMissing,
  PhoneApprovalNumberSchema,
  PhoneApprovalOriginSchema,
  type PhoneApprovalRaise,
  PhoneApprovalSchema,
  type PhoneApprovalState,
  phoneApprovalWords,
  type SignInId,
  type SignInSummary,
} from '@ferretry/protocol';
import type { BrowserPushNumberRead } from '../browser/transport/input-contracts.ts';
import { identityProviderOf, numberSourceFits } from '../browser/transport/push-number.ts';
import { InputRequestError } from './errors.ts';
import type { LoginFactSink } from './login-observer.ts';
import type {
  InputAgentNotifier,
  InputCaller,
  InputClock,
  InputLoginPort,
  InputTimers,
  ObserveResult,
} from './ports.ts';
import { type SavedListing, targetMatchKey } from './saved-logins.ts';

/**
 * APPROVE ON YOUR PHONE (docs/input-requests.md, "Approve on your phone"): a sign-in waits for a push the owner
 * approves on their phone. Nothing is typed, so this is not an input request: it is a card of the daemon's own, built
 * only from what the daemon observed, and settled only by what the daemon sees next.
 *
 * - THE NUMBER COMES ONLY FROM THE PAGE, read by the browser (push-number.ts), and only past three gates: the page is
 *   https on a login domain of the sign-in it matched (or one its provider chain reaches) or on a fixed identity
 *   provider's host; no ferret ran a page script in this session; and the element is visible and not one anyone can
 *   type into, in a document that did not change while it was read. A terminal never shows one: a ferret can print
 *   anything into its own pane.
 * - NOTHING OF THE FERRET'S IS SHOWN. Its raise names where and gives hints; the card, the agenda subject, the push
 *   and the log are {@link phoneApprovalWords} over the approval's own fields.
 * - SUCCESS IS OBSERVED, NEVER CLAIMED. `moved-on` is set only here, when the page shows a new document that is no
 *   longer the challenge (or the terminal's prompt or program changed). No route sets it, and the owner's only
 *   button is "Not me — stop". A move the ferret could have caused (it acted on that kind of surface since the raise,
 *   or ran a page script) still ends the card, but keeps no fact and tells the ferret no `secondFactor`.
 *
 * The approval lives in RAM: a restart ends it (its card is closed by {@link PhoneApprovalService.restore}).
 */

/** How often a waiting approval looks at its page or terminal: the login observer's poll. */
export const PHONE_APPROVAL_POLL_MS = 1_000;
/** The most approvals one session may have waiting at once, and how many it may ask for in an hour. */
export const PHONE_APPROVAL_MAX_WAITING_PER_SESSION = 2;
export const PHONE_APPROVAL_MAX_RAISES_PER_HOUR = 10;
/** The most pushes one approval makes: the raise and a few new numbers. A page that keeps changing its number stops buzzing. */
export const PHONE_APPROVAL_MAX_PUSHES = 4;
const HOUR_MS = 3_600_000;
const WAIT_CEILING_MS = 600_000;
/** How far a `via` chain is followed: ClickUp via Okta via Google is two hops. */
const VIA_DEPTH = 3;

/** The page as an approval needs it: one look for the number, in the page's own queue. */
export interface PhoneApprovalPagePort {
  /**
   * The session's page `key` now: its id and what the browser read there (`element` is the ferret's pointer, a WHERE TO
   * LOOK only). Nothing when there is no such page, or the browser cannot read a number at all.
   */
  look(
    sessionId: string,
    key: string,
    element?: PhoneApprovalRaise['element'],
  ): Promise<{ readonly pageId: string; readonly read: BrowserPushNumberRead } | undefined>;
}

/** The terminal as an approval needs it: what the input bridge observes there (its prompt line and program). */
export interface PhoneApprovalTerminalPort {
  observe(sessionId: string, target: { readonly kind: 'terminal'; readonly key: string }): Promise<ObserveResult>;
}

/** The card on the owner's agenda: an `info` item carrying the approval's ref, worded by the daemon. */
export interface PhoneApprovalCard {
  readonly approvalId: string;
  readonly title: string;
  readonly subject: string;
  readonly why: string;
  readonly context: string;
  readonly howToResolve: string;
}

export interface PhoneApprovalAgendaPort {
  raise(
    sessionId: string,
    card: PhoneApprovalCard,
  ): Promise<{ ok: true; id: AgendaId } | { ok: false; message: string }>;
  /** Resolve the card as the daemon's own act; never throws for a card that is already gone. */
  close(sessionId: string, id: AgendaId, note: string): Promise<void>;
  /** The open cards of a session that present an approval: a restart closes them, since no approval outlives one. */
  open(sessionId: string): Promise<readonly AgendaId[]>;
}

/** The phone's buzz for a card: one at the raise and one per new number (`NotificationService.phoneApproval`). Total. */
export interface PhoneApprovalPushPort {
  push(
    sessionId: string,
    agendaId: AgendaId,
    approval: { readonly id: string; readonly body: string; readonly sequence: number; readonly secondsLeft: number },
  ): Promise<void>;
}

export type PhoneApprovalAuditEvent = 'phone-approval.raised' | 'phone-approval.refused' | 'phone-approval.settled';

/** The security log: the approval's own fields (never its number), and who acted. */
export interface PhoneApprovalAudit {
  record(entry: {
    readonly event: PhoneApprovalAuditEvent;
    readonly actor: InputActor | { readonly kind: 'agent' } | { readonly kind: 'daemon' };
    readonly approval: PhoneApproval;
    /** The sign-in moved on, but the ferret acted on that kind of surface meanwhile: no fact was kept. */
    readonly steered?: boolean;
  }): Promise<void>;
}

export interface PhoneApprovalDependencies {
  readonly pages: PhoneApprovalPagePort;
  readonly terminals: PhoneApprovalTerminalPort;
  readonly agenda: PhoneApprovalAgendaPort;
  readonly push: PhoneApprovalPushPort;
  readonly notifier: InputAgentNotifier;
  readonly audit: PhoneApprovalAudit;
  readonly clock: InputClock;
  readonly timers: InputTimers;
  /** A fresh approval id: `pa_` and 24 hex digits. */
  readonly ids: () => string;
  /** Whether the ferret could have steered a surface of this kind since `since` (`LoginObserver.tainted`). */
  readonly observer: { tainted(sessionId: string, kind: 'browser' | 'terminal', since: number): boolean };
  /** Saved accounts, by their non-secret listing: which sign-in this is. Absent: every approval is an unknown sign-in. */
  readonly logins?: Pick<InputLoginPort, 'listing'>;
  /** Where a sign-in's `secondFactor: 'push'` goes. Absent: none is kept. */
  readonly facts?: LoginFactSink;
  /** This machine's host name, for a terminal's `program@host` key. */
  readonly hostName?: string;
  /**
   * Whether this daemon offers approvals (`DAEMON_FEATURES.phoneApproval`): until the app that draws the card ships,
   * a raise is refused rather than shown to an app that would draw it as a plain note.
   */
  readonly enabled: () => boolean;
}

/** What the daemon matched a target to: the sign-in, its account and the provider it goes via, and its hosts. */
interface Matched {
  readonly signIn?: SignInId;
  readonly account?: AccountRef;
  readonly username?: string;
  readonly via?: AccountRef;
  readonly factor?: PhoneApproval['factor'];
  /** The login domains of the sign-in and of every sign-in its `via` chain reaches: where a number may be read. */
  readonly domains: ReadonlySet<string>;
}

interface Held {
  approval: PhoneApproval;
  readonly agendaId: AgendaId;
  readonly key: string;
  readonly element?: PhoneApprovalRaise['element'];
  readonly matched: Matched;
  /** The raise instant, as the observer's clock reads it: an act of the ferret at or after it voids the fact. */
  readonly since: number;
  /** A page: the page it was raised on, by id. A terminal: the ids the pane had (none known: not pinned). */
  readonly names: readonly string[];
  /** The page's document now, and whether the document the approval was raised on was a provider's challenge. */
  document?: string;
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

/** An origin's host when it is one a number may be read on at all: https, no port, no credentials. */
function httpsHost(origin: string): string | undefined {
  if (!PhoneApprovalOriginSchema.safeParse(origin).success) return undefined;
  try {
    const url = new URL(origin);
    return url.port === '' && url.username === '' && url.password === '' ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE THREE GATES, on the browser's own answer (docs/input-requests.md, "Approve on your phone"). A number is believed
 * only when: the page is https on a host the matched sign-in (or its provider chain) signs in at, or a fixed identity
 * provider's; no ferret scripted a page this session; the browser found it in the main frame or one of the page's own
 * origin, on a host that source can be on, in a document that did not change while it was read; and it has the shape
 * its source shows (1 to 3 digits to tap, 3 to 6 to type). Anything else is a reason, never a number.
 */
export function gatedNumber(
  read: BrowserPushNumberRead,
  context: { readonly domains: ReadonlySet<string>; readonly scripted: boolean; readonly now: number },
): { readonly number: PhoneApprovalNumber } | { readonly numberMissing: PhoneApprovalNumberMissing } {
  const host = httpsHost(read.origin);
  if (host === undefined || (!context.domains.has(host) && identityProviderOf(host) === undefined))
    return { numberMissing: 'origin' };
  if (context.scripted) return { numberMissing: 'scripted' };
  if (read.missing === 'changed') return { numberMissing: 'changed' };
  const found = read.number;
  if (found === undefined) return { numberMissing: read.missing === 'editable' ? 'editable' : 'none-found' };
  if (found.frameOrigin !== read.origin || !numberSourceFits(found.from, host)) return { numberMissing: 'origin' };
  const parsed = PhoneApprovalNumberSchema.safeParse({
    value: found.value,
    from: found.from,
    direction: PHONE_APPROVAL_DIRECTION[found.from],
    readAt: instant(context.now),
  });
  return parsed.success ? { number: parsed.data } : { numberMissing: 'none-found' };
}

/** Whether a page the approval was raised on has moved on: a new document that is no longer the challenge. */
export function movedOn(
  held: { readonly document?: string; readonly raisedOnChallenge: boolean; readonly raisedHost?: string },
  now: { readonly navigationId: string; readonly host?: string; readonly provider?: string },
): boolean {
  if (held.document === undefined || now.navigationId === held.document) return false;
  // Another host that is no identity provider's: the sign-in left its challenge.
  if (now.host !== undefined && now.host !== held.raisedHost && identityProviderOf(now.host) === undefined) return true;
  // The same host, a new document: moved on only when the raise was a provider's challenge and this one is none
  // (Microsoft's "Stay signed in?" after the number); anything else may be the same challenge again.
  return held.raisedOnChallenge && now.provider === undefined;
}

const digest = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

export class PhoneApprovalService {
  private readonly held = new Map<string, Held>();
  private readonly raises = new Map<string, number[]>();

  constructor(private readonly deps: PhoneApprovalDependencies) {}

  /** The ferret asks. Nothing in `raise` is shown: everything on the card was observed. */
  async raise(
    sessionId: string,
    agentName: string | undefined,
    raise: PhoneApprovalRaise,
  ): Promise<PhoneApprovalAgentView> {
    if (!this.deps.enabled())
      throw new InputRequestError(
        'unavailable',
        'approving a sign-in on the phone needs the Ferretry app that shows its card: update the app first',
      );
    const now = this.deps.clock.now();
    this.prune(now);
    this.guardCapacity(sessionId, raise.target, now);
    const listing = await this.listing();
    const since = now;
    const expiresAt = instant(now + raise.waitSeconds * 1000);
    const id = this.deps.ids();
    const name = AgentNameSchema.safeParse(agentName);
    const base = {
      id,
      sessionId,
      agentName: name.success ? name.data : 'ferret',
      raisedAt: instant(now),
      expiresAt,
      state: 'waiting' as const,
    };
    let held: Omit<Held, 'agendaId'>;
    if (raise.target.kind === 'browser') {
      const look = await this.deps.pages.look(sessionId, raise.target.key, raise.element);
      if (look === undefined)
        throw new InputRequestError('not_found', `there is no page named ${raise.target.key} in this session`);
      const host = httpsHost(look.read.origin);
      const matched = this.match(host, listing, raise);
      const gated = gatedNumber(look.read, { domains: matched.domains, scripted: this.scripted(sessionId), now });
      held = {
        approval: PhoneApprovalSchema.parse({
          ...base,
          surface: 'browser',
          ...(host === undefined ? {} : { origin: look.read.origin }),
          ...approvalFacts(matched),
          ...gated,
        }),
        key: raise.target.key,
        ...(raise.element === undefined ? {} : { element: raise.element }),
        matched,
        since,
        names: [look.pageId],
        document: look.read.navigationId,
        raisedOnChallenge: look.read.provider !== undefined,
        ...(host === undefined ? {} : { raisedHost: host }),
        pushes: 0,
        waiters: new Set(),
      };
    } else {
      const seen = await this.deps.terminals.observe(sessionId, { kind: 'terminal', key: raise.target.key });
      if (!seen.ok || seen.facts.kind !== 'terminal')
        throw new InputRequestError('not_found', `there is no terminal named ${raise.target.key} in this session`);
      const matched = this.match(targetMatchKey(seen.facts, this.deps.hostName ?? ''), listing, raise);
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
    const card = await this.deps.agenda.raise(sessionId, {
      approvalId: id,
      title: words.title,
      subject: words.subject,
      why: `${words.who}: ${words.where}.`,
      context: [`Asked by ${held.approval.agentName}.`, words.warning].join('\n'),
      howToResolve:
        'Approve the sign-in on your phone if you expected it; Ferretry sees it go through. If you did not, tap Not me on the card and deny it on your phone.',
    });
    if (!card.ok) throw new InputRequestError('unavailable', card.message);
    const kept: Held = { ...held, agendaId: card.id };
    this.held.set(id, kept);
    this.noteRaise(sessionId, now);
    if (kept.approval.number !== undefined) kept.pushedNumber = kept.approval.number.value;
    await this.deps.audit.record({ event: 'phone-approval.raised', actor: { kind: 'agent' }, approval: kept.approval });
    await this.buzz(kept, words.push);
    void this.watch(kept);
    return this.view(kept);
  }

  /** What the ferret is told: where the approval stands, and a push once it moved on. Never the number. */
  async agentView(sessionId: string, id: string, waitMs: number): Promise<PhoneApprovalAgentView> {
    const held = this.mine(sessionId, id);
    if (waitMs > 0 && !isFinal(held.approval)) {
      await Promise.race([
        new Promise<void>(resolve => held.waiters.add(resolve)),
        this.deps.timers.after(Math.min(waitMs, WAIT_CEILING_MS)),
      ]);
    }
    return this.view(held);
  }

  /** The approval an owner's card is drawn from, by its session and id; a settled one is kept until the session ends. Owner only. */
  get(caller: InputCaller, sessionId: string, id: string): PhoneApproval {
    requireOwner(caller);
    const held = this.held.get(id);
    if (held === undefined || held.approval.sessionId !== sessionId)
      throw new InputRequestError('not_found', `no phone approval ${id} in this session`);
    return held.approval;
  }

  /** The sessions it holds approvals for, so a sweep can end those of sessions that ended. */
  sessions(): readonly string[] {
    return [...new Set([...this.held.values()].map(held => held.approval.sessionId))];
  }

  /** The approvals still waiting, for one session or all, oldest first. Owner only. */
  list(caller: InputCaller, sessionId?: string): readonly PhoneApproval[] {
    requireOwner(caller);
    return [...this.held.values()]
      .map(held => held.approval)
      .filter(approval => !isFinal(approval) && (sessionId === undefined || approval.sessionId === sessionId))
      .sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
  }

  /**
   * "Not me — stop": the owner did not expect this sign-in. The ferret is told to stop, the card says to deny it on
   * the phone too, and the security log keeps who, where and which ferret. Owner only; a settled approval is left as
   * it ended.
   */
  async refuse(caller: InputCaller, sessionId: string, id: string): Promise<PhoneApproval> {
    const actor = requireOwner(caller);
    const held = this.held.get(id);
    if (held === undefined || held.approval.sessionId !== sessionId)
      throw new InputRequestError('not_found', `no phone approval ${id} in this session`);
    if (isFinal(held.approval)) return held.approval;
    await this.settle(held, 'refused', actor);
    return held.approval;
  }

  /** A session ended: its approvals end with it. */
  async sessionEnded(sessionId: string): Promise<void> {
    for (const held of [...this.held.values()])
      if (held.approval.sessionId === sessionId && !isFinal(held.approval)) await this.settle(held, 'gone');
    for (const [id, held] of this.held) if (held.approval.sessionId === sessionId) this.held.delete(id);
    this.raises.delete(sessionId);
  }

  /** At start: no approval survives a restart, so any card still presenting one is closed. Total. */
  async restore(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const open = await this.deps.agenda.open(sessionId).catch(() => []);
      for (const id of open)
        await this.deps.agenda
          .close(sessionId, id, 'Ferretry restarted, so it stopped watching this sign-in; the ferret can ask again.')
          .catch(() => undefined);
    }
  }

  private mine(sessionId: string, id: string): Held {
    const held = this.held.get(id);
    if (held === undefined || held.approval.sessionId !== sessionId)
      throw new InputRequestError('not_found', `no phone approval ${id} in this session`);
    return held;
  }

  private view(held: Held): PhoneApprovalAgentView {
    return {
      id: held.approval.id,
      state: held.approval.state,
      ...(held.approval.state === 'moved-on' && held.pushed === true ? { secondFactor: 'push' as const } : {}),
    };
  }

  private async listing(): Promise<SavedListing> {
    if (this.deps.logins === undefined) return { accounts: [], signIns: [] };
    return await this.deps.logins.listing().catch(() => ({ accounts: [], signIns: [] }));
  }

  /** A page script this session: no page's number is believed (`LoginObserver.tainted` with no act window). */
  private scripted(sessionId: string): boolean {
    return this.deps.observer.tainted(sessionId, 'browser', Number.POSITIVE_INFINITY);
  }

  /** Ended approvals are kept an hour for their cards, then forgotten. */
  private prune(now: number): void {
    for (const [id, held] of this.held)
      if (isFinal(held.approval) && Date.parse(held.approval.expiresAt) < now - HOUR_MS) this.held.delete(id);
  }

  private guardCapacity(sessionId: string, target: PhoneApprovalRaise['target'], now: number): void {
    const waiting = [...this.held.values()].filter(
      held => held.approval.sessionId === sessionId && !isFinal(held.approval),
    );
    if (waiting.some(held => held.approval.surface === target.kind && held.key === target.key))
      throw new InputRequestError(
        'conflict',
        `a phone approval is already waiting on ${target.key}; wait for it with input.wait`,
      );
    if (waiting.length >= PHONE_APPROVAL_MAX_WAITING_PER_SESSION)
      throw new InputRequestError('capacity', 'this session already has phone approvals waiting');
    const recent = (this.raises.get(sessionId) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= PHONE_APPROVAL_MAX_RAISES_PER_HOUR)
      throw new InputRequestError('capacity', 'too many phone approvals from this session in the last hour');
  }

  private noteRaise(sessionId: string, now: number): void {
    this.raises.set(sessionId, [...(this.raises.get(sessionId) ?? []).filter(at => at > now - HOUR_MS), now]);
  }

  /**
   * WHICH SIGN-IN THIS IS, from the target key the daemon observed. A sign-in that signs in at this key, the ferret's
   * hint ordering only among those; else, when the hint names a sign-in whose provider chain signs in here (ClickUp
   * via Okta, on the Okta page), that one, named "via" its provider. A hint that reaches nothing here is ignored.
   */
  private match(key: string | undefined, listing: SavedListing, raise: PhoneApprovalRaise): Matched {
    const none: Matched = { domains: new Set() };
    if (key === undefined) return none;
    const hint = raise.secretHint;
    const viaHere = hint === undefined ? undefined : this.viaChainTo(key, hint, listing);
    const direct = chosenSignIn(key, listing.signIns, hint === undefined ? {} : { hint });
    const signIn =
      viaHere?.signIn ?? listing.signIns.find(candidate => direct !== undefined && candidate.id === direct.signIn);
    if (signIn === undefined) return none;
    const account = listing.accounts.find(each => each.id === signIn.account);
    if (account === undefined) return none;
    const chain = viaHere?.chain ?? [signIn];
    const domains = new Set(chain.flatMap(each => (each.place.kind === 'site' ? each.place.domains : [])));
    if (signIn.place.kind === 'terminal') domains.clear();
    const pushes = account.factors.filter(factor => factor.kind === 'push');
    const factor =
      pushes.find(each => raise.factor !== undefined && each.id === raise.factor) ??
      (pushes.length === 1 ? pushes[0] : undefined);
    return {
      signIn: signIn.id,
      account: { id: account.id, label: account.label },
      ...(account.username === undefined ? {} : { username: account.username }),
      ...(viaHere?.provider === undefined ? {} : { via: viaHere.provider }),
      ...(factor === undefined
        ? {}
        : {
            factor: {
              id: factor.id,
              label: factor.label,
              ...(factor.kind === 'push' && factor.app !== undefined ? { app: factor.app } : {}),
            },
          }),
      domains,
    };
  }

  /**
   * The hinted sign-in, when its `via` chain reaches a sign-in at `key` and it does not sign in at `key` itself: the
   * sign-in, the chain walked (it and every provider sign-in), and the provider account the card names.
   */
  private viaChainTo(
    key: string,
    hint: NonNullable<PhoneApprovalRaise['secretHint']>,
    listing: SavedListing,
  ):
    | { readonly signIn: SignInSummary; readonly chain: readonly SignInSummary[]; readonly provider: AccountRef }
    | undefined {
    const hinted = listing.signIns.filter(candidate =>
      hint.startsWith('si_') ? candidate.id === hint : candidate.account === hint,
    );
    if (hinted.length !== 1) return undefined;
    const start = hinted[0] as SignInSummary;
    if (start.place.kind === 'site' && start.place.domains.includes(key)) return undefined;
    let frontier: readonly SignInSummary[] = [start];
    const chain: SignInSummary[] = [start];
    for (let depth = 0; depth < VIA_DEPTH; depth += 1) {
      const next = frontier.flatMap(each => {
        const via = each.via;
        if (via === undefined) return [];
        return listing.signIns.filter(candidate =>
          via.signIn === undefined ? candidate.account === via.account.id : candidate.id === via.signIn,
        );
      });
      if (next.length === 0) return undefined;
      chain.push(...next);
      const here = next.find(each => each.place.kind === 'site' && each.place.domains.includes(key));
      if (here !== undefined) {
        const provider = listing.accounts.find(each => each.id === here.account);
        return provider === undefined
          ? undefined
          : { signIn: start, chain, provider: { id: provider.id, label: provider.label } };
      }
      frontier = next;
    }
    return undefined;
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
    const look = await this.deps.pages.look(sessionId, held.key, held.element).catch(() => undefined);
    if (isFinal(held.approval)) return;
    // The page closed, or the name is another page now.
    if (look === undefined || !held.names.includes(look.pageId)) {
      await this.settle(held, 'gone');
      return;
    }
    const read = look.read;
    const host = httpsHost(read.origin);
    if (
      movedOn(held, {
        navigationId: read.navigationId,
        ...(host === undefined ? {} : { host }),
        ...(read.provider === undefined ? {} : { provider: read.provider }),
      })
    ) {
      await this.settle(held, 'moved-on');
      return;
    }
    const now = this.deps.clock.now();
    const changed = held.document !== read.navigationId;
    held.document = read.navigationId;
    const gated = gatedNumber(read, { domains: held.matched.domains, scripted: this.scripted(sessionId), now });
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
    const seen = await this.deps.terminals
      .observe(held.approval.sessionId, { kind: 'terminal', key: held.key })
      .catch(() => undefined);
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
      .push(held.approval.sessionId, held.agendaId, { id: held.approval.id, body, sequence, secondsLeft })
      .catch(() => undefined);
  }

  /**
   * Ends an approval: its state, its card closed with a note in the owner's words, the ferret woken (and, refused,
   * told to stop), the log. `moved-on` keeps `secondFactor: 'push'` on the sign-in only when nothing the ferret did
   * could have moved it.
   */
  private async settle(held: Held, state: Exclude<PhoneApprovalState, 'waiting'>, owner?: InputActor): Promise<void> {
    if (isFinal(held.approval)) return;
    const { sessionId } = held.approval;
    const steered =
      state === 'moved-on' &&
      this.deps.observer.tainted(sessionId, held.approval.surface === 'browser' ? 'browser' : 'terminal', held.since);
    held.approval = PhoneApprovalSchema.parse({ ...held.approval, state });
    if (state === 'moved-on' && !steered) {
      held.pushed = true;
      await this.keepFact(held);
    }
    await this.deps.agenda.close(sessionId, held.agendaId, SETTLED_NOTES[state]).catch(() => undefined);
    for (const wake of held.waiters) wake();
    held.waiters.clear();
    if (state === 'refused')
      await this.deps.notifier.tell(
        sessionId,
        held.agendaId,
        'The owner did not expect this sign-in and said "Not me": stop signing in there, and do not ask again.',
      );
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

/** The note a card closes with, in the owner's words. */
const SETTLED_NOTES: Readonly<Record<Exclude<PhoneApprovalState, 'waiting'>, string>> = {
  'moved-on': 'The sign-in went through.',
  'timed-out': 'Nothing happened in time: the ferret can ask again.',
  refused: 'You said this was not you. Deny it on your phone too.',
  gone: 'The page or terminal closed.',
};

/** The card's facts from a match: only what the daemon knows. */
function approvalFacts(matched: Matched): Partial<PhoneApproval> {
  return {
    ...(matched.signIn === undefined ? {} : { signIn: matched.signIn }),
    ...(matched.account === undefined ? {} : { account: matched.account }),
    ...(matched.username === undefined ? {} : { username: matched.username }),
    ...(matched.via === undefined ? {} : { via: matched.via }),
    ...(matched.factor === undefined ? {} : { factor: matched.factor }),
  };
}

/** What a terminal is doing, for whether it moved on: its prompt line and the program at it. */
function terminalLook(facts: Extract<InputTargetFacts, { kind: 'terminal' }>): {
  readonly prompt: string;
  readonly program: string;
} {
  return { prompt: facts.promptLineDigest, program: facts.program ?? facts.foreground.comm };
}

function requireOwner(caller: InputCaller): InputActor {
  if (caller.kind !== 'owner')
    throw new InputRequestError('forbidden', 'only the owner sees and answers a phone approval');
  return caller.actor;
}
