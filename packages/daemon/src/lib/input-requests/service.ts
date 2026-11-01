import {
  type AccountId,
  type AccountKey,
  type AgendaId,
  type CopyMeta,
  copyHandle,
  factorAskWords,
  fillRoleFor,
  type GrantMissReason,
  INPUT_DEFAULT_EXPIRY_SECONDS,
  INPUT_ERROR_CODES,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_MAX_CHECK_FAILURES,
  INPUT_MAX_PENDING_PER_SESSION,
  INPUT_MAX_RAISES_PER_HOUR,
  INPUT_MAX_REBINDS,
  INPUT_PROMPT_MAX_LENGTH,
  INPUT_QUARANTINE_EVENT_TYPES,
  INPUT_QUARANTINE_SECONDS,
  INPUT_SINGLE_FIELD_ID,
  type InputActor,
  type InputAgentView,
  type InputAuditDetail,
  type InputAuditEvent,
  type InputDeliverBody,
  type InputDeliverResult,
  type InputEvent,
  type InputFieldRaise,
  type InputQuarantine,
  type InputQuarantineEvent,
  type InputRaise,
  type InputReason,
  type InputRequest,
  type InputRequestField,
  type InputRisk,
  type InputSensitivity,
  type InputShot,
  type InputTarget,
  type InputTargetFacts,
  inputRaiseFields,
  inputValueProblem,
  LOGIN_PASSWORD_MIN_LENGTH,
  LOGIN_USERNAME_MAX_LENGTH,
  type LoginEntryId,
  type LoginObserved,
  MAX_AGENDA_TITLE_LENGTH,
  observerByOf,
  type PushSubject,
  placeKeys,
  type SignInChoiceContext,
  type SignInId,
  savedRolesOf,
  strongestSensitivity,
  TASK_PLAN_MISS_AGENT_NOTE,
  type TwoFactorId,
  unpadInputValue,
  worstRisk,
} from '@ferretry/protocol';
import { LoginEntryError, type LoginFieldValues } from '../secrets/accounts.ts';
import { type ClearJob, type ClearOutcome, clearJobOf } from '../sign-in-grants/clear.ts';
import type { GrantReservation } from '../sign-in-grants/ledger.ts';
import { type GrantMatch, type GrantSighting, matchSignInGrant, type SignInGrant } from '../sign-in-grants/matcher.ts';
import type { SignInGrantSource } from '../sign-in-grants/plans.ts';
import { GRANT_MISS_CONTEXT_LINE, grantStops } from '../sign-in-grants/reasons.ts';
import { digestFacts } from './digest.ts';
import type { EphemeralValues } from './ephemeral-values.ts';
import { InputRequestError } from './errors.ts';
import {
  heldFromView,
  lockFor,
  longerLock,
  lookAlike,
  matchable,
  passwordTarget,
  probeable,
  spellsPassword,
} from './lock.ts';
import type { LoginDelivery, LoginObserver } from './login-observer.ts';
import type {
  InputAgendaPort,
  InputAgentNotifier,
  InputAudit,
  InputCaller,
  InputChoicePort,
  InputClock,
  InputFieldValue,
  InputIds,
  InputJournal,
  InputLoginPort,
  InputPasteRules,
  InputSealedPort,
  InputSessionDirectory,
  InputTargetField,
  InputTargetPort,
  InputTimers,
  ObserveResult,
  ProfileProgram,
  TypeResult,
} from './ports.ts';
import type { QuarantineHold, QuarantineRegistry } from './quarantine.ts';
import { bindingOf, mayRebind } from './rebind.ts';
import {
  codeCardKeys,
  codeTargetProblem,
  type SavedListing,
  savedForFields,
  signInOfAt,
  signInsAt,
  targetMatchKey,
} from './saved-logins.ts';
import { SessionLock } from './session-lock.ts';

/**
 * THE INPUT REQUEST SERVICE (docs/input-requests.md): an agent stuck at a password prompt raises a request;
 * the owner, and only the owner, types the value; the daemon checks the target is still what the card
 * showed and types it once.
 *
 * ## THE VALUE'S WHOLE LIFE IS ONE CALL
 *
 * `deliver` unpads the value, checks it, holds it in {@link EphemeralValues} (so a read racing the write
 * is already masked), hands it to {@link InputTargetPort.type} and lets go. It is never stored in a
 * request, a delivery record, a journal event, an audit entry, a log line or an error message: every
 * port besides `type` is told ids, states, names and flags.
 *
 * ## THE WRITE IS RECORDED BEFORE IT HAPPENS
 *
 * The journal gets a `delivering` event (the delivery id, no value) before `type` is called, and if that
 * cannot be recorded nothing is typed. A restart that finds `delivering` as a request's last word cannot
 * know whether the value landed, so it ends the request as interrupted and never types again. A write that
 * did not complete cleanly (`uncertain`) ends the request the same way instead of reopening it.
 *
 * ## ONE TURN AT A TIME PER SESSION
 *
 * Raising (observe, capacity, surface), an agent's keystrokes and closes (through {@link exclusive}) and the
 * secure write each run under the session's {@link SessionLock}, so admission cannot overbook a pane or the
 * capacity, and an agent's send cannot slip in between the last check and the write.
 *
 * ## THE REQUEST LIVES IN RAM
 *
 * The journal holds ids and states, so a restart brings a pending request back and re-observes its target
 * before Send is allowed again. What was observed is never persisted, and what is shown to the owner of it
 * (the prompt line, the program's argv) passes the redactor first.
 */

const HOUR_MS = 3_600_000;
const WAIT_CEILING_MS = 600_000;
const FACT_TEXT_LIMIT = 200;
const COMM_TEXT_LIMIT = 64;
const HIDDEN_PROMPT = '[hidden: part of a value typed here is on this line]';
const QUARANTINE_NOTICE = '[hidden: a secret was just typed in this terminal]';
const QUARANTINE_MS = INPUT_QUARANTINE_SECONDS * 1000;

const FINAL = new Set<InputRequest['state']>(['delivered', 'refused', 'expired', 'cancelled']);

const TITLES = {
  secret: 'Needs a secret',
  private: 'Needs a private value',
  code: 'Needs a code',
  plain: 'Needs an answer',
} as const;
const LOGIN_TITLE = 'Needs a login';
/** What a field is called on the card when the agent gave it no label. */
const FIELD_LABELS: Readonly<Record<InputSensitivity, string>> = {
  secret: 'Password',
  private: 'Private value',
  code: 'Code',
  plain: 'Value',
};
/** The longest a chain is counted: a login is a few steps, not a loop. */
const MAX_STEP = 16;

interface Held {
  request: InputRequest;
  /**
   * What the FERRET reads while a grant fills its card on its own (secrev-1282b F1): the request as it stood when the
   * attempt began. A fill passes through states a card no grant was about never shows (`delivering`, a longer lock)
   * and may still be refused at its last check, so until the request really ends the ferret reads the card as it was.
   */
  agentSees?: InputRequest;
  /**
   * The lock the ferret reads after a grant fill that did not happen (delta F4): the one the card was raised with, though
   * the request keeps the longer lock the attempt worked out (a card never shortens). Gone at the next write or the end.
   */
  agentLock?: { readonly lock: InputRequest['lock'] };
  /** Every name the terminal was seen under (its key and its id), so a quarantine on any of them seals it. */
  names: readonly string[];
  checkFailures: number;
  /** Times the target changed under the card and was found again, so the card was redrawn instead of failing. */
  rebinds: number;
  /** Which target the card is for (`rebind.ts`): a sighting with this binding may redraw the card. Absent: none may. */
  binding?: string;
  /** The document a page's card was raised on: a card redrawn onto another one says so. */
  raisedOn?: string;
  /** The card's title as raised, so a card opened again for a code that did not go through reads the same. */
  readonly title?: string;
  /**
   * The cards this request was shown on before its current one: a code Ferretry made that did not go through opens the
   * request again on a new card ({@link InputRequestService.reopen}), and the ferret may still wait on the old id.
   */
  readonly formerCards: AgendaId[];
  /** The target's key for saved logins (`sudo@kirin-box`), from what the DAEMON saw; never from the agent. */
  matchKey?: string;
  /**
   * The account (or `si_…`) the ferret said it expects. It can only order the sign-ins the daemon matched here
   * (`chosenSignIn`): one it names is the primary, "Ferret chose this"; one matched nowhere here is only tagged.
   */
  readonly hint?: string;
  /** Every `deliveryId` seen and what came of it, so a retry gets the first outcome and never types twice. */
  readonly deliveries: Map<string, Promise<InputDeliverResult>>;
  readonly waiters: Set<() => void>;
  /** A page's fields as a picture, taken at raise before anything was typed: the owner's card only, RAM only. */
  shot?: InputShot;
  /** The document a page's values were typed into: once the page has left it, its quarantine lets text reads by. */
  navigation?: string;
  /** The daemon's dummy probe at raise found its throwaway value in no read of the page (lock.ts). */
  probed?: boolean;
  /** The `code` fields the daemon saw going into a password (`observedAs`): handled as `secret` from then on. */
  readonly upgraded: Set<string>;
  /** A rule matched this card only through a program from the owner's profile: what the write and the log name. */
  pastedInto?: ProfileProgram;
}

/**
 * A page's names in the quarantine registry. Terminals and pages share the registry, so a page's names carry a
 * mark no surface key can start with: a hold on page "app" never seals terminal "app". Page holds are not
 * journalled: a page does not outlive the daemon that drove it.
 */
const PAGE_MARK = '~page:';
const pageName = (name: string): string => `${PAGE_MARK}${name}`;
const isPageHold = (hold: QuarantineHold): boolean => hold.names.every(name => name.startsWith(PAGE_MARK));

/** The names a hold on a request's target takes: its key and up to three more it was seen under, a page's marked. */
function holdNames(request: InputRequest, seenNames: readonly string[] | undefined): readonly string[] {
  const surfaceNames = [...new Set([request.target.key, ...(seenNames ?? [])])].slice(0, 4);
  return request.target.kind === 'browser' ? surfaceNames.map(pageName) : surfaceNames;
}

/** How long before a grant fill's page hold ends its clear takes a hold of its own and runs. */
const CLEAR_LEAD_MS = 2_000;

export interface InputRequestServiceDependencies {
  readonly target: InputTargetPort;
  readonly agenda: InputAgendaPort;
  readonly notifier: InputAgentNotifier;
  readonly journal: InputJournal;
  readonly audit: InputAudit;
  readonly clock: InputClock;
  readonly ids: InputIds;
  readonly timers: InputTimers;
  readonly sessions: InputSessionDirectory;
  readonly values: EphemeralValues;
  /** The terminals a secret was just typed into, which an agent may not read until the window ends. */
  readonly quarantine: QuarantineRegistry;
  /** Masks every known secret and every just-typed value in text shown to the owner; rejects when it cannot. */
  readonly redact: (text: string) => Promise<string>;
  /** Saved logins: offered on the card, typed by name, and kept by "Save as". Absent: none are offered. */
  readonly logins?: InputLoginPort;
  /** The session's project, folder and the owner's defaults, which order the saved logins a card offers. Absent: none. */
  readonly choice?: InputChoicePort;
  /** This machine's host name, for a terminal target's key (`sudo@<host>`). */
  readonly hostName?: string;
  /** Secure copies a paste types from (docs/secure-copy.md). Absent: a paste is refused. */
  readonly sealed?: InputSealedPort;
  /** The owner's pre-approval rules. Absent: every paste waits for the owner. */
  readonly rules?: InputPasteRules;
  /**
   * Sign-ins the owner approved in advance on a task plan (`sign-in-grants`): a card a line covers is filled under it
   * after every check holds again. Absent, or not `enabled()`: every sign-in waits for the owner.
   */
  readonly grants?: SignInGrantSource;
  /**
   * Asks the phone's buzz to look at the session's board again, with no edit to it: a card raised quiet that a standing
   * rule did not fill after all must buzz like any raise, while its words stay byte-identical to a card no rule was
   * ever about (a ferret reads its own agenda). Absent: such a card buzzes at the next board change or sweep.
   */
  readonly rebuzz?: (sessionId: string) => Promise<void>;
  /**
   * Told about every value typed into a terminal or a page, once it landed: the facts a saved login keeps
   * (docs/input-requests.md, "Login recipes") come only from here, and so does whether a code Ferretry made went
   * through (`codeTyped`). Absent: no facts are kept.
   */
  readonly observer?: Pick<LoginObserver, 'delivered' | 'tainted'> & Partial<Pick<LoginObserver, 'codeTyped'>>;
}

const instant = (ms: number): string => new Date(ms).toISOString();

/** The target key a card offers saved accounts for, set from the latest sighting, or cleared when it names none. */
function rekey(held: Held, matchKey: string | undefined): void {
  if (matchKey === undefined) delete held.matchKey;
  else held.matchKey = matchKey;
}

/** What a card offers from a store that cannot be read: nothing, and the owner can still type. */
const NO_ACCOUNTS: SavedListing = { accounts: [], signIns: [] };

const isFinal = (request: InputRequest): boolean => FINAL.has(request.state);

export class InputRequestService {
  private readonly held = new Map<string, Held>();
  /**
   * What a card being raised is about, by request id, while `agenda.raise` runs: the card's push is made INSIDE that
   * raise (the deadline push, buzz.ts), before the request is held, so `pushSubjectOf` must already know it.
   */
  private readonly raising = new Map<string, { readonly sessionId: string; readonly subject: PushSubject }>();
  private readonly raises = new Map<string, number[]>();
  /** Requests being filled under a grant or a rule right now: their cards do not buzz (`quietCard`). */
  private readonly quiet = new Set<string>();
  /** Quiet requests a PLAN line was likely to fill: only those may say so on the card if it vanishes before the fill. */
  private readonly quietForPlan = new Set<string>();
  private readonly lock = new SessionLock();

  constructor(private readonly deps: InputRequestServiceDependencies) {}

  /** The agent raises. Nothing in `raise` was observed; everything in the answer and the card was. */
  async raise(sessionId: string, raise: InputRaise): Promise<InputAgentView> {
    guardFields(raise.target, inputRaiseFields(raise));
    if (raise.target.kind === 'secret' && raise.source === undefined)
      throw new InputRequestError(
        'bad_request',
        'the secret store takes only a secure copy, by secure.paste; the owner adds other secrets in Settings',
      );
    if (raise.source !== undefined && inputRaiseFields(raise).length !== 1)
      throw new InputRequestError('bad_request', 'a paste fills one field: raise it with one field');
    await this.sweep();
    return await this.lock.run(sessionId, async () => {
      if (raise.source === undefined) return await this.admit(sessionId, raise, raise.target);
      // A paste is always a secret, whatever the agent said: the value is one it must not see.
      const copy = this.describeCopy(sessionId, raise.source.name);
      const secret: InputRaise =
        raise.fields === undefined
          ? { ...raise, sensitivity: 'secret' }
          : { ...raise, fields: raise.fields.map(field => ({ ...field, sensitivity: 'secret' as const })) };
      return await this.admit(sessionId, secret, raise.target, copy);
    });
  }

  /** A live copy of this session, or a refusal the agent can act on. */
  private describeCopy(sessionId: string, name: string): CopyMeta {
    const copy = this.deps.sealed?.describe(sessionId, name);
    if (copy === undefined)
      throw new InputRequestError(
        'not_found',
        `there is no live copy named ${copyHandle(name)} in this session; capture it with secure.copy first`,
      );
    return copy;
  }

  /** Runs `work` while no other raise, agent keystroke, close or secure write runs in this session. */
  async exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return await this.lock.run(sessionId, work);
  }

  private async admit(
    sessionId: string,
    raise: InputRaise,
    target: InputTarget,
    copy?: CopyMeta,
  ): Promise<InputAgentView> {
    const now = this.deps.clock.now();
    this.guardRate(sessionId, target, now);
    const raised = inputRaiseFields(raise);
    const seen = await this.deps.target.observe(sessionId, target, raised.map(pointerOf));
    if (!seen.ok) {
      throw new InputRequestError(
        seen.reason === 'target_gone' ? 'not_found' : 'bad_request',
        seen.reason === 'target_gone'
          ? `there is no ${target.kind} named ${target.key} in this session, or a field you named is not on it`
          : 'that target cannot take an input request',
      );
    }
    const shown = await this.project(sessionId, seen.facts, [target.key, ...(seen.names ?? [])]);
    const expiresAt = instant(now + (raise.expiresInSeconds ?? INPUT_DEFAULT_EXPIRY_SECONDS) * 1000);
    const requestId = this.deps.ids.requestId();
    // A code aimed at a password is a secret (observedAs): what the card, the lock, the mask and the journal all use.
    const upgraded = new Set<string>();
    const fields = observedAs(raised.map(cardField), seen.facts, upgraded, raise.prompt, seen.codeProgram === true);
    const sensitivity = strongestSensitivity(fields);
    // A page is pictured now, before the owner is asked and long before anything is typed into it.
    const shot =
      seen.facts.kind === 'browser'
        ? await this.deps.target.shoot?.(sessionId, target, seen.facts).catch(() => undefined)
        : undefined;
    // How long the target is kept from the ferret after the write (lock.ts): only what the daemon saw decides it.
    // The dummy probe runs after the picture, so the picture shows the page as it was.
    // A card of plain values and one-time codes is kept from nobody (lock.ts, heldFromView): no facts, probe or lock.
    const kept = heldFromView(fields) && target.kind !== 'secret';
    const observedFacts = kept ? await this.observedFacts(seen.facts) : [];
    // At the raise only a page script the ferret ever ran counts: acts before the card are the ferret's own business.
    const context = {
      observed: observedFacts,
      submitted: raise.submit !== 'agent',
      steered: this.tainted(sessionId, Number.POSITIVE_INFINITY),
    };
    const probed =
      kept && probeable(seen.facts, fields, context)
        ? (await this.deps.target
            .probe?.(
              sessionId,
              target,
              seen.facts,
              fields.filter(f => f.sensitivity === 'secret').map(f => f.id),
            )
            .catch(() => 'aborted' as const)) === 'hidden'
        : false;
    const lock = kept ? lockFor(seen.facts, fields, { ...context, probed }) : undefined;
    const step = raise.chain === undefined ? undefined : this.stepAfter(sessionId, raise.chain);
    const matchKey = targetMatchKey(seen.facts, this.deps.hostName ?? '');
    const title =
      copy === undefined
        ? ((await this.codeTitle(sessionId, fields, matchKey, raise.secretHint, raise.factor)) ?? titleOf(fields))
        : PASTE_TITLE;
    // A paste a rule covers is reserved BEFORE the card is raised, so the card can be raised quiet: it is filled and
    // closed at once, and must not buzz the owner's phone for the moment it was open (`quietCard`).
    const ruleId =
      copy === undefined ? undefined : this.ruleFor(sessionId, copy, seen.facts, fields, seen.profileProgram);
    const likely = copy === undefined ? this.likelyGrants(sessionId, target, matchKey, now) : [];
    if (ruleId !== undefined || likely.length > 0) this.quiet.add(requestId);
    if (likely.some(grant => grant.source === 'plan')) this.quietForPlan.add(requestId);
    try {
      return await this.present(sessionId, raise, target, {
        requestId,
        now,
        seen,
        shown,
        expiresAt,
        fields,
        sensitivity,
        shot,
        lock,
        probed,
        step,
        matchKey,
        title,
        upgraded,
        ...(copy === undefined ? {} : { copy }),
        ...(ruleId === undefined ? {} : { ruleId }),
      });
    } finally {
      this.quiet.delete(requestId);
      this.quietForPlan.delete(requestId);
    }
  }

  /** The rest of a raise, once what the card says is decided: the card, the journal, the record and any fill in advance. */
  private async present(
    sessionId: string,
    raise: InputRaise,
    target: InputTarget,
    raised: {
      readonly requestId: string;
      readonly now: number;
      readonly seen: Extract<ObserveResult, { readonly ok: true }>;
      readonly shown: InputTargetFacts;
      readonly expiresAt: string;
      readonly fields: InputRequestField[];
      readonly sensitivity: InputSensitivity;
      readonly shot: InputShot | undefined;
      readonly lock: InputRequest['lock'];
      readonly probed: boolean;
      readonly step: number | undefined;
      readonly matchKey: string | undefined;
      readonly title: string;
      readonly upgraded: Set<string>;
      readonly copy?: CopyMeta;
      readonly ruleId?: string;
    },
  ): Promise<InputAgentView> {
    const {
      requestId,
      now,
      seen,
      shown,
      expiresAt,
      fields,
      sensitivity,
      shot,
      lock,
      probed,
      step,
      matchKey,
      title,
      upgraded,
      copy,
    } = raised;
    let ruleId = raised.ruleId;
    try {
      this.raising.set(requestId, { sessionId, subject: sensitivity === 'code' ? 'one-time-code' : 'other' });
      const card = await this.deps.agenda
        .raise(sessionId, {
          requestId,
          title,
          ask: copy === undefined ? askOf(shown, fields) : pasteAskOf(copy, shown),
          prompt: raise.prompt,
          blocking: raise.blocking ?? sensitivity === 'secret',
          expiresAt,
          ...(raise.chain === undefined ? {} : { chain: raise.chain }),
        })
        .finally(() => this.raising.delete(requestId));
      if (!card.ok) throw new InputRequestError('unavailable', card.message);
      const request: InputRequest = {
        id: requestId,
        sessionId,
        agendaItemId: card.id,
        ...(copy === undefined ? {} : { source: { kind: 'sealed' as const, name: copy.name, from: copy.from } }),
        target: raise.target,
        prompt: raise.prompt,
        sensitivity,
        fields,
        submit: raise.submit,
        raisedAt: instant(now),
        expiresAt,
        ...(raise.chain === undefined ? {} : { chain: raise.chain }),
        ...(step === undefined ? {} : { step }),
        observed: shown,
        risk: pasteRisk(worstRisk(fields.map(field => field.risk)), copy),
        observedDigest: digestFacts(seen.facts),
        ...(shot === undefined ? {} : { pictured: true as const }),
        ...(lock === undefined ? {} : { lock }),
        state: 'pending',
      };
      try {
        await this.journal(request, 'requested');
      } catch {
        await this.deps.agenda.close(sessionId, card.id, 'Input request could not be recorded.');
        throw new InputRequestError(
          'unavailable',
          'Ferretry could not record the request, so it did not ask the owner',
        );
      }
      const held: Held = {
        request,
        names: [target.key, ...(seen.names ?? [])],
        checkFailures: 0,
        rebinds: 0,
        binding: bindingOf(seen.facts),
        title,
        formerCards: [],
        ...(seen.facts.kind === 'browser' ? { raisedOn: seen.facts.navigationId } : {}),
        ...(matchKey === undefined ? {} : { matchKey }),
        ...(raise.secretHint === undefined ? {} : { hint: raise.secretHint }),
        deliveries: new Map(),
        waiters: new Set(),
        ...(shot === undefined ? {} : { shot }),
        ...(probed ? { probed: true } : {}),
        upgraded,
      };
      this.held.set(requestId, held);
      this.noteRaise(sessionId, now);
      await this.record(request, 'input.requested', { kind: 'agent' }, this.auditOf(request));
      if (ruleId !== undefined) {
        const reserved = ruleId;
        ruleId = undefined;
        await this.underRule(held, reserved, seen.facts, raise.submit, seen.profileProgram);
      } else if (copy === undefined) await this.underGrant(held, seen.facts, raise);
      return this.view(held);
    } finally {
      // A rule reserved for a card that was never raised or held is given back: nothing was typed under it.
      if (ruleId !== undefined) this.deps.rules?.release(ruleId);
    }
  }

  /**
   * A paste the owner approved IN ADVANCE: delivered now, under the rule, still as one guarded write with the
   * card raised, audited and closed so it shows in the log. Runs inside the raise's turn of the session lock.
   * Only a target that hides what is typed is pasted unasked. A use is given back only when NOTHING may have
   * been typed; an uncertain write spends it.
   */
  private async underRule(
    held: Held,
    ruleId: string,
    facts: InputTargetFacts,
    submit: InputRaise['submit'],
    profile?: ProfileProgram,
  ): Promise<void> {
    // With no proved program, only the owner's profile could have matched: the write and the log name it.
    if (facts.kind === 'terminal' && facts.program === undefined && profile !== undefined) held.pastedInto = profile;
    const body: InputDeliverBody = {
      deliveryId: crypto.randomUUID(),
      observedDigest: held.request.observedDigest ?? '',
      sealed: true,
      submit: submit === 'owner-default',
    };
    let written = false;
    try {
      await this.attempt(held, body, { kind: 'rule', ruleId }, typed => {
        written = typed === 'typed' || typed === 'uncertain';
      });
      this.deps.rules?.spent(ruleId);
    } catch {
      if (written) this.deps.rules?.spent(ruleId);
      else this.deps.rules?.release(ruleId);
      // The card stays for the owner: it is no longer quiet, and the daemon's edit makes it buzz as any raise does.
      await this.unquiet(held, RULE_MISS_CONTEXT_LINE);
    }
  }

  /**
   * The owner's pre-approval rule a paste may go out under, RESERVED now (before its card is raised) so the card can be
   * raised quiet. Only a target that hides what is typed, and only what a rule may paste unasked (`ruleMayPaste`).
   */
  private ruleFor(
    sessionId: string,
    copy: CopyMeta,
    facts: InputTargetFacts,
    fields: readonly InputRequestField[],
    profile: ProfileProgram | undefined,
  ): string | undefined {
    if (!hidesTyping(facts) || !ruleMayPaste(copy, facts, fields)) return undefined;
    return this.deps.rules?.reserve(sessionId, copy.from, facts, profile?.name);
  }

  /**
   * While a request is being filled under a task-plan line or a pre-approval rule, its card is QUIET: it is raised and
   * closed at once, so the push its raise would make (an input card's deadline push fires the moment it is raised) must
   * not buzz the owner's phone. A fill that does not happen clears it, and the card then pushes as any raise does.
   * Daemon-side only: the card on the wire is unchanged.
   */
  quietCard(sessionId: string, requestId: string): boolean {
    if (!this.quiet.has(requestId)) return false;
    const raising = this.raising.get(requestId);
    const held = this.held.get(requestId);
    return (raising?.sessionId ?? held?.request.sessionId) === sessionId;
  }

  /** The grants of this session whose pinned keys hold this target's key: in force first, the soonest to expire first. */
  private grantsAt(sessionId: string, matchKey: string | undefined): readonly SignInGrant[] {
    const grants = this.deps.grants;
    if (grants === undefined || matchKey === undefined || !grants.enabled()) return [];
    const here = grants.of(sessionId).filter(grant => grant.pins.placeKeys.includes(matchKey));
    return [...here.filter(grant => grant.state === 'in-force'), ...here.filter(grant => grant.state !== 'in-force')];
  }

  /**
   * The grants about this target that may fill it: in force, or one whose sign-in attempt in this session is still open
   * (a later step continues on the use it spent). Any: the card is raised quiet, and the fill decides after.
   */
  private likelyGrants(
    sessionId: string,
    target: InputTarget,
    matchKey: string | undefined,
    now: number,
  ): readonly SignInGrant[] {
    if (target.kind === 'secret') return [];
    const ledger = this.deps.grants?.ledger;
    return this.grantsAt(sessionId, matchKey).filter(
      grant =>
        grant.expiresAt > now &&
        (grant.state === 'in-force' ||
          (grant.state === 'used-up' && ledger?.joinable(grant.id, sessionId, now) === true)),
    );
  }

  /**
   * A SIGN-IN THE OWNER APPROVED IN ADVANCE, on a task plan or with a standing rule (docs/input-requests.md, "Task plan
   * fills", "Standing rule fills"): filled now, under the grant, as one guarded write with the card raised, audited and
   * closed so it shows in the history. Runs inside the raise's turn of the session lock, after the card is held.
   *
   * The shared matcher runs here on the raise's facts and again in {@link attempt} on the facts looked at before the
   * write (a standing rule's stored proof and pinned facts are checked again first); every check holds or nothing is
   * typed. A miss leaves the card for the owner with `preapproval` saying which grant did not apply and why (the owner's
   * view only), and stops a plan line or suspends a rule when the miss says so. A use is spent synchronously by the one
   * ledger; it is given back only when nothing may have been typed. Total: a fill that cannot be tried is a normal card.
   */
  private async underGrant(held: Held, facts: InputTargetFacts, raise: InputRaise): Promise<void> {
    const grants = this.deps.grants;
    const { sessionId } = held.request;
    const here = this.grantsAt(sessionId, held.matchKey);
    // A card raised quiet whose grant ended (revoked, expired) while it was raised is the owner's again, at once. Only
    // a card a PLAN line was about says so: a ferret reads its agenda, and must learn nothing about a rule.
    if (grants === undefined || here.length === 0)
      return await this.unquiet(held, this.quietForPlan.has(held.request.id) ? GRANT_MISS_CONTEXT_LINE : undefined);
    let chosen: SignInGrant | undefined;
    try {
      const decided = await this.decideGrant(held, facts, here, grants);
      chosen = decided.grant;
      if (!decided.ok) return await this.grantMissed(held, decided.grant, decided.reason, decided.misses);
      const { grant, match, reservation, project } = decided;
      const actor = actorOf(grant);
      if (actor === undefined) {
        grants.ledger.release(reservation);
        return await this.grantMissed(held, grant, undefined);
      }
      const body: InputDeliverBody = {
        deliveryId: crypto.randomUUID(),
        observedDigest: held.request.observedDigest ?? '',
        entry: match.account,
        signIn: grant.signIn,
        ...(match.factor !== undefined && match.fills.includes('totp') ? { factor: match.factor } : {}),
        // Under a grant nobody else could press Send: Enter goes after the last value unless the ferret submits itself.
        submit: raise.submit !== 'agent',
      };
      let written = false;
      // The form a fill pins for its field set; a rule's join-only code step pins nothing.
      let identity: string | undefined = match.joinOnly === true ? undefined : match.identity;
      const settle = (): void => {
        if (grants.ledger.spent(reservation, identity)) grants.used(grant, this.deps.clock.now(), sessionId);
      };
      // The ferret reads the card as it stood until the request really ends (a fill, or the card back for the owner).
      held.agentSees = held.request;
      const raisedLock = held.request.lock;
      try {
        await this.attempt(
          held,
          body,
          actor,
          typed => {
            written = typed === 'typed' || typed === 'uncertain';
            if (typed === 'typed') held.request = { ...held.request, preapproval: preapprovalOf(grant, 'filled') };
          },
          {
            recheck: async seen => {
              // A standing rule's stored proof and pinned facts, checked again offline (a failure suspends it).
              const verdict = await grants.verify(grant);
              if (!verdict.ok)
                throw verdict.reason === undefined ? new GrantUnchecked() : new GrantMissed(verdict.reason);
              // The grant as it stands NOW (a revoke, an expiry or a stop since the raise counts), on the facts just seen.
              const now = grants.of(sessionId).find(each => each.id === grant.id);
              if (now === undefined) throw new GrantMissed('expired');
              const again = await this.matchAgain(held, seen, now, grants);
              if (!again.ok) throw new GrantMissed(again.reason);
              identity = again.joinOnly === true ? undefined : again.identity;
            },
            held: () => {
              // Synchronous, with nothing awaited before the write: a revoke, an expiry, a stop or a suspension, a
              // narrowing that took a role away, or a page script on a rule's places since the last look ends it here.
              const at = this.deps.clock.now();
              const now = grants.of(sessionId).find(each => each.id === grant.id);
              return (
                now !== undefined &&
                now.state !== 'stopped' &&
                now.expiresAt > at &&
                grants.holds(now, { sessionId, project, roles: match.fills, now: at })
              );
            },
            typed: (job, holdMs, names) => this.clearBeforeHoldEnds(held, grant, grants, job, holdMs, names),
            uncertain: async () => await grants.stopped(grant, 'did-not-move-on').catch(() => undefined),
          },
        );
        settle();
      } catch (error) {
        if (written) settle();
        else {
          grants.ledger.release(reservation);
          // Nothing was typed: the ferret goes on reading the lock the card was raised with, as with no grant.
          if (held.request.state === 'pending') held.agentLock = { lock: raisedLock };
        }
        delete held.agentSees;
        await this.grantMissed(held, grant, error instanceof GrantMissed ? error.reason : undefined);
      } finally {
        delete held.agentSees;
      }
    } catch {
      // A fill that could not be tried leaves the owner's card as it is.
      if (chosen !== undefined) await this.grantMissed(held, chosen, undefined).catch(() => undefined);
      else await this.unquiet(held, this.quietForPlan.has(held.request.id) ? GRANT_MISS_CONTEXT_LINE : undefined);
    }
  }

  /**
   * Which grant fills this card: the first in force (soonest to expire) that the matcher passes and the ledger has a use
   * and room for; else the misses, in that order, so a grant spent, stopped or suspended still says why. The one the
   * owner reads is the first PLAN line's when there is one: a ferret that knows its plan sees the plan's words whether
   * or not a rule was also tried, and learns nothing about the rule.
   */
  private async decideGrant(
    held: Held,
    facts: InputTargetFacts,
    here: readonly SignInGrant[],
    grants: SignInGrantSource,
  ): Promise<
    | {
        readonly ok: true;
        readonly grant: SignInGrant;
        readonly match: Extract<GrantMatch, { readonly ok: true }>;
        readonly reservation: GrantReservation;
        readonly project: string | undefined;
      }
    | {
        readonly ok: false;
        readonly grant: SignInGrant;
        readonly reason: GrantMissReason | undefined;
        readonly misses: readonly GrantMiss[];
      }
  > {
    const first = here[0] as SignInGrant;
    const seen = await this.sightingOf(held, facts, held.request.fields, here, grants);
    // Accounts that can't be read: a plan line says the sign-in is gone (as it always has); a rule says nothing, and
    // is not suspended for it.
    if (seen === undefined) {
      const plan = here.find(grant => grant.source === 'plan');
      return plan === undefined
        ? { ok: false, grant: first, reason: undefined, misses: [] }
        : { ok: false, grant: plan, reason: 'sign-in-gone', misses: [] };
    }
    const misses: GrantMiss[] = [];
    for (const grant of here) {
      const match = matchSignInGrant(grant, seen, grants.ledger.pinned(grant.id));
      if (!match.ok) {
        misses.push({ grant, reason: match.reason });
        continue;
      }
      const reservation = grants.ledger.reserve(
        {
          id: grant.id,
          signIn: grant.signIn,
          remaining: grant.remaining,
          ...(grant.source === 'rule' ? { codeJoinsPassword: true } : {}),
        },
        held.request.sessionId,
        match.fills,
        match.fieldSet,
        seen.now,
        {
          place: seen.matchKey,
          ...(facts.kind === 'browser' ? { pageId: facts.pageId, navigationId: facts.navigationId } : {}),
          // The ferret did nothing to the session's pages since then (reads and waits are no acts).
          untouchedSince: (at: number) => !this.tainted(held.request.sessionId, at),
        },
      );
      if (typeof reservation !== 'string') return { ok: true, grant, match, reservation, project: seen.project };
      misses.push({ grant, reason: reservation });
    }
    // `here` is never empty, so every grant that did not fill left its miss.
    const reported = misses.find(each => each.grant.source === 'plan') ?? (misses[0] as GrantMiss);
    return { ok: false, ...reported, misses };
  }

  /** The matcher again at the write, on the facts just looked at, with the accounts read again. */
  private async matchAgain(
    held: Held,
    looked: Extract<ObserveResult, { readonly ok: true }>,
    grant: SignInGrant,
    grants: SignInGrantSource,
  ): Promise<GrantMatch> {
    const { request } = held;
    // A copy of the upgrades: the write's own `observedAs` records them; this only reads what the fields are now.
    const fields = observedAs(
      request.fields,
      looked.facts,
      new Set(held.upgraded),
      request.prompt,
      looked.codeProgram === true,
    );
    const seen = await this.sightingOf(held, looked.facts, fields, [grant], grants);
    if (seen === undefined) return { ok: false, reason: 'sign-in-gone' };
    return matchSignInGrant(grant, seen, grants.ledger.pinned(grant.id));
  }

  /**
   * What the matcher reads: the daemon's facts, the accounts and their keys now, whether the ferret ran a script in this
   * session, where any session ran one on the machine, and the session's stamped project.
   */
  private async sightingOf(
    held: Held,
    facts: InputTargetFacts,
    fields: readonly InputRequestField[],
    grants: readonly SignInGrant[],
    source: SignInGrantSource,
  ): Promise<GrantSighting | undefined> {
    const listing = await this.deps.logins?.listing().catch(() => undefined);
    if (listing === undefined) return undefined;
    const accounts = new Set(
      grants.flatMap(grant => listing.signIns.filter(each => each.id === grant.signIn).map(each => each.account)),
    );
    const keys = new Map<AccountId, AccountKey>();
    for (const account of accounts) {
      const key = await source.keyOf(account);
      if (key !== undefined) keys.set(account, key);
    }
    const { sessionId } = held.request;
    const project = grants.some(grant => grant.scope?.kind === 'project')
      ? await source.projectOf(sessionId).catch(() => undefined)
      : undefined;
    return {
      sessionId,
      facts,
      matchKey: targetMatchKey(facts, this.deps.hostName ?? ''),
      fields,
      listing,
      keys,
      // Any page script the ferret EVER ran in this session: stricter than "on this document".
      scripted: this.tainted(sessionId, Number.POSITIVE_INFINITY),
      scriptedOrigins: source.scriptedOrigins(),
      ...(project === undefined ? {} : { project }),
      ...(held.hint === undefined ? {} : { hint: held.hint }),
      now: this.deps.clock.now(),
    };
  }

  /**
   * A grant did not fill this card: it stays for the owner, who reads which grant did not apply and why (their view
   * only), and the card is no longer quiet. Every grant tried whose miss stops it (a plan line) or suspends it (a rule)
   * is stopped. Audited, never a value. A request that already ended (an uncertain write) says nothing more.
   *
   * What the FERRET reads stays as it would be without the grant: a plan line's miss adds the one fixed context line to
   * the card; a rule's adds nothing at all, so its agenda is byte-identical to a sign-in no rule was ever about, and the
   * card is only made to buzz again.
   */
  private async grantMissed(
    held: Held,
    grant: SignInGrant,
    reason: GrantMissReason | undefined,
    misses: readonly GrantMiss[] = [],
  ): Promise<void> {
    if (held.request.state !== 'pending') {
      this.quiet.delete(held.request.id);
      return;
    }
    held.request = { ...held.request, preapproval: preapprovalOf(grant, 'did-not-apply', reason) };
    const stopping = [...misses, ...(reason === undefined ? [] : [{ grant, reason }])].filter(
      (each, index, all) =>
        grantStops(each.grant, each.reason) && all.findIndex(other => other.grant.id === each.grant.id) === index,
    );
    for (const each of stopping) await this.deps.grants?.stopped(each.grant, each.reason);
    await this.record(
      held.request,
      'input.requested',
      { kind: 'daemon' },
      {
        ...this.auditOf(held.request),
        preapproval: 'did-not-apply',
        ...(grant.plan === undefined ? {} : { plan: grant.plan.id, line: grant.plan.line }),
        ...(grant.rule === undefined
          ? {}
          : { by: 'rule' as const, signInRule: grant.rule.id, revision: grant.rule.revision }),
        ...(reason === undefined ? {} : { because: reason }),
      },
    );
    await this.unquiet(held, grant.source === 'plan' ? GRANT_MISS_CONTEXT_LINE : undefined);
  }

  /**
   * A card raised quiet is the owner's to answer after all: it buzzes again. With a `line` (the same words whatever went
   * wrong: the ferret can read its own agenda), the daemon's edit to the card makes the buzz settle at once. Without one
   * (a standing rule's miss), the card is left exactly as raised and the buzz is asked to look again.
   */
  private async unquiet(held: Held, line: string | undefined): Promise<void> {
    const { request } = held;
    if (!this.quiet.delete(request.id) || request.state !== 'pending') return;
    if (line === undefined) {
      await this.deps.rebuzz?.(request.sessionId).catch(() => undefined);
      return;
    }
    await this.deps.agenda
      .note?.(
        request.sessionId,
        request.agendaItemId,
        { prompt: request.prompt, ...(request.chain === undefined ? {} : { chain: request.chain }) },
        line,
      )
      .catch(() => undefined);
  }

  /**
   * BEFORE THE PAGE HOLD ENDS, a password a grant fill typed must not still be sitting in its field. The moment the write
   * is done, a hold of its own is taken on the same page, which cannot expire while it is in flight, so no stalled timer
   * or suspended machine can leave the page unheld with the value in it. Shortly before the write's own hold would end
   * ({@link CLEAR_LEAD_MS}), the browser empties any typed field that still holds a value. `moved` and `cleared` let that
   * hold go; `unknown` (the value may still be there) keeps the page held for a full window more. `cleared` and `unknown`
   * stop the line (`did-not-move-on`): the page didn't move on as the owner approved.
   */
  private clearBeforeHoldEnds(
    held: Held,
    grant: SignInGrant,
    grants: SignInGrantSource,
    job: ClearJob,
    holdMs: number,
    names: readonly string[],
  ): void {
    const { sessionId, target, id } = held.request;
    const clearing = this.deps.quarantine.begin(sessionId, names, id);
    let outcome: ClearOutcome = 'unknown';
    void this.deps.timers
      .after(Math.max(0, holdMs - CLEAR_LEAD_MS))
      .then(async () => {
        outcome = (await this.deps.target.clear?.(sessionId, target, job).catch(() => 'unknown' as const)) ?? 'unknown';
        if (outcome !== 'moved') await grants.stopped(grant, 'did-not-move-on');
      })
      .catch(() => undefined)
      .finally(() => {
        if (outcome === 'unknown') this.deps.quarantine.settle(clearing);
        else this.deps.quarantine.release(clearing);
      });
  }

  /**
   * Which step of a login a chained card is: one more than the card it follows. The card it follows must be one
   * of THIS session's input requests that this daemon holds: another session's card, an unknown one, or one from
   * before a restart is refused, so a card never claims to continue a login it is not part of.
   */
  private stepAfter(sessionId: string, chain: AgendaId): number {
    const before = this.byCard(sessionId, chain);
    if (before === undefined)
      throw new InputRequestError(
        'bad_request',
        `chain names ${chain}, which is not an input request of this session; raise this card without chain`,
      );
    return Math.min(MAX_STEP, (before.request.step ?? 1) + 1);
  }

  /** What the agent reads about its request: where it stands, never the value. Waits up to `waitMs` for a final state. */
  async agentView(sessionId: string, id: AgendaId, waitMs: number): Promise<InputAgentView> {
    await this.sweep();
    const held = this.byCard(sessionId, id);
    if (held === undefined) throw new InputRequestError('not_found', `no input request ${id} in this session`);
    if (waitMs > 0 && !isFinal(held.request)) {
      await Promise.race([
        new Promise<void>(resolve => held.waiters.add(resolve)),
        this.deps.timers.after(Math.min(waitMs, WAIT_CEILING_MS)),
      ]);
      await this.sweep();
    }
    return this.view(held);
  }

  /** The requests still open, newest last: for one session or, with none named, for all. Owner only. */
  async list(caller: InputCaller, sessionId?: string): Promise<readonly InputRequest[]> {
    requireOwner(caller);
    await this.sweep();
    const open = [...this.held.values()]
      .filter(held => !isFinal(held.request) && (sessionId === undefined || held.request.sessionId === sessionId))
      .sort((a, b) => (a.request.raisedAt < b.request.raisedAt ? -1 : a.request.raisedAt > b.request.raisedAt ? 1 : 0));
    const shown = await Promise.all(open.map(async held => await this.exposed(held)));
    return shown.map((request, index) => this.sealed(open[index] as Held, request));
  }

  /**
   * The request as the owner's client may read it: the prompt line the terminal showed and the program's
   * command line pass the redactor (a screen can echo a value, and an argv can carry one), and are cut to
   * their limits again. Nothing here is the held copy, so the raw binding material stays in RAM.
   */
  private async exposed(held: Held): Promise<InputRequest> {
    const { request } = held;
    const facts = request.observed;
    const prompt = (await this.deps.redact(request.prompt)).slice(0, INPUT_PROMPT_MAX_LENGTH);
    // A label is the agent's words as much as the prompt is, and could carry a value just the same.
    const fields = await Promise.all(
      request.fields.map(async field => ({
        ...field,
        label: (await this.deps.redact(field.label)).slice(0, 60).trim() || FIELD_LABELS[field.sensitivity],
      })),
    );
    const saved = await this.savedView(held);
    const withSaved = saved === undefined ? { ...request, prompt, fields } : { ...request, prompt, fields, saved };
    if (facts === undefined) return withSaved;
    return { ...withSaved, observed: await this.project(request.sessionId, facts, held.names) };
  }

  /** The session's project, folder and defaults; none when nothing is wired or the daemon cannot read them. */
  private async choiceOf(sessionId: string): Promise<Omit<SignInChoiceContext, 'hint'>> {
    return (await this.deps.choice?.of(sessionId).catch(() => undefined)) ?? {};
  }

  /**
   * What the owner's card may offer from the saved accounts: the sign-ins matched to the target, the one first that the
   * ferret's hint or a default chose among THOSE, then what may be picked by hand. A store that cannot be read offers
   * nothing rather than failing the card: the owner can still type the value.
   */
  private async savedView(held: Held): Promise<InputRequest['saved']> {
    const { logins } = this.deps;
    if (logins === undefined || held.request.state !== 'pending') return undefined;
    const listing = await logins.listing().catch((): SavedListing => NO_ACCOUNTS);
    return savedForFields(held.request.fields, held.matchKey, listing, {
      ...(await this.choiceOf(held.request.sessionId)),
      hint: held.hint,
      codesHere: codesHere(held.request.observed, held.request.fields),
    });
  }

  /**
   * A code card's title from the 2FA keys of the account the daemon matched here ("Code sent to ••42 (SMS)"), in the
   * OWNER's words: the ferret's `factor` only picks one of that account's keys, and anything else it names is ignored.
   * `undefined` (the plain "Needs a code") for a card whose most careful field is not a code, a target no sign-in
   * matches, a store that cannot be read, or two accounts and nothing to choose between them. A key reads the same
   * whether Ferretry holds its seed, so the title never says one exists.
   */
  private async codeTitle(
    sessionId: string,
    fields: readonly InputRequestField[],
    matchKey: string | undefined,
    hint: string | undefined,
    factor: TwoFactorId | undefined,
  ): Promise<string | undefined> {
    if (strongestSensitivity(fields) !== 'code' || matchKey === undefined) return undefined;
    const listing = await this.deps.logins?.listing().catch(() => undefined);
    if (listing === undefined) return undefined;
    const about = codeCardKeys(matchKey, listing, {
      ...(await this.choiceOf(sessionId)),
      ...(hint === undefined ? {} : { hint }),
      ...(factor === undefined ? {} : { factor }),
    });
    return about === undefined ? undefined : clipped(factorAskWords(about.keys, about.account));
  }

  /** The last word before a request leaves the service: a hold taken while it was being redacted still seals it. */
  private sealed(held: Held, shown: InputRequest): InputRequest {
    if (shown.observed?.kind !== 'terminal' || !this.quarantined(shown.sessionId, held.names)) return shown;
    return { ...shown, observed: maskedFacts(shown.observed) };
  }

  /**
   * What the daemon saw, as it may be shown, stored and audited. The raw text (a prompt line, an argv, a
   * program name) is masked WHOLE and only then cut to its limit, so a clipped echo cannot leave a prefix
   * of a value. A prompt line is one physical row, so a value that wrapped leaves only a piece of itself
   * there that no exact match can find: such a line is replaced outright.
   * The raw facts are the binding material; they are digested and handed to the write, never kept.
   */
  private quarantined(sessionId: string, names: readonly string[]): boolean {
    return this.deps.quarantine.until(sessionId, names) !== undefined;
  }

  /** The audit detail: ids, kinds and flags, never a program the pane named. */
  private auditOf(request: InputRequest): InputAuditDetail {
    return auditDetail(request);
  }

  private async project(
    sessionId: string,
    facts: InputTargetFacts,
    names: readonly string[],
  ): Promise<InputTargetFacts> {
    if (facts.kind !== 'terminal') return facts;
    if (this.quarantined(sessionId, names)) return maskedFacts(facts);
    const clip = async (text: string, limit: number): Promise<string> =>
      (await this.deps.redact(text)).slice(0, limit).trimEnd();
    const shown: InputTargetFacts = {
      ...facts,
      promptLine: this.deps.values.fragments(sessionId, facts.promptLine)
        ? HIDDEN_PROMPT
        : await clip(facts.promptLine, FACT_TEXT_LIMIT),
      foreground: {
        ...facts.foreground,
        comm: await clip(facts.foreground.comm, COMM_TEXT_LIMIT),
        argv: await clip(facts.foreground.argv, FACT_TEXT_LIMIT),
      },
    };
    return this.quarantined(sessionId, names) ? maskedFacts(facts) : shown;
  }

  /** `text` with any value delivered to this session in the redaction window masked, for an agent's terminal reads. */
  scrub(sessionId: string, text: string): string {
    return this.deps.values.scrub(sessionId, text);
  }

  /**
   * What a request's push is about (`pushUrgencyFor`): a pending card whose strongest field is a one-time `code` is
   * `one-time-code`, and is pushed at high priority; anything else, or a request this daemon does not hold, is `other`.
   */
  pushSubjectOf(sessionId: string, requestId: string): PushSubject {
    const raising = this.raising.get(requestId);
    if (raising !== undefined) return raising.sessionId === sessionId ? raising.subject : 'other';
    const held = this.held.get(requestId);
    if (held === undefined || held.request.sessionId !== sessionId || isFinal(held.request)) return 'other';
    return held.request.sensitivity === 'code' ? 'one-time-code' : 'other';
  }

  /**
   * Whether the session has a card open the owner has not answered yet — what keeps the Warden from moving a ferret
   * in the middle of one. A yes or no, nothing about the card: it needs no owner, and says nothing a value could leak through.
   */
  hasOpen(sessionId: string): boolean {
    for (const { request } of this.held.values()) if (request.sessionId === sessionId && !isFinal(request)) return true;
    return false;
  }

  /**
   * The pending request on a surface, so an agent cannot type into the field the owner has been asked about. Asked
   * for `typing`, a card of one-time codes only does not count: the ferret may type a code itself (one it read from
   * an inbox it has), so it is never kept off the surface for one. Any other field on the card still blocks.
   */
  pendingOn(
    sessionId: string,
    target: { readonly kind: string; readonly key: string },
    options?: { readonly typing?: boolean },
  ): AgendaId | undefined {
    for (const { request } of this.held.values()) {
      if (request.sessionId !== sessionId || isFinal(request)) continue;
      if (options?.typing === true && request.fields.every(field => field.sensitivity === 'code')) continue;
      if (request.target.kind === target.kind && request.target.key === target.key) return request.agendaItemId;
    }
    return undefined;
  }

  /**
   * The owner types the value. Owner only, twice: the route refuses an agent before it reads the body, and
   * this refuses any caller that is not the host or a paired device. A retry of a `deliveryId` returns the
   * first outcome and writes nothing.
   */
  async deliver(
    sessionId: string,
    requestId: string,
    body: InputDeliverBody,
    caller: InputCaller,
  ): Promise<InputDeliverResult> {
    const owner = requireOwner(caller);
    await this.sweep();
    const held = this.held.get(requestId);
    if (held === undefined || held.request.sessionId !== sessionId)
      throw new InputRequestError('not_found', 'no such input request');
    const earlier = held.deliveries.get(body.deliveryId);
    if (earlier !== undefined) return await earlier;
    const attempt = this.lock.run(sessionId, async () => {
      try {
        this.guardDeliverable(held);
      } catch (error) {
        held.deliveries.delete(body.deliveryId);
        throw error;
      }
      return await this.attempt(held, body, owner);
    });
    held.deliveries.set(body.deliveryId, attempt);
    return await attempt;
  }

  /**
   * An OPEN card's target key as the DAEMON saw it (never the agent's word), for a 2FA seed set up from that card:
   * it saves only to an account that signs in there (docs/secrets.md, "2FA keys"). `undefined`: no such open card.
   */
  cardTarget(requestId: string): { readonly matchKey?: string; readonly observedDigest?: string } | undefined {
    const held = this.held.get(requestId);
    if (held === undefined || isFinal(held.request)) return undefined;
    const { observedDigest } = held.request;
    return {
      ...(held.matchKey === undefined ? {} : { matchKey: held.matchKey }),
      ...(observedDigest === undefined ? {} : { observedDigest }),
    };
  }

  /**
   * "USE IT NOW": the owner just saved a 2FA seed with a passkey from this OPEN code card, so the daemon makes the key's
   * first code and types it into the card, as a "Use code from Ferretry" tap would — through {@link deliver}, so every
   * check of that tap holds (the matched account's key, the exact place, the field, the upgrade to a secret). Only a card
   * that is all one-time codes. Whether it was typed; never the code. Total.
   */
  async useNow(
    requestId: string,
    use: {
      readonly account: AccountId;
      readonly factor: TwoFactorId;
      /** The card as the owner saw it when they set the key up: a card redrawn since is refused, nothing typed. */
      readonly observedDigest: string;
      readonly submit?: boolean;
      readonly actor: Extract<InputActor, { readonly kind: 'host' | 'device' }>;
    },
  ): Promise<boolean> {
    const held = this.held.get(requestId);
    if (held === undefined || held.request.state !== 'pending') return false;
    if (!held.request.fields.every(field => fillRoleFor(field.sensitivity) === 'totp')) return false;
    const caller: InputCaller = {
      kind: 'owner',
      actor: use.actor,
      carrier: use.actor.kind === 'device' ? 'direct' : 'loopback',
    };
    const body: InputDeliverBody = {
      deliveryId: crypto.randomUUID(),
      observedDigest: use.observedDigest,
      entry: use.account,
      factor: use.factor,
      submit: use.submit ?? held.request.submit === 'owner-default',
    };
    return await this.deliver(held.request.sessionId, requestId, body, caller).then(
      result => result.state === 'delivered',
      () => false,
    );
  }

  /**
   * CHECKED BY USE: the observer watches whether a submitted code Ferretry made went through, and keeps that on the key
   * (it orders the buttons; it grants nothing). One that did not opens the request again for a typed code. Total.
   */
  private async checkCode(
    held: Held,
    typed: {
      readonly account: AccountId;
      readonly factor: TwoFactorId;
      readonly facts: InputTargetFacts;
      readonly deliveredAt: number;
    },
  ): Promise<void> {
    const check = this.deps.observer?.codeTyped;
    if (check === undefined) return;
    const { request } = held;
    try {
      const worked = await check.call(this.deps.observer, {
        sessionId: request.sessionId,
        account: typed.account,
        factor: typed.factor,
        target: request.target,
        facts: typed.facts,
        surfaces: [...held.names],
        deliveredAt: typed.deliveredAt,
      });
      if (worked === false) await this.reopen(held);
    } catch {
      // A check not made is a check not made: the code was typed either way.
    }
  }

  /**
   * A CODE FERRETRY MADE DID NOT GO THROUGH (the page stayed, the same prompt came back): the request is OPEN again, on
   * a new card that says so, for the owner to type the code. Only a card of one-time codes, only while nothing else
   * waits on that target and the target is still there; otherwise the ferret is told and nothing is raised.
   */
  private async reopen(held: Held): Promise<void> {
    const { sessionId } = held.request;
    await this.lock.run(sessionId, async () => {
      const { request } = held;
      if (request.state !== 'delivered' || (await this.deps.sessions.ended(sessionId))) return;
      const before = request.agendaItemId;
      const tell = async (message: string): Promise<void> => await this.deps.notifier.tell(sessionId, before, message);
      const where = `%${request.target.kind}:${request.target.key}`;
      const cannot = `${before}: the code Ferretry made did not go through on ${where}. Read it, and if it still asks for a code, raise a fresh ${request.target.kind}_request_input.`;
      const busy = [...this.held.values()].some(
        other =>
          other !== held &&
          other.request.sessionId === sessionId &&
          !isFinal(other.request) &&
          other.request.target.kind === request.target.kind &&
          other.request.target.key === request.target.key,
      );
      if (busy || !request.fields.every(field => fillRoleFor(field.sensitivity) === 'totp')) return await tell(cannot);
      const seen = await this.deps.target.observe(sessionId, request.target, request.fields.map(pointerOf));
      if (!seen.ok) return await tell(cannot);
      const now = this.deps.clock.now();
      const expiresAt = instant(now + INPUT_DEFAULT_EXPIRY_SECONDS * 1000);
      const names = [...new Set([...held.names, request.target.key, ...(seen.names ?? [])])];
      const fields = observedAs(request.fields, seen.facts, held.upgraded, request.prompt, seen.codeProgram === true);
      const shown = await this.project(sessionId, seen.facts, names);
      const shot =
        seen.facts.kind === 'browser'
          ? await this.deps.target.shoot?.(sessionId, request.target, seen.facts).catch(() => undefined)
          : undefined;
      this.raising.set(request.id, { sessionId, subject: 'one-time-code' });
      const card = await this.deps.agenda
        .raise(sessionId, {
          requestId: request.id,
          title: held.title ?? titleOf(fields),
          ask: `${CODE_DID_NOT_GO_THROUGH} ${askOf(shown, fields)}`,
          prompt: request.prompt,
          blocking: true,
          expiresAt,
          ...(request.chain === undefined ? {} : { chain: request.chain }),
        })
        .finally(() => this.raising.delete(request.id));
      if (!card.ok) return await tell(cannot);
      const { outcome: _outcome, ...rest } = request;
      held.formerCards.push(before);
      held.names = names;
      held.checkFailures = 0;
      held.rebinds = 0;
      held.binding = bindingOf(seen.facts);
      held.probed = false;
      rekey(held, targetMatchKey(seen.facts, this.deps.hostName ?? ''));
      if (seen.facts.kind === 'browser') held.raisedOn = seen.facts.navigationId;
      if (shot === undefined) delete held.shot;
      else held.shot = shot;
      held.request = {
        ...rest,
        agendaItemId: card.id,
        state: 'pending',
        raisedAt: instant(now),
        expiresAt,
        fields,
        sensitivity: strongestSensitivity(fields),
        observed: shown,
        risk: worstRisk(fields.map(field => field.risk)),
        observedDigest: digestFacts(seen.facts),
        ...(shot === undefined ? {} : { pictured: true as const }),
      };
      await this.journalQuietly(held.request, 'requested');
      await this.record(held.request, 'input.requested', { kind: 'daemon' }, this.auditOf(held.request));
      await tell(
        `${before}: the code Ferretry made did not go through on ${where}, so the owner is asked to type it on ${card.id}. Wait on ${card.id}.`,
      );
    });
  }

  /** Where a request's value goes, for a route that gates by destination: names only, never a value. */
  targetOf(sessionId: string, requestId: string): InputRequest['target'] | undefined {
    const held = this.held.get(requestId);
    return held === undefined || held.request.sessionId !== sessionId ? undefined : held.request.target;
  }

  /** The owner declines. Owner only, before anything is read or changed. Only a pending request can be cancelled. */
  async cancel(sessionId: string, requestId: string, caller: InputCaller): Promise<InputRequest> {
    const owner = requireOwner(caller);
    await this.sweep();
    const held = this.held.get(requestId);
    if (held === undefined || held.request.sessionId !== sessionId)
      throw new InputRequestError('not_found', 'no such input request');
    if (isFinal(held.request)) throw new InputRequestError('gone', `the request is already ${held.request.state}`);
    if (held.request.state === 'delivering')
      throw new InputRequestError('conflict', 'the value is being typed now', INPUT_ERROR_CODES.alreadyDelivered);
    await this.finish(held, 'cancelled', 'owner_declined', owner, { closeCard: true, tellAgent: true });
    return this.sealed(held, await this.exposed(held));
  }

  /** The owner dismissed the card without answering: the request ends, and the card is already closed. */
  async cardDismissed(sessionId: string, id: AgendaId): Promise<void> {
    const held = this.byCard(sessionId, id);
    // Only the card the request is on now: a card it was on before is closed already, and says nothing of this one.
    if (held === undefined || held.request.state !== 'pending' || held.request.agendaItemId !== id) return;
    await this.finish(held, 'cancelled', 'owner_declined', undefined, { closeCard: false, tellAgent: true });
  }

  /**
   * A session ended: whatever it was holding for redaction is let go, and a request still waiting on its
   * owner ends as interrupted, because the agent that asked is gone.
   */
  async sessionEnded(sessionId: string): Promise<void> {
    this.deps.values.drop(sessionId);
    this.deps.quarantine.drop(sessionId);
    for (const held of [...this.held.values()]) {
      if (held.request.sessionId === sessionId && held.request.state === 'pending')
        await this.finish(held, 'cancelled', 'interrupted', undefined, { closeCard: true, tellAgent: false });
    }
  }

  /** Expire every pending request whose time has passed. Cheap; called before every read and by a timer. */
  async sweep(): Promise<void> {
    this.deps.values.purge();
    for (const sessionId of this.deps.values.sessions()) {
      if (await this.deps.sessions.ended(sessionId)) await this.sessionEnded(sessionId);
    }
    const now = this.deps.clock.now();
    for (const held of [...this.held.values()]) {
      if (held.request.state === 'pending' && Date.parse(held.request.expiresAt) <= now)
        await this.finish(held, 'expired', 'expired', undefined, { closeCard: true, tellAgent: true });
    }
  }

  /**
   * Bring pending requests back after a restart from the session journals, and re-observe each target. A
   * request whose session or terminal is gone ends as `interrupted`; `observed` stays empty until the daemon
   * has seen the target again, so Send is disabled until then.
   */
  async restore(): Promise<void> {
    const now = this.deps.clock.now();
    const sessionIds = await this.deps.sessions.all().catch((error: unknown) => {
      this.deps.quarantine.lock(now + QUARANTINE_MS);
      throw error;
    });
    // Every quarantine comes back before any request does, and before any reader is let in: a slow
    // observation of one request must not leave a held terminal open, and a journal that cannot be read
    // holds that session's terminals instead.
    const unresolved: QuarantineHold[] = [];
    for (const sessionId of sessionIds) {
      unresolved.push(
        ...(await this.restoreQuarantines(sessionId, now).catch(() => {
          this.deps.quarantine.lockSession(sessionId);
          return [];
        })),
      );
    }
    // A hold that was unresolved when the daemon stopped (a write may have landed) runs a full window from now.
    // Only the holds THIS replay brought back: a delivery admitted while it ran owns its hold and settles it itself.
    const settled = unresolved.map(hold => ({ hold, until: this.deps.quarantine.settle(hold) }));
    this.deps.quarantine.unlock();
    for (const { hold, until } of settled)
      await this.journalHold(hold, INPUT_QUARANTINE_EVENT_TYPES.started, until).catch(() => undefined);
    for (const sessionId of sessionIds) {
      const latest = new Map<string, InputEvent>();
      for (const event of await this.deps.journal.history(sessionId)) {
        if (event.sessionId === sessionId) latest.set(event.requestId, event);
      }
      for (const event of latest.values()) await this.revive(event, now);
    }
  }

  /**
   * Every hold the journal still has comes back with all of its names: a hold's last word decides it, so a
   * finished request can never erase one. Holds that were unresolved come back unresolved.
   */
  private async restoreQuarantines(sessionId: string, now: number): Promise<readonly QuarantineHold[]> {
    const holds = new Map<string, { readonly names: readonly string[]; readonly until: number | 'in-flight' }>();
    for (const event of await this.deps.journal.quarantines(sessionId)) {
      if (event.sessionId !== sessionId) continue;
      if (event.type === INPUT_QUARANTINE_EVENT_TYPES.started)
        holds.set(event.hold, {
          names: event.names,
          until: event.unresolved === true ? 'in-flight' : Date.parse(event.until),
        });
      else holds.delete(event.hold);
    }
    const unresolved: QuarantineHold[] = [];
    for (const [id, { names, until }] of holds) {
      if (until !== 'in-flight' && until <= now) continue;
      const hold = this.deps.quarantine.restore(sessionId, names, until, id);
      if (hold !== undefined && until === 'in-flight') unresolved.push(hold);
    }
    return unresolved;
  }

  /** The terminals of a session kept from an agent's eyes now, for the owner's viewer. Owner only. */
  quarantines(caller: InputCaller, sessionId: string): readonly InputQuarantine[] {
    requireOwner(caller);
    return this.deps.quarantine
      .list(sessionId)
      .filter(({ key }) => !key.startsWith(PAGE_MARK))
      .map(({ key, until }) => ({ key, until: instant(until) }));
  }

  /**
   * A page the daemon just typed a secret into, as an agent's read of it must see it: when the hold ends, and the
   * documents the values went into. A page that has since moved to another document may be READ again (the text
   * is masked for the redaction window), but not pictured until the hold ends.
   */
  pageHeld(
    sessionId: string,
    names: readonly (string | undefined)[],
  ): { readonly until: number; readonly documents: readonly string[] } | undefined {
    const marked = names.filter((name): name is string => name !== undefined).map(pageName);
    const until = this.deps.quarantine.until(sessionId, marked);
    if (until === undefined) return undefined;
    const documents = [...this.held.values()]
      .filter(
        held =>
          held.request.sessionId === sessionId &&
          held.request.target.kind === 'browser' &&
          held.navigation !== undefined &&
          held.names.some(name => marked.includes(pageName(name))),
      )
      .map(held => held.navigation as string);
    return { until, documents };
  }

  /** The document a session's page shows now, so a held page can be read again once it has moved on. */
  async pageDocument(sessionId: string, key: string): Promise<string | undefined> {
    return await this.deps.target.document?.(sessionId, key).catch(() => undefined);
  }

  /** The picture of a page request's fields for the owner's card, while it waits. Owner only; never the agent's. */
  shot(caller: InputCaller, sessionId: string, requestId: string): InputShot {
    requireOwner(caller);
    const held = this.held.get(requestId);
    if (held === undefined || held.request.sessionId !== sessionId || held.request.state !== 'pending')
      throw new InputRequestError('not_found', 'no picture for that input request');
    if (held.shot === undefined) throw new InputRequestError('not_found', 'Ferretry has no picture of this target');
    return held.shot;
  }

  /** When a terminal's quarantine ends, for a reader that must refuse until then. */
  quarantinedUntil(sessionId: string, names: readonly (string | undefined)[]): number | undefined {
    return this.deps.quarantine.until(sessionId, names);
  }

  /** The owner opens a quarantined terminal to the agent again. Owner only; it is recorded and journalled. */
  async endQuarantine(caller: InputCaller, sessionId: string, key: string): Promise<void> {
    const owner = requireOwner(caller);
    const released = this.deps.quarantine.end(sessionId, key);
    if (released === undefined) throw new InputRequestError('not_found', `${key} is not quarantined`);
    for (const hold of released)
      await this.journalHold(hold, INPUT_QUARANTINE_EVENT_TYPES.ended, this.deps.clock.now()).catch(() => undefined);
    await this.deps.audit
      .record({
        event: 'input.quarantine_ended',
        sessionId,
        actor: owner,
        detail: { targetKind: 'terminal', sensitivity: 'secret', surface: key },
      })
      .catch(() => undefined);
  }

  /** The owner's viewer chose to see a quarantined terminal anyway: recorded as that one viewer's act. */
  async revealed(caller: InputCaller, sessionId: string, key: string): Promise<void> {
    const owner = requireOwner(caller);
    await this.deps.audit
      .record({
        event: 'input.quarantine_revealed',
        sessionId,
        actor: owner,
        detail: { targetKind: 'terminal', sensitivity: 'secret', surface: key },
      })
      .catch(() => {
        throw new InputRequestError(
          'unavailable',
          'Ferretry could not record that you chose to see this terminal, so it did not show it',
        );
      });
  }

  private async revive(event: InputEvent, now: number): Promise<void> {
    if (event.type === INPUT_JOURNAL_EVENT_TYPES.delivering) return await this.interrupt(event);
    if (event.type !== INPUT_JOURNAL_EVENT_TYPES.requested || event.expiresAt === undefined) return;
    if (Date.parse(event.expiresAt) <= now) return;
    const prompt = await this.deps.agenda.promptOf(event.sessionId, event.agendaItemId);
    if (prompt === undefined || this.held.has(event.requestId)) return;
    const target: InputTarget = { kind: event.target.kind, key: event.target.key };
    const request: InputRequest = {
      id: event.requestId,
      sessionId: event.sessionId,
      agendaItemId: event.agendaItemId,
      target,
      prompt,
      sensitivity: event.sensitivity,
      fields: [restoredField(event.sensitivity)],
      submit: event.submit ?? 'offer-owner',
      raisedAt: event.at,
      expiresAt: event.expiresAt,
      state: 'pending',
    };
    const held: Held = {
      request,
      names: [target.key],
      checkFailures: 0,
      rebinds: 0,
      formerCards: [],
      deliveries: new Map(),
      waiters: new Set(),
      upgraded: new Set(),
    };
    this.held.set(request.id, held);
    // A paste's copy lived in the memory of the daemon that stopped: it is gone, so the paste is too.
    if (event.sealed !== undefined) {
      await this.finish(held, 'cancelled', 'copy_gone', undefined, { closeCard: true, tellAgent: true });
      return;
    }
    // A page's fields are named by elements the journal does not keep (they are the agent's words), and a page
    // rarely outlives the daemon: its card ends, and the agent raises it again if it still needs the values.
    if (target.kind === 'browser') {
      await this.finish(held, 'cancelled', 'interrupted', undefined, { closeCard: true, tellAgent: true });
      return;
    }
    const seen = await this.deps.target.observe(request.sessionId, target, request.fields.map(pointerOf));
    if (!seen.ok) {
      await this.finish(held, 'cancelled', 'interrupted', undefined, { closeCard: true, tellAgent: true });
      return;
    }
    held.names = [target.key, ...(seen.names ?? [])];
    held.binding = bindingOf(seen.facts);
    // Always the key of what was seen NOW: a prompt that left line mode (or a page that names no key) keeps no one-tap.
    rekey(held, targetMatchKey(seen.facts, this.deps.hostName ?? ''));
    const fields = observedAs(request.fields, seen.facts, held.upgraded, request.prompt, seen.codeProgram === true);
    held.request = {
      ...request,
      fields,
      sensitivity: strongestSensitivity(fields),
      observed: await this.project(request.sessionId, seen.facts, held.names),
      risk: worstRisk(fields.map(field => field.risk)),
      observedDigest: digestFacts(seen.facts),
    };
  }

  /** A write was begun and never recorded as done: it may have landed, so the request ends and never types again. */
  private async interrupt(event: InputEvent): Promise<void> {
    if (this.held.has(event.requestId)) return;
    const prompt = (await this.deps.agenda.promptOf(event.sessionId, event.agendaItemId)) ?? 'input request';
    const request: InputRequest = {
      id: event.requestId,
      sessionId: event.sessionId,
      agendaItemId: event.agendaItemId,
      target: { kind: event.target.kind, key: event.target.key },
      prompt,
      sensitivity: event.sensitivity,
      fields: [restoredField(event.sensitivity)],
      submit: event.submit ?? 'offer-owner',
      raisedAt: event.at,
      expiresAt: event.expiresAt ?? event.at,
      state: 'delivering',
    };
    const held: Held = {
      request,
      names: [request.target.key],
      checkFailures: 0,
      rebinds: 0,
      formerCards: [],
      deliveries: new Map(),
      waiters: new Set(),
      upgraded: new Set(),
    };
    this.held.set(request.id, held);
    await this.finish(held, 'refused', 'interrupted', undefined, { closeCard: true, tellAgent: true, uncertain: true });
  }

  private guardRate(sessionId: string, target: InputTarget, now: number): void {
    const open = [...this.held.values()].filter(h => h.request.sessionId === sessionId && !isFinal(h.request));
    if (open.length >= INPUT_MAX_PENDING_PER_SESSION)
      throw new InputRequestError(
        'capacity',
        `${INPUT_MAX_PENDING_PER_SESSION} input requests are already waiting on the owner; wait for one to be answered`,
        INPUT_ERROR_CODES.rateLimited,
      );
    const recent = (this.raises.get(sessionId) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= INPUT_MAX_RAISES_PER_HOUR)
      throw new InputRequestError(
        'capacity',
        `this session has raised ${INPUT_MAX_RAISES_PER_HOUR} input requests in the last hour; try again later`,
        INPUT_ERROR_CODES.rateLimited,
      );
    if (open.some(h => h.request.target.kind === target.kind && h.request.target.key === target.key))
      throw new InputRequestError('conflict', `an input request is already waiting on ${target.key}`);
  }

  private noteRaise(sessionId: string, now: number): void {
    this.raises.set(sessionId, [...(this.raises.get(sessionId) ?? []).filter(at => at > now - HOUR_MS), now]);
  }

  private guardDeliverable(held: Held): void {
    const { state } = held.request;
    if (state === 'delivering' || state === 'delivered')
      throw new InputRequestError(
        'conflict',
        'this request was already answered with another delivery',
        INPUT_ERROR_CODES.alreadyDelivered,
      );
    if (state !== 'pending') throw new InputRequestError('gone', `the request is ${state}`, INPUT_ERROR_CODES.gone);
    if (held.request.observed === undefined)
      throw new InputRequestError('unavailable', 'Ferretry is looking at the target again; try Send in a moment');
  }

  private async attempt(
    held: Held,
    body: InputDeliverBody,
    by: InputActor,
    /** Told what the one write came to, the moment it returns: a caller that must know whether a value may be in the target. */
    wrote?: (typed: TypeResult) => void,
    /** A fill under a task-plan line: the grant is matched again on the facts looked at, and a page password is cleared later. */
    grant?: GrantWrite,
  ): Promise<InputDeliverResult> {
    const { request } = held;
    held.request = { ...request, state: 'delivering' };
    // A write begins: the lock the ferret reads is the one this write works out (a grant fill's own is hidden by agentSees).
    delete held.agentLock;
    let hold: QuarantineHold | undefined;
    try {
      const pasted = request.source?.name;
      if (pasted !== undefined && body.sealed !== true)
        throw new InputRequestError(
          'bad_request',
          `this card pastes ${copyHandle(pasted)}: allow it, there is nothing to type`,
        );
      if (pasted === undefined && body.sealed === true)
        throw new InputRequestError('bad_request', 'this card pastes no secure copy; type the value instead');
      const typed = pasted === undefined ? typedValues(request, body) : new Map<string, string>();
      if (body.entry !== undefined && this.deps.logins === undefined)
        throw new InputRequestError('bad_request', 'this daemon keeps no saved logins; type the value instead');
      const kept = body.save === undefined ? undefined : this.guardSave(request, typed);
      // The owner's card is older than the request (it was redrawn since): nothing is wrong with the target, so
      // nothing is counted; the card reads the request again and the owner checks it before sending.
      if (body.observedDigest !== request.observedDigest) throw targetRebound(request.target.kind);
      // The fields a saved account fills with a one-time code the DAEMON makes from one of its 2FA keys.
      const codeFields =
        body.entry === undefined
          ? []
          : request.fields.filter(field => !typed.has(field.id) && fillRoleFor(field.sensitivity) === 'totp');
      if (body.factor !== undefined && codeFields.length === 0)
        throw new InputRequestError(
          'bad_request',
          'this card has no code field for a 2FA key to fill: type the value instead. Nothing was typed',
        );
      // A saved account is typed only as the card offers it NOW, and the tapped sign-in must be its offer's: the rules of
      // the card are the daemon's, not only the app's list. Checked before anything is opened or typed.
      const factor =
        body.entry === undefined
          ? undefined
          : await this.guardOffered(held, body.entry, body.signIn, typed, codeFields.length > 0, body.factor);
      const submitted = body.submit && request.submit !== 'agent';
      const looked = await this.deps.target.observe(request.sessionId, request.target, request.fields.map(pointerOf));
      const seen =
        looked.ok && digestFacts(looked.facts) === request.observedDigest ? looked : await this.lookAgain(held, looked);
      if (codeFields.length > 0) this.guardCodeTarget(held, seen, codeFields);
      // A fill under a grant: every check holds again on what was just seen, before anything is opened or typed.
      await grant?.recheck(seen);
      // A secure copy is opened HERE, like a saved value: after every check that can refuse without typing, and only to be typed.
      if (pasted !== undefined)
        typed.set((request.fields[0] as InputRequestField).id, await this.openCopy(held, pasted));
      // A saved value is opened HERE, inside the use boundary, after every check that can refuse without
      // typing, and only to be typed: it is in no request, event, audit entry, result or error.
      const values: InputFieldValue[] = [];
      for (const field of request.fields) {
        const text = typed.get(field.id) ?? (await this.fill(field, body.entry as LoginEntryId, factor));
        values.push({ field: field.id, text });
      }
      held.names = [...new Set([...held.names, request.target.key, ...(seen.names ?? [])])];
      if (seen.facts.kind === 'browser') held.navigation = seen.facts.navigationId;
      // Checked again at the write, AFTER any saved value was opened (so a saved login still fills the role the owner
      // chose): a code field now going into a password is held, masked and recorded as a secret. Never back.
      const fields = observedAs(request.fields, seen.facts, held.upgraded, request.prompt, seen.codeProgram === true);
      held.request = { ...held.request, fields, sensitivity: strongestSensitivity(fields) };
      // The secret store is no surface anybody reads, so there is nothing to hold from view. The lock is looked at
      // again from the facts just seen, and the longer of that and the card's is kept: a card never shortens.
      if (heldFromView(fields) && request.target.kind !== 'secret') {
        // At the write, any act of the ferret on a page since the card was raised voids a page's proof as well.
        const now = lockFor(seen.facts, fields, {
          observed: await this.observedFacts(seen.facts),
          probed: held.probed === true,
          submitted,
          steered: this.tainted(request.sessionId, Date.parse(request.raisedAt)),
        });
        const lock = request.lock === undefined ? now : longerLock(request.lock, now);
        held.request = { ...held.request, lock };
        // A grant fill asks whether it still holds BEFORE the page is held from the ferret (delta F3): a refusal a ferret
        // can cause (a script it starts, say) lands before anything it can read changes.
        if (grant !== undefined && !grant.held()) throw new GrantMissed('expired');
        hold = await this.holdFor(request, held.names, lock.seconds * 1000);
      }
      try {
        await this.journal(held.request, 'delivering', undefined, undefined, body.deliveryId);
      } catch {
        await this.letGo(hold);
        hold = undefined;
        throw new InputRequestError('unavailable', 'Ferretry could not record the attempt, so nothing was typed');
      }
      // A grant fill that types a password into a page has its fields emptied on `pagehide` (armed before the write) and
      // checked before the hold ends.
      const clear =
        grant === undefined
          ? undefined
          : clearJobOf(
              seen.facts,
              fields.filter(field => field.sensitivity === 'secret').map(field => field.id),
            );
      // Every value that is masked is held before it is typed, so a read racing the write already hides it.
      for (const [index, field] of fields.entries())
        if (maskedFromReads(field, typed))
          this.deps.values.hold(request.sessionId, (values[index] as InputFieldValue).text, request.agendaItemId);
      // A grant fill types only while its line is still held: a revoke, an expiry or a stop since the last look ends it
      // here, with nothing awaited between this check and the write.
      if (grant !== undefined && !grant.held()) {
        await this.letGo(hold);
        hold = undefined;
        await this.journalQuietly({ ...held.request, state: 'pending' }, 'requested');
        throw new GrantMissed('expired');
      }
      const outcome: TypeResult = await this.deps.target
        .type(request.sessionId, request.target, values, submitted, seen.facts, {
          // A code left visible on the strength of a proven code program is typed only while one still holds it.
          codeProgram: seen.codeProgram === true && fields.some(field => field.sensitivity === 'code'),
          ...(by.kind === 'rule' && held.pastedInto !== undefined ? { profileProgram: held.pastedInto } : {}),
          ...(clear === undefined ? {} : { armClear: true }),
          // Asked again inside the target's own turn: a write that waited in the page's queue may find the line gone.
          ...(grant === undefined ? {} : { proceed: () => grant.held() }),
        })
        .catch((): TypeResult => 'uncertain');
      wrote?.(outcome);
      // Taken before anything else is awaited: what the ferret does after this counts against a sign-in's facts.
      const deliveredAt = this.deps.clock.now();
      const stored = async (uncertain: boolean): Promise<void> => {
        if (seen.facts.kind !== 'secret') return;
        await this.deps.audit
          .stored({
            sessionId: request.sessionId,
            requestId: request.id,
            actor: by,
            name: seen.facts.name,
            replaced: seen.facts.exists,
            ...(uncertain ? { uncertain: true as const } : {}),
          })
          .catch(() => undefined);
      };
      if (outcome === 'uncertain') {
        await this.settle(hold);
        hold = undefined;
        // A grant fill's password may have landed (secrev-1282b F2): it gets the same clear, and the clear's own hold for
        // the full window, as a typed one, and the grant stops (`did-not-move-on`): the sign-in did not go as approved.
        if (grant !== undefined) {
          if (clear !== undefined)
            grant.typed(
              clear,
              (held.request.lock?.seconds ?? INPUT_QUARANTINE_SECONDS) * 1000,
              holdNames(request, held.names),
            );
          await grant.uncertain();
        }
        await stored(true);
        await this.finish(held, 'refused', 'interrupted', undefined, {
          closeCard: true,
          tellAgent: true,
          uncertain: true,
        });
        throw new InputRequestError(
          'unavailable',
          `Ferretry could not confirm the value was typed cleanly, so it stopped and will not type it again; check the ${surfaceWord(request.target.kind)}`,
        );
      }
      if (outcome === 'target_changed' && grant !== undefined && !grant.held()) {
        // The target refused because the line ended while the write waited its turn: nothing was typed, and nothing is
        // wrong with the target, so no check is counted. The card is the owner's.
        await this.letGo(hold);
        hold = undefined;
        await this.journalQuietly({ ...held.request, state: 'pending' }, 'requested');
        throw new GrantMissed('expired');
      }
      if (outcome !== 'typed') {
        await this.letGo(hold);
        hold = undefined;
        await this.journalQuietly({ ...held.request, state: 'pending' }, 'requested');
        // Nothing was typed: the target changed between the last look and the write. The same target found
        // again redraws the card; it is never typed into within this Send.
        const gone: ObserveResult = { ok: false, reason: 'target_gone' };
        return await this.redrawOrRefuse(held, await this.refound(held, gone), outcome);
      }
      await this.settle(hold);
      hold = undefined;
      if (clear !== undefined)
        grant?.typed(
          clear,
          (held.request.lock?.seconds ?? INPUT_QUARANTINE_SECONDS) * 1000,
          holdNames(request, held.names),
        );
      if (pasted !== undefined) this.deps.sealed?.used(request.sessionId, pasted);
      await stored(false);
      const saved =
        body.save === undefined || kept === undefined ? undefined : await this.save(held, body.save, kept, by);
      // Not awaited: the facts are looked for after the submit, and nothing about them may hold up or fail the Send.
      void this.observeLogin(
        held,
        seen.facts,
        values,
        submitted,
        deliveredAt,
        body.entry ?? (saved?.ok === true ? body.save?.entry : undefined),
        body.signIn,
        // EXHAUSTIVE, no default (secrev-1271 L1a): a new actor kind fails typecheck in observerByOf until it is mapped,
        // instead of reaching the observer as the owner's own tap and qualifying a sign-in for a standing rule.
        observerByOf(by),
      );
      const made = codeFields.length > 0 && factor !== undefined ? factor : undefined;
      await this.finish(held, 'delivered', undefined, by, {
        closeCard: true,
        tellAgent: true,
        submitted,
        ...(pasted === undefined ? {} : { sealed: true }),
        ...(body.entry === undefined ? {} : { entry: body.entry }),
        ...(saved === undefined ? {} : { saved: saved.ok }),
        ...(made === undefined ? {} : { factor: made }),
        ...((by.kind === 'plan' || by.kind === 'sign-in-rule') && body.signIn !== undefined
          ? { signIn: body.signIn }
          : {}),
      });
      // Not awaited either: whether a code Ferretry made went through is seen after the submit, by the observer.
      if (made !== undefined && submitted)
        void this.checkCode(held, {
          account: body.entry as AccountId,
          factor: made,
          facts: seen.facts,
          deliveredAt,
        });
      return {
        id: request.id,
        deliveryId: body.deliveryId,
        state: 'delivered',
        submitted,
        ...(saved === undefined ? {} : { saved }),
      };
    } catch (error) {
      // A hold still open here is for a write that may have started: it runs its window rather than lifting.
      await this.settle(hold);
      if (held.request.state === 'delivering') held.request = { ...held.request, state: 'pending' };
      throw error;
    }
  }

  /**
   * "Save as" is checked before anything is typed, so a save that could never happen refuses the whole
   * Send with nothing typed rather than typing and then failing to keep it.
   */
  private guardSave(request: InputRequest, typed: ReadonlyMap<string, string>): LoginFieldValues {
    if (this.deps.logins === undefined)
      throw new InputRequestError('bad_request', 'this daemon keeps no saved logins; send without saving');
    const roles = savedRolesOf(request.fields);
    if (roles === undefined)
      throw new InputRequestError(
        'bad_request',
        request.fields.every(field => field.sensitivity === 'private' || field.sensitivity === 'code')
          ? 'a one-time code is not saved; add the 2FA seed to a saved login in Settings instead'
          : 'this card cannot be kept as one saved login (it has two usernames or two passwords); send without saving',
      );
    const kept: { username?: string; password?: string } = {};
    for (const [id, role] of roles) {
      const value = typed.get(id);
      if (value === undefined)
        throw new InputRequestError(
          'bad_request',
          'Save as keeps the values you typed: type every field it keeps, or send without saving',
        );
      if (role === 'password' && [...value].length < LOGIN_PASSWORD_MIN_LENGTH)
        throw new InputRequestError(
          'bad_request',
          `a saved password is at least ${LOGIN_PASSWORD_MIN_LENGTH} characters, so it can be masked safely; send it without saving`,
        );
      if (
        role === 'username' &&
        (value.trim() === '' || value.length > LOGIN_USERNAME_MAX_LENGTH || /\p{Cc}/u.test(value))
      )
        throw new InputRequestError('bad_request', 'that value cannot be kept as a username; send it without saving');
      kept[role] = value;
    }
    return kept;
  }

  /**
   * Hands a landed delivery to the login observer: the facts the card was drawn from, the fields, the values that
   * were not plain (for the observer's own yes-or-no echo look; they are already held in the redaction window) and
   * the account typed or kept and the SIGN-IN its facts go to: the one the owner tapped (already checked to be the
   * account's), else the account's sign-in the daemon matched to this target, else none (picked by hand elsewhere: no
   * fact is kept). Total.
   */
  private async observeLogin(
    held: Held,
    facts: InputTargetFacts,
    values: readonly InputFieldValue[],
    submitted: boolean,
    deliveredAt: number,
    login: LoginEntryId | undefined,
    tapped: SignInId | undefined,
    filledBy: LoginDelivery['by'],
  ): Promise<void> {
    const observer = this.deps.observer;
    const { request } = held;
    if (observer === undefined || request.target.kind === 'secret' || request.source !== undefined) return;
    try {
      const listing = login === undefined ? undefined : await this.deps.logins?.listing();
      const account = listing?.accounts.find(each => each.id === login);
      const signIn =
        listing === undefined || account === undefined
          ? undefined
          : tapped === undefined
            ? signInOfAt(account.id, held.matchKey, listing)
            : listing.signIns.find(each => each.id === tapped && each.account === account.id);
      const secrets = request.fields
        .map((field, index) => (field.sensitivity === 'plain' ? undefined : values[index]?.text))
        .filter((text): text is string => text !== undefined);
      await observer.delivered({
        sessionId: request.sessionId,
        ...(account === undefined ? {} : { login: account.id }),
        ...(signIn === undefined ? {} : { signIn: signIn.id }),
        domains: signIn?.place.kind === 'site' ? placeKeys(signIn.place) : [],
        target: request.target,
        facts,
        fields: request.fields,
        secrets,
        submitted,
        ...(held.matchKey === undefined ? {} : { matchKey: held.matchKey }),
        surfaces: [...held.names],
        since: Date.parse(request.raisedAt),
        deliveredAt,
        by: filledBy,
      });
    } catch {
      // A fact not kept is a fact not kept: the delivery already happened.
    }
  }

  /**
   * Whether the ferret could have steered a page: it ran a page script in this session, or drove a page since `since`.
   * With no observer wired nothing is known, so every page counts as steered (the lock stays long).
   */
  private tainted(sessionId: string, since: number): boolean {
    return this.deps.observer?.tainted(sessionId, 'browser', since) ?? true;
  }

  /**
   * The facts the lock may read for this target: the UNION of every sign-in the daemon matched to it, of any account
   * (each keeps its own, so two accounts on one host are two sets read together). None when the store cannot be read
   * or nothing matches (the lock stays long).
   */
  private async observedFacts(facts: InputTargetFacts): Promise<readonly LoginObserved[]> {
    const listing = await this.deps.logins?.listing().catch(() => undefined);
    if (listing === undefined) return [];
    return signInsAt(targetMatchKey(facts, this.deps.hostName ?? ''), listing).flatMap(signIn => signIn.observed ?? []);
  }

  /**
   * A deliver that types from a saved account types only what the card would offer NOW, drawn by the same
   * `savedForFields` over the fields the owner did not type: never a 2FA code from an account that does not sign in here,
   * nothing by hand on a page a sign-in reaches through a provider, never a provider where it is not matched. A
   * `signIn` must be one of `entry`'s account (the same refusal whether it is another account's or none at all), and
   * the one the daemon matched here for that offer: the one tap is that sign-in's, and the facts of the write go to it.
   */
  private async guardOffered(
    held: Held,
    entry: LoginEntryId,
    signIn: SignInId | undefined,
    typed: ReadonlyMap<string, string>,
    makesCode: boolean,
    factor: TwoFactorId | undefined,
  ): Promise<TwoFactorId | undefined> {
    const listing = await this.deps.logins?.listing().catch(() => undefined);
    if (listing === undefined)
      throw new InputRequestError('unavailable', 'Ferretry could not read the saved accounts, so nothing was typed');
    if (!listing.accounts.some(account => account.id === entry))
      throw new InputRequestError('not_found', `there is no saved login ${entry}; nothing was typed`);
    if (signIn !== undefined && listing.signIns.find(each => each.id === signIn)?.account !== entry)
      throw new InputRequestError('bad_request', `that sign-in is not one of ${entry}; nothing was typed`);
    // At least one: an `entry` with every field typed was already refused (`typedValues`).
    const filled = held.request.fields.filter(field => !typed.has(field.id));
    const offer = savedForFields(filled, held.matchKey, listing, {
      ...(await this.choiceOf(held.request.sessionId)),
      hint: held.hint,
      codesHere: codesHere(held.request.observed, filled),
    }).offers.find(each => each.id === entry);
    if (offer === undefined)
      throw new InputRequestError('bad_request', `${entry} is not offered for this target; nothing was typed`);
    if (signIn !== undefined && offer.signIn !== signIn)
      throw new InputRequestError(
        'bad_request',
        `that sign-in of ${entry} is not the one that signs in here; nothing was typed`,
      );
    if (!makesCode) return undefined;
    // The key a code is made from is one of THIS offer's buttons: the matched account's, holding a seed. Absent, the
    // first button, which is the key the vault would choose: named here so the code and its check are about one key.
    const keys = offer.codes ?? [];
    if (factor !== undefined && !keys.some(key => key.factor === factor))
      throw new InputRequestError(
        'bad_request',
        `that 2FA key is not one ${entry} makes codes from for this target; nothing was typed`,
      );
    return factor ?? keys[0]?.factor;
  }

  /**
   * At the write: a code the DAEMON makes never goes into a field that now looks like a password (R0b's upgrade wins:
   * that field is a secret from now on, and a code is not what it asks for). Refused before anything is opened, with
   * nothing typed. Where it may go ({@link codeTargetProblem}) was checked by {@link guardOffered} on the card's facts,
   * and `seen` is those very facts (the digest compare, or a look again that found them), so it holds here too; only
   * whether a code program reads the prompt is seen afresh, and that is what this checks.
   */
  private guardCodeTarget(
    held: Held,
    seen: Extract<ObserveResult, { readonly ok: true }>,
    codeFields: readonly InputRequestField[],
  ): void {
    const { request } = held;
    const now = observedAs(request.fields, seen.facts, held.upgraded, request.prompt, seen.codeProgram === true);
    if (codeFields.some(field => now.find(each => each.id === field.id)?.sensitivity === 'secret')) {
      held.request = { ...held.request, fields: now, sensitivity: strongestSensitivity(now) };
      throw new InputRequestError(
        'bad_request',
        'that field now looks like a password field, and Ferretry never types a code it made into one: type the value yourself. Nothing was typed',
      );
    }
  }

  /** The value a saved login types for one field. Refuses with the entry's name, never its value. */
  /**
   * The value of the copy a paste names, opened only to be typed. A copy that ended since the card was raised ends
   * the request: it can never be pasted now. One with a line break or a control character would press keys.
   */
  private async openCopy(held: Held, name: string): Promise<string> {
    const value = this.deps.sealed?.open(held.request.sessionId, name);
    if (value === undefined) {
      await this.finish(held, 'cancelled', 'copy_gone', undefined, { closeCard: true, tellAgent: true });
      throw new InputRequestError(
        'gone',
        `${copyHandle(name)} was discarded or expired, so there is nothing to paste`,
        INPUT_ERROR_CODES.gone,
      );
    }
    if (inputValueProblem(value, 'secret') !== undefined)
      throw new InputRequestError(
        'bad_request',
        `${copyHandle(name)} holds a line break or a control character, which would press keys; it cannot be pasted here`,
      );
    return value;
  }

  private async fill(field: InputRequestField, entry: LoginEntryId, factor: TwoFactorId | undefined): Promise<string> {
    const logins = this.deps.logins as InputLoginPort;
    const role = fillRoleFor(field.sensitivity);
    const value = await logins
      .fill(entry, role, this.deps.clock.now(), role === 'totp' && factor !== undefined ? { factor } : {})
      .catch((error: unknown) => {
        throw error instanceof LoginEntryError
          ? new InputRequestError(
              error.refusal === 'unknown_login' ? 'not_found' : 'bad_request',
              `${error.message}; nothing was typed`,
            )
          : new InputRequestError('unavailable', 'Ferretry could not open the saved login, so nothing was typed');
      });
    const problem = inputValueProblem(value, field.sensitivity);
    if (problem !== undefined)
      throw new InputRequestError('bad_request', 'that saved login cannot be typed here; nothing was typed');
    return value;
  }

  /**
   * Keeps the typed values in a saved login once they have been typed, in ONE change: a login card's username and
   * password land together. A failure never undoes the delivery: it says what happened in a fixed sentence and
   * the owner can save it from Settings. The record is KEPT, one per field kept.
   */
  private async save(
    held: Held,
    save: NonNullable<InputDeliverBody['save']>,
    kept: LoginFieldValues,
    by: InputActor,
  ): Promise<NonNullable<InputDeliverResult['saved']>> {
    const logins = this.deps.logins;
    if (logins === undefined) return { entry: save.entry, ok: false, problem: 'not saved' };
    try {
      await logins.save(save.entry, save.label, held.matchKey, kept);
    } catch {
      return {
        entry: save.entry,
        ok: false,
        problem: 'The value was typed, but Ferretry could not keep it; save it from Settings › Secrets.',
      };
    }
    for (const field of ['username', 'password'] as const) {
      if (kept[field] === undefined) continue;
      await this.deps.audit
        .saved({ sessionId: held.request.sessionId, requestId: held.request.id, actor: by, entry: save.entry, field })
        .catch(() => undefined);
    }
    return { entry: save.entry, ok: true };
  }

  /**
   * The terminal is held BEFORE the value is typed, and the hold is journalled before anything is written. If
   * the journal cannot take it nothing is typed: a hold that a restart would not bring back is no hold. The
   * hold belongs to this attempt alone and cannot expire while the write is in flight; a pre-write end time
   * of two windows covers the write landing late, and {@link settle} replaces it with the exact one.
   */
  private async holdFor(
    request: InputRequest,
    seenNames: readonly string[] | undefined,
    window = QUARANTINE_MS,
  ): Promise<QuarantineHold> {
    const hold = this.deps.quarantine.begin(request.sessionId, holdNames(request, seenNames), request.id, window);
    try {
      await this.journalHold(hold, INPUT_QUARANTINE_EVENT_TYPES.started, this.deps.clock.now() + QUARANTINE_MS, true);
    } catch {
      this.deps.quarantine.release(hold);
      throw new InputRequestError('unavailable', 'Ferretry could not record the quarantine, so nothing was typed');
    }
    return hold;
  }

  /** The write was made, or may have been: this hold now runs a full window from here. */
  private async settle(hold: QuarantineHold | undefined): Promise<void> {
    if (hold === undefined) return;
    const until = this.deps.quarantine.settle(hold);
    await this.journalHold(hold, INPUT_QUARANTINE_EVENT_TYPES.started, until).catch(() => undefined);
  }

  /** Nothing was typed after all: this attempt's hold is let go. Another delivery's hold on the terminal stays. */
  private async letGo(hold: QuarantineHold | undefined): Promise<void> {
    if (hold === undefined) return;
    this.deps.quarantine.release(hold);
    const at = this.deps.clock.now();
    await this.journalHold(hold, INPUT_QUARANTINE_EVENT_TYPES.ended, at).catch(() => undefined);
  }

  /** Journals a hold by its id; an unresolved one has no end time that can be trusted until it is settled. */
  private async journalHold(
    hold: QuarantineHold,
    type: InputQuarantineEvent['type'],
    until: number,
    unresolved?: true,
  ): Promise<void> {
    if (isPageHold(hold)) return;
    await this.deps.journal.quarantine(hold.sessionId, {
      type,
      sessionId: hold.sessionId,
      names: [...hold.names],
      hold: hold.id,
      ...(unresolved === undefined ? {} : { unresolved }),
      until: instant(until),
      at: instant(this.deps.clock.now()),
    });
  }

  /**
   * The look before the write found the target not as the card showed it (`looked`). It is looked for AGAIN
   * ({@link refound}); found exactly as the card showed it (a stale ref that still finds the same node), those facts
   * are typed into. Anything else is {@link redrawOrRefuse}d.
   */
  private async lookAgain(held: Held, looked: ObserveResult): Promise<Extract<ObserveResult, { readonly ok: true }>> {
    const again = await this.refound(held, looked);
    if (again.ok && digestFacts(again.facts) === held.request.observedDigest) return again;
    return await this.redrawOrRefuse(held, again, looked.ok ? 'target_changed' : 'target_gone');
  }

  /**
   * The target the card is for, looked for again (`InputTargetPort.refind`): a page looks for the same field (the
   * approved node first, then exactly one), a terminal is looked at again. A terminal sighting that is already the
   * same target needs no second look; a page's always gets one, because a pointer's first match is not "exactly one".
   */
  private async refound(held: Held, looked: ObserveResult): Promise<ObserveResult> {
    const { request, binding } = held;
    if (request.target.kind !== 'browser' && binding !== undefined && looked.ok && mayRebind(binding, looked.facts))
      return looked;
    if (request.observed === undefined || this.deps.target.refind === undefined) return looked;
    return await this.deps.target.refind(
      request.sessionId,
      request.target,
      request.fields.map(pointerOf),
      request.observed,
    );
  }

  /**
   * What a target that is not as the card showed comes to. Nothing is typed either way:
   *
   * - the SAME target (`rebind.ts`) with something else changed: the card is redrawn — a new picture, digest and
   *   risk — nothing is counted, and the owner is asked to check it and send again;
   * - anything else (another origin, no such field, several look-alikes, a password field that became a text field,
   *   another program): a failed check, counted.
   *
   * A target that keeps changing ends the request once it was redrawn {@link INPUT_MAX_REBINDS} times.
   */
  private async redrawOrRefuse(held: Held, again: ObserveResult, code: InputReason): Promise<never> {
    const { request, binding } = held;
    if (binding === undefined || !again.ok || !mayRebind(binding, again.facts)) {
      await this.checkFailed(held, code);
      throw targetChanged(request.target.kind);
    }
    if (held.rebinds >= INPUT_MAX_REBINDS) {
      await this.finish(held, 'refused', 'check_failures', undefined, {
        closeCard: true,
        tellAgent: true,
        unsettled: true,
      });
      throw targetUnsettled(request.target.kind);
    }
    await this.rebind(held, again);
    throw targetRebound(request.target.kind);
  }

  /**
   * The card is redrawn from what was seen now: the same target, so the fields' risk, the picture and the digest are
   * taken again and the request waits for the owner. Nothing is typed and nothing is counted; it is audited.
   */
  private async rebind(held: Held, seen: Extract<ObserveResult, { readonly ok: true }>): Promise<void> {
    const { request } = held;
    held.rebinds += 1;
    held.names = [...new Set([...held.names, request.target.key, ...(seen.names ?? [])])];
    // Always the key of what was seen NOW: a prompt that left line mode (or a page that names no key) keeps no one-tap.
    rekey(held, targetMatchKey(seen.facts, this.deps.hostName ?? ''));
    // A card redrawn onto another document than the one it was raised on says so, above any other flag but red.
    const moved =
      seen.facts.kind === 'browser' && held.raisedOn !== undefined && seen.facts.navigationId !== held.raisedOn;
    const fields = observedAs(request.fields, seen.facts, held.upgraded, request.prompt, seen.codeProgram === true).map(
      field => (moved ? { ...field, risk: worstRisk([NEW_DOCUMENT_FLAG, field.risk]) as InputRisk } : field),
    );
    // The new picture is taken before the owner is asked again, exactly as at raise.
    const shot =
      seen.facts.kind === 'browser'
        ? await this.deps.target.shoot?.(request.sessionId, request.target, seen.facts).catch(() => undefined)
        : undefined;
    if (shot === undefined) delete held.shot;
    else held.shot = shot;
    const copy =
      request.source === undefined ? undefined : this.deps.sealed?.describe(request.sessionId, request.source.name);
    // A dummy probe was about the node the card first showed: a redrawn card earns its lock again without it.
    held.probed = false;
    const lock =
      request.lock === undefined
        ? undefined
        : lockFor(seen.facts, request.fields, {
            observed: await this.observedFacts(seen.facts),
            probed: false,
            submitted: request.submit !== 'agent',
            steered: this.tainted(request.sessionId, Date.parse(request.raisedAt)),
          });
    const { pictured: _pictured, ...rest } = request;
    held.request = {
      ...rest,
      ...(lock === undefined ? {} : { lock }),
      state: 'pending',
      fields,
      sensitivity: strongestSensitivity(fields),
      observed: await this.project(request.sessionId, seen.facts, held.names),
      risk: pasteRisk(worstRisk(fields.map(field => field.risk)), copy),
      observedDigest: digestFacts(seen.facts),
      ...(shot === undefined ? {} : { pictured: true as const }),
    };
    await this.record(held.request, 'input.rebound', { kind: 'daemon' }, this.auditOf(held.request));
  }

  /** A check failed: nothing was typed. Three failures end the request; fewer leave it pending. */
  private async checkFailed(held: Held, reason: InputReason): Promise<void> {
    held.checkFailures += 1;
    held.request = { ...held.request, state: 'pending' };
    if (held.checkFailures >= INPUT_MAX_CHECK_FAILURES)
      await this.finish(held, 'refused', 'check_failures', undefined, { closeCard: true, tellAgent: true });
    else
      await this.record(held.request, 'input.refused', { kind: 'daemon' }, { ...this.auditOf(held.request), reason });
  }

  private async finish(
    held: Held,
    state: 'delivered' | 'refused' | 'expired' | 'cancelled',
    reason: InputReason | undefined,
    by: InputActor | undefined,
    options: {
      closeCard: boolean;
      tellAgent: boolean;
      submitted?: boolean;
      uncertain?: boolean;
      /** The saved login the value was typed from. */
      entry?: LoginEntryId;
      /** Whether "Save as" kept the typed value. */
      saved?: boolean;
      /** The value was a secure copy, pasted. */
      sealed?: boolean;
      /** It ended because the target kept changing under the card, not because it became another target. */
      unsettled?: boolean;
      /** The 2FA key a code the daemon made and typed came from. */
      factor?: TwoFactorId;
      /** The sign-in a task-plan line filled. */
      signIn?: SignInId;
    },
  ): Promise<void> {
    // The request ends here: the ferret reads it as it is from now on.
    delete held.agentSees;
    delete held.agentLock;
    const at = instant(this.deps.clock.now());
    const source =
      options.sealed === true
        ? ('sealed' as const)
        : options.entry === undefined
          ? ('typed' as const)
          : ('saved' as const);
    const outcome =
      state === 'delivered' && by !== undefined
        ? {
            at,
            by,
            submitted: options.submitted ?? false,
            source,
            ...(options.entry === undefined ? {} : { entry: options.entry }),
          }
        : undefined;
    const seen = held.request;
    const { observed: _seen, observedDigest: _digest, pictured: _pictured, ...rest } = held.request;
    held.request = {
      ...rest,
      state,
      ...(outcome === undefined ? {} : { outcome }),
    };
    // The picture was for the owner deciding; once the request ends nobody may need it, so it is let go.
    delete held.shot;
    const { request } = held;
    const kind =
      state === 'delivered'
        ? 'delivered'
        : state === 'expired'
          ? 'expired'
          : state === 'refused'
            ? 'refused'
            : 'cancelled';
    await this.journalQuietly(request, kind, reason, options.submitted);
    await this.record(request, `input.${kind}`, by ?? { kind: 'daemon' }, {
      ...this.auditOf(seen),
      ...(reason === undefined ? {} : { reason }),
      ...(state === 'delivered'
        ? {
            source,
            submitted: options.submitted ?? false,
            ...(options.entry === undefined ? {} : { entry: options.entry }),
            ...(options.factor === undefined ? {} : { factor: options.factor }),
            ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
            ...(options.saved === undefined ? {} : { saved: options.saved }),
            ...(held.pastedInto === undefined ? {} : { profileProgram: held.pastedInto.path }),
          }
        : {}),
    });
    if (options.closeCard)
      await this.deps.agenda.close(
        request.sessionId,
        request.agendaItemId,
        state === 'delivered' && by?.kind === 'plan'
          ? planFilledNote(by.line, held.matchKey)
          : state === 'delivered' && by?.kind === 'sign-in-rule'
            ? ruleFilledNote(held.matchKey)
            : noteOf(state, reason, request.target.kind, options.unsettled === true),
      );
    if (options.tellAgent)
      await this.deps.notifier.tell(
        request.sessionId,
        request.agendaItemId,
        tellOf(request, state, reason, options.uncertain === true, options.unsettled === true),
      );
    for (const wake of held.waiters) wake();
    held.waiters.clear();
  }

  private byCard(sessionId: string, id: AgendaId): Held | undefined {
    for (const held of this.held.values()) {
      if (held.request.sessionId === sessionId && held.request.agendaItemId === id) return held;
    }
    // A request opened again on a new card is still the one its first card asked about.
    for (const held of this.held.values()) {
      if (held.request.sessionId === sessionId && held.formerCards.includes(id)) return held;
    }
    return undefined;
  }

  private view(held: Held): InputAgentView {
    const { names } = held;
    const shown = held.agentSees ?? held.request;
    const request =
      held.agentSees === undefined && held.agentLock !== undefined ? { ...shown, lock: held.agentLock.lock } : shown;
    const quarantined = this.quarantined(request.sessionId, names);
    const facts =
      request.observed?.kind === 'terminal' && quarantined ? maskedFacts(request.observed) : request.observed;
    const terminal = facts?.kind === 'terminal' ? facts : undefined;
    const page = facts?.kind === 'browser' ? facts : undefined;
    const pending = request.state === 'pending';
    return {
      id: request.agendaItemId,
      state: request.state,
      ...(terminal === undefined
        ? {}
        : {
            observed: {
              consumer: terminal.foreground.comm,
              echo: terminal.echo,
              recognised: terminal.recognisedConsumer,
            },
          }),
      ...(page === undefined ? {} : { observed: { consumer: hostOf(page.origin) } }),
      ...(request.outcome === undefined
        ? {}
        : { submitted: request.outcome.submitted, source: request.outcome.source }),
      ...(request.lock === undefined ? {} : { lockSeconds: request.lock.seconds }),
      ...(pending && page?.challenge !== undefined
        ? {
            note: `The page is showing a captcha: hand it to the owner with browser_ask_owner ("complete the captcha") and wait; never try to solve it. ${request.agendaItemId} waits for the owner too.`,
          }
        : pending
          ? {
              // One sentence for every reason a plan line did not apply: a reason could say which secret fields exist. A
              // standing rule's miss says NOTHING: the view is byte-identical to a sign-in no rule was ever about.
              note:
                request.preapproval?.by === 'plan' && request.preapproval.outcome === 'did-not-apply'
                  ? `${TASK_PLAN_MISS_AGENT_NOTE} Waiting for the owner on ${request.agendaItemId}.`
                  : `Waiting for the owner on ${request.agendaItemId}.`,
            }
          : request.outcome?.by.kind === 'rule'
            ? { note: 'Pasted under a rule the owner approved in advance.' }
            : request.outcome?.by.kind === 'plan'
              ? { note: PLAN_FILLED_AGENT_NOTE }
              : request.outcome?.by.kind === 'sign-in-rule'
                ? { note: RULE_FILLED_AGENT_NOTE }
                : {}),
    };
  }

  /** A move that has already happened: the journal is a record of it, so a failure to write it is not fatal. */
  private async journalQuietly(
    request: InputRequest,
    kind: keyof typeof INPUT_JOURNAL_EVENT_TYPES,
    reason?: InputReason,
    submitted?: boolean,
  ): Promise<void> {
    await this.journal(request, kind, reason, submitted).catch(() => undefined);
  }

  /** A move that has NOT happened yet (a request, a write): it must be recorded first, and a failure is the caller's. */
  private async journal(
    request: InputRequest,
    kind: keyof typeof INPUT_JOURNAL_EVENT_TYPES,
    reason?: InputReason,
    submitted?: boolean,
    deliveryId?: string,
  ): Promise<void> {
    await this.deps.journal.publish(request.sessionId, {
      type: INPUT_JOURNAL_EVENT_TYPES[kind],
      requestId: request.id,
      agendaItemId: request.agendaItemId,
      sessionId: request.sessionId,
      target: { kind: request.target.kind, key: request.target.key },
      sensitivity: request.sensitivity,
      submit: request.submit,
      ...(request.source === undefined ? {} : { sealed: request.source.name }),
      state: request.state,
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(submitted === undefined ? {} : { submitted }),
      ...(reason === undefined ? {} : { reason }),
      ...(kind === 'requested' || kind === 'delivering' ? { expiresAt: request.expiresAt } : {}),
      at: instant(this.deps.clock.now()),
    });
  }

  private async record(
    request: InputRequest,
    event: InputAuditEvent,
    actor: Parameters<InputAudit['record']>[0]['actor'],
    detail: InputAuditDetail,
  ): Promise<void> {
    await this.deps.audit
      .record({
        event,
        sessionId: request.sessionId,
        actor,
        requestId: request.id,
        detail,
      })
      .catch(() => undefined);
  }
}

function requireOwner(caller: InputCaller): InputActor {
  if (caller.kind !== 'owner')
    throw new InputRequestError('forbidden', 'only the owner answers an input request; an agent cannot');
  return caller.actor;
}

function targetChanged(kind: InputTarget['kind']): InputRequestError {
  return new InputRequestError(
    'conflict',
    `what is on the ${surfaceWord(kind)} is no longer what the card showed; nothing was typed`,
    INPUT_ERROR_CODES.targetChanged,
  );
}

/** The target changed under the card but is the same target: the card was redrawn and nothing was counted. */
function targetRebound(kind: InputTarget['kind']): InputRequestError {
  return new InputRequestError(
    'conflict',
    `the ${surfaceWord(kind)} changed since the card was drawn, but it is the same ${kind === 'terminal' ? 'prompt' : 'field'}: Ferretry looked again and redrew the card; check it and send again. Nothing was typed`,
    INPUT_ERROR_CODES.targetRebound,
  );
}

/** The last failed check ended the request: the owner is told why in plain words, and what to do. */
function targetUnsettled(kind: InputTarget['kind']): InputRequestError {
  return new InputRequestError(
    'gone',
    `the ${surfaceWord(kind)} kept changing, so nothing was typed and this request ended; ask the ferret to request again`,
    INPUT_ERROR_CODES.targetUnsettled,
  );
}

const surfaceWord = (kind: InputTarget['kind']): string =>
  kind === 'terminal' ? 'terminal' : kind === 'secret' ? 'secret store' : 'page';

/** The host of an origin the browser reported, or the origin itself when it does not parse. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The field a raise names, as the card holds it before the daemon has looked: labelled, no risk yet. */
function cardField(field: InputFieldRaise): InputRequestField {
  return {
    id: field.id,
    label: field.label ?? FIELD_LABELS[field.sensitivity],
    sensitivity: field.sensitivity,
    ...(field.element === undefined ? {} : { element: field.element }),
  };
}

/** A field brought back from the journal, which keeps only the sensitivity: a terminal's one value. */
function restoredField(sensitivity: InputSensitivity): InputRequestField {
  return { id: INPUT_SINGLE_FIELD_ID, label: FIELD_LABELS[sensitivity], sensitivity };
}

/** What the target adapter is told about a field: its id and the element it names, never its label. */
function pointerOf(field: { readonly id: string; readonly element?: InputRequestField['element'] }): InputTargetField {
  return field.element === undefined ? { id: field.id } : { id: field.id, element: field.element };
}

const UPGRADED_FLAG = 'Treated as a secret: this is a password field.';
/** The ferret's words that ask for a password, PIN or passphrase. */
const PASSWORD_WORDS = /pass(?:word|phrase|wd)|(?:^|[^a-z])pin(?:[^a-z]|$)/iu;
const AMBER_AT_LEAST: Readonly<Record<InputRisk['level'], InputRisk['level']>> = {
  green: 'amber',
  neutral: 'amber',
  amber: 'amber',
  red: 'red',
};

/**
 * The fields as the daemon handles them, each with its flag. A `code` field whose target the daemon saw is a password
 * (`passwordTarget`) is handled as a `secret` from then on (`upgraded`, never undone): hidden on the card, locked,
 * masked, blocking the ferret's typing and journalled as `secret`. Its flag says so, at least amber, because the
 * ferret called a password a code.
 */
function observedAs(
  fields: readonly InputRequestField[],
  facts: InputTargetFacts,
  upgraded: Set<string>,
  prompt: string,
  /** The daemon saw a code program this account cannot replace in the foreground (`ObserveResult.codeProgram`). */
  codeProgram: boolean,
): InputRequestField[] {
  return fields.map(field => {
    // The ferret's own words (its prompt, the field's label or id) may only ever RAISE a code to a secret.
    // Matched as normalised text, and a look-alike spelling counts, as for the pane's own words (lock.ts).
    const said = [prompt, field.label, field.id].some(
      word => PASSWORD_WORDS.test(matchable(word)) || spellsPassword(word) || lookAlike(word),
    );
    if (field.sensitivity === 'code' && (said || passwordTarget(facts, field.id, codeProgram))) upgraded.add(field.id);
    if (!upgraded.has(field.id)) return { ...field, risk: riskOf(field, facts) };
    const secret = { ...field, sensitivity: 'secret' as const };
    return { ...secret, risk: { level: AMBER_AT_LEAST[riskOf(secret, facts).level], reason: UPGRADED_FLAG } };
  });
}

/**
 * A raise's fields must suit its surface: a terminal shows ONE prompt at a time, so it takes one value with no
 * element (a second prompt is a chained request); every field of a page names the element it goes into.
 */
function guardFields(target: InputTarget, fields: readonly InputFieldRaise[]): void {
  if (target.kind === 'secret') {
    if (fields.length !== 1 || fields[0]?.element !== undefined)
      throw new InputRequestError('bad_request', 'a secret holds one value: raise it with one field and no element');
    return;
  }
  if (target.kind === 'terminal') {
    if (fields.length !== 1)
      throw new InputRequestError(
        'bad_request',
        'a terminal shows one prompt at a time: ask for one value, then raise the next with chain',
      );
    if (fields[0]?.element !== undefined)
      throw new InputRequestError('bad_request', 'a terminal field names no element: the value goes to its prompt');
    return;
  }
  if (fields.some(field => field.element === undefined))
    throw new InputRequestError('bad_request', 'name the element each field goes into: a ref or a selector');
}

/**
 * The typed values of a Send, each by its field and checked for what its field may take, before anything is
 * looked at or typed. Every field is covered: typed here, or left to the saved login the Send names.
 */
function typedValues(request: InputRequest, body: InputDeliverBody): Map<string, string> {
  const typed = new Map<string, string>();
  const take = (field: InputRequestField | undefined, padded: string): void => {
    if (field === undefined) throw new InputRequestError('bad_request', 'that field is not on this card');
    const value = unpadInputValue(padded);
    if (value === undefined) throw new InputRequestError('bad_request', 'the value was not sent in the expected form');
    const problem = inputValueProblem(value, field.sensitivity);
    if (problem !== undefined) throw new InputRequestError('bad_request', problem);
    typed.set(field.id, value);
  };
  if (body.padded !== undefined) {
    if (request.fields.length !== 1)
      throw new InputRequestError('bad_request', 'this card asks for several values: send each by its field');
    take(request.fields[0], body.padded);
  }
  for (const each of body.fields ?? [])
    take(
      request.fields.find(field => field.id === each.field),
      each.padded,
    );
  const missing = request.fields.filter(field => !typed.has(field.id));
  if (missing.length > 0 && body.entry === undefined)
    throw new InputRequestError(
      'bad_request',
      `fill every field before Send: ${missing.map(field => field.id).join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty`,
    );
  if (missing.length === 0 && body.entry !== undefined && body.padded === undefined && body.fields !== undefined)
    throw new InputRequestError(
      'bad_request',
      'every field was typed, so there is nothing for the saved login to fill',
    );
  return typed;
}

/**
 * Whether a delivered value is held in the redaction window (masked from every read): a `secret` and a `private`
 * value always; a `plain` value never; a one-time `code` only when the DAEMON made it from a saved 2FA seed (not in
 * `typed`): defence in depth for text reads. No tool, result or route RETURNS a daemon-made code; the ferret may still
 * see it on screen (a screenshot, a scripted read), which the owner allowed. A code the owner typed is not secret.
 */
function maskedFromReads(field: InputRequestField, typed: ReadonlyMap<string, string>): boolean {
  if (field.sensitivity === 'plain') return false;
  return field.sensitivity !== 'code' || !typed.has(field.id);
}

const PLAIN_FLAG = 'Not secret: the ferret can see this value.';
/**
 * A page card redrawn onto a new document: the field looks the same, but the page may not be the one you were asked
 * on. The card shows the origin and the picture, not the address, so that is what the owner is sent to check.
 */
const NEW_DOCUMENT_FLAG: InputRisk = {
  level: 'amber',
  reason:
    'The page loaded a new document since you were asked: check the picture, and open the page if you are not sure it is the one you meant.',
};
const PRIVATE_FLAG = 'This value will show on screen while the terminal is hidden from the ferret for 2 minutes.';
/** A one-time code is not secret: neutral, neither the red of a plain value nor the amber of a private one. */
const CODE_FLAG: InputRisk = { level: 'neutral', reason: 'One-time code: the ferret can see it.' };
const CODE_ASK = 'One-time code: the ferret can see this value.';

/**
 * The flag a card carries, from what was seen at the target: it is never a refusal, the owner decides. The
 * sentence is fixed text (no program name, nothing the terminal showed), so it is safe to show and to log.
 */
function riskOf(field: Pick<InputRequestField, 'id' | 'sensitivity'>, facts: InputTargetFacts): InputRisk {
  const { sensitivity } = field;
  if (sensitivity === 'plain') return { level: 'red', reason: PLAIN_FLAG };
  if (facts.kind === 'secret')
    return facts.exists
      ? { level: 'amber', reason: 'This replaces the value the secret holds now; the old value is gone for good.' }
      : { level: 'green', reason: 'Saved encrypted on this machine; ferrets can use it by name and never read it.' };
  if (facts.kind === 'browser') return pageRiskOf(field, facts);
  if (sensitivity === 'private') return { level: 'amber', reason: PRIVATE_FLAG };
  if (sensitivity === 'code') return CODE_FLAG;
  if (facts.echo === 'on')
    return {
      level: 'amber',
      reason:
        'The terminal is echoing what is typed, so the value will show on screen; Ferretry hides it from the ferret for a while.',
    };
  if (facts.echo !== 'off')
    return {
      level: 'amber',
      reason: 'Ferretry could not tell whether the terminal echoes, so the value may show on screen.',
    };
  if (facts.program === undefined) return UNVERIFIED_FLAG;
  if (facts.canonical !== true) return RELAY_FLAG;
  if (!facts.recognisedConsumer)
    return {
      level: 'amber',
      reason:
        'The program reading the terminal is a bare shell or not one known to ask for secrets, so the value may land somewhere unexpected.',
    };
  return { level: 'green', reason: 'Typing is hidden and the program is one known to ask for a password.' };
}

/**
 * The program reading the terminal could not be PROVED: a process of its foreground group is not a program the kernel
 * shows came from a root-controlled place (a shell that renamed itself `sudo`, a `read -s` in a pipeline sudo leads),
 * or a process of another session holds the terminal open. Never green, and the lock stays full.
 */
const UNVERIFIED_FLAG: InputRisk = {
  level: 'amber',
  reason:
    'Unverified: Ferretry could not prove which program is reading the terminal, so the name it shows may be a disguise and the value may land somewhere unexpected.',
};

/**
 * The proved program reads the terminal key by key (raw or readline mode, or a mode that could not be read): a relay
 * such as `ssh -t` or `docker exec -it` passes every key on to a reader outside this machine's foreground group. A
 * real password prompt (getpass, readpassphrase, Go's ReadPassword) reads in line mode. Never green.
 */
const RELAY_FLAG: InputRisk = {
  level: 'amber',
  reason:
    'The terminal is not reading a line, so the program may be passing each key on to something else (a remote shell or a container) rather than asking for a password itself.',
};

const PAGE_PRIVATE_FLAG = 'This value will show on the page; Ferretry hides the page from the ferret for 2 minutes.';
/**
 * A page field's flag, worst first: the field the agent named is missing or hidden, covered or off screen, the page is not secure (http
 * crosses the network in the clear), the field sits in a frame from another site, or a secret is going into a
 * field that is not a password field (it will show on the page). Fixed sentences only, like the terminal's.
 */
function pageRiskOf(
  field: Pick<InputRequestField, 'id' | 'sensitivity'>,
  facts: Extract<InputTargetFacts, { readonly kind: 'browser' }>,
): InputRisk {
  const found = facts.fields.find(each => each.fieldId === field.id);
  if (found === undefined || !found.visible)
    return {
      level: 'amber',
      reason: 'Ferretry could not see this field on the page, so the value may land somewhere unexpected.',
    };
  if (found.covered === true)
    return {
      level: 'amber',
      reason: 'Something on the page covers this field, or it is off screen, so you cannot see where the value goes.',
    };
  if (!facts.secure)
    return { level: 'amber', reason: 'The page is not https, so the value crosses the network unencrypted.' };
  if (found.frameOrigin !== facts.origin)
    return { level: 'amber', reason: 'This field is inside a frame from another site, not the page itself.' };
  if (field.sensitivity === 'private') return { level: 'amber', reason: PAGE_PRIVATE_FLAG };
  // Where a code lands still counts (the checks above): a code typed into the wrong place is the one way to abuse it.
  if (field.sensitivity === 'code') return CODE_FLAG;
  // Only a password input masks what is typed. `autocomplete="current-password"` is a hint about the field's role
  // and leaves a text input showing the value, so it never earns green.
  if (found.field.type?.toLowerCase() !== 'password')
    return { level: 'amber', reason: 'This is not a password field, so the value will show on the page.' };
  return { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' };
}

/** What a card opened again says first: the code Ferretry made from a saved key did not go through. */
const CODE_DID_NOT_GO_THROUGH = "The saved key's code didn't go through: type the code.";

/** A title cut to what an agenda card holds, on a word where it can be. */
function clipped(title: string): string {
  if (title.length <= MAX_AGENDA_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_AGENDA_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Whether the daemon may type a code it made into a card's code fields, from what IT saw ({@link codeTargetProblem}):
 * the card offers "Use code from Ferretry" only then. A card with no code field offers none.
 */
function codesHere(facts: InputTargetFacts | undefined, fields: readonly InputRequestField[]): boolean {
  const ids = fields.filter(field => fillRoleFor(field.sensitivity) === 'totp').map(field => field.id);
  return ids.length > 0 && codeTargetProblem(facts, ids) === undefined;
}

function titleOf(fields: readonly InputRequestField[]): string {
  const kinds = new Set(fields.map(field => field.sensitivity));
  if (fields.length > 1 && kinds.has('secret') && kinds.has('plain')) return LOGIN_TITLE;
  return TITLES[strongestSensitivity(fields)];
}

function askOf(facts: InputTargetFacts, fields: readonly InputRequestField[]): string {
  const it = fields.length === 1 ? 'it' : 'them';
  const where = facts.kind === 'terminal' ? 'Type it into the terminal' : `Type ${it} into the page`;
  if (fields.some(field => field.sensitivity === 'plain')) return `${where}. ${PLAIN_FLAG}`;
  return fields.some(field => field.sensitivity === 'code') ? `${where}. ${CODE_ASK}` : where;
}

function auditDetail(request: InputRequest): InputAuditDetail {
  const facts = request.observed;
  return {
    targetKind: request.target.kind,
    sensitivity: request.sensitivity,
    ...(facts?.kind === 'terminal' ? { recognised: facts.recognisedConsumer } : {}),
    ...(request.source === undefined ? {} : { copy: request.source.name }),
  };
}

const PASTE_TITLE = 'Wants to paste a secure copy';

/** A paste's ask: what is pasted and where it came from, in the daemon's words. There is nothing to type. */
function pasteAskOf(copy: CopyMeta, facts: InputTargetFacts): string {
  const from = copy.from.origin ?? copy.from.path ?? copy.from.program ?? copy.from.kind;
  const into =
    facts.kind === 'terminal'
      ? 'the terminal'
      : facts.kind === 'secret'
        ? `the secret ${facts.name}${facts.exists ? ', replacing its value' : ''}`
        : `a field on ${hostOf(facts.origin)}`;
  return `Allow pasting ${copy.handle} (${String(copy.length)} characters from ${from}) into ${into}. You type nothing.`;
}

const SEEN_FLAG = 'The ferret saw this value before it was sealed, so it is not protected; consider rotating it.';

/** A copy the agent had already seen is never green: the owner is told it is not protected. */
function pasteRisk(risk: InputRisk | undefined, copy: CopyMeta | undefined): InputRisk | undefined {
  if (copy?.exposure.transcript !== 'found') return risk;
  return { level: risk?.level === 'red' ? 'red' : 'amber', reason: SEEN_FLAG };
}

/**
 * What a rule never does unasked, whatever it names: paste a copy the ferret had already seen (it is not
 * protected, and the owner should be told), replace a value the secret store holds now (the old one is gone
 * for good), or paste into a page field the card would flag. Each waits for the owner on the card, which says so.
 */
function ruleMayPaste(copy: CopyMeta, facts: InputTargetFacts, fields: readonly InputRequestField[]): boolean {
  if (copy.exposure.transcript === 'found') return false;
  if (facts.kind === 'secret') return !facts.exists;
  // On a page, a rule names the TOP page's origin, so it pastes unasked only where the card would be green for
  // every field: a visible, uncovered password field of that very page (not a frame from another site), on https,
  // with no challenge showing. Anything the card would flag waits for the owner.
  if (facts.kind === 'browser')
    return facts.challenge === undefined && fields.every(field => pageRiskOf(field, facts).level === 'green');
  return true;
}

/** A target that does not show what is typed: a terminal with echo off, or a page whose fields are all password fields. */
function hidesTyping(facts: InputTargetFacts): boolean {
  if (facts.kind === 'secret') return true;
  return facts.kind === 'terminal'
    ? facts.echo === 'off'
    : facts.fields.every(field => field.field.type === 'password');
}

/** What a terminal's facts read as while it is quarantined: what a secret may have left on the screen is gone. */
function maskedFacts(facts: InputTargetFacts): InputTargetFacts {
  if (facts.kind !== 'terminal') return facts;
  // `program` stays: it is a root-controlled folder's entry or a setuid-root process's own name, never something the
  // reading program could write a typed value into, unlike `comm`.
  return {
    ...facts,
    promptLine: QUARANTINE_NOTICE,
    foreground: { ...facts.foreground, comm: QUARANTINE_NOTICE, argv: '' },
  };
}

/**
 * How a card closes, in plain words. A target that kept changing under the card and one that became ANOTHER target
 * end with the same reason but are told apart: only the first invites the ferret to simply ask again.
 */
function noteOf(state: string, reason: InputReason | undefined, kind: InputTarget['kind'], unsettled: boolean): string {
  if (reason === 'check_failures')
    return unsettled
      ? `The ${surfaceWord(kind)} kept changing, so nothing was typed. Ask the ferret to request again.`
      : `The ${surfaceWord(kind)} is no longer what you approved, so nothing was typed. Look at it before the ferret asks again.`;
  return reason === undefined ? `Input request ${state}.` : `Input request ${state}: ${reason.replaceAll('_', ' ')}.`;
}

/** Why a request ended, in the words the ferret is told: never a bare wire code. */
function reasonWords(reason: InputReason, kind: InputTarget['kind'], unsettled: boolean): string {
  if (reason !== 'check_failures') return reason.replaceAll('_', ' ');
  return unsettled
    ? `the ${surfaceWord(kind)} kept changing`
    : `the ${surfaceWord(kind)} is no longer what the owner approved`;
}

function tellOf(
  request: InputRequest,
  state: string,
  reason: InputReason | undefined,
  uncertain: boolean,
  unsettled: boolean,
): string {
  const { kind, key } = request.target;
  const surface = surfaceWord(kind);
  const tool = `${kind}_request_input`;
  if (kind === 'secret') return storeTellOf(request, state, reason, uncertain, unsettled);
  if (uncertain)
    return `${request.agendaItemId} was interrupted while the owner's value was going into %${kind}:${key}; it may be partly or fully typed there. Read the ${surface} before you act once its quarantine allows; if you still need a value, raise a fresh ${tool}, or ask the owner to take over the ${surface}.`;
  if (state === 'delivered' && request.outcome?.by.kind === 'plan')
    return `${request.agendaItemId}: Ferretry filled the sign-in on %${kind}:${key} under your task plan. Read the ${surface} to continue once its quarantine allows.`;
  if (state === 'delivered' && request.outcome?.by.kind === 'sign-in-rule')
    return `${request.agendaItemId}: Ferretry filled the sign-in on %${kind}:${key} under a rule the owner approved in advance. Read the ${surface} to continue once its quarantine allows.`;
  if (state === 'delivered' && request.source !== undefined)
    return `${request.agendaItemId}: ${copyHandle(request.source.name)} was pasted into %${kind}:${key}. Read the ${surface} to continue once its quarantine allows.`;
  if (state === 'delivered')
    return `${request.agendaItemId} was answered and typed into %${kind}:${key}. Read the ${surface} to continue.`;
  return `${request.agendaItemId} ended without a value (${state}${reason === undefined ? '' : `: ${reasonWords(reason, kind, unsettled)}`}). If you still need a value, raise a fresh ${tool}, or ask the owner to take over the ${surface}.`;
}

/** What the agent is told about a paste into the secret store: it never reads the store, so it is told whether the name now holds the copy. */
function storeTellOf(
  request: InputRequest,
  state: string,
  reason: InputReason | undefined,
  uncertain: boolean,
  unsettled: boolean,
): string {
  const { key } = request.target;
  const handle = copyHandle(request.source?.name ?? '');
  if (uncertain)
    return `${request.agendaItemId} was interrupted while ${handle} was being saved as the secret ${key}; it may or may not hold it now. Ask the owner to check the secret in Settings before you use \${secret:${key}}.`;
  if (state === 'delivered')
    return `${request.agendaItemId}: ${handle} was saved as the secret ${key}. Use it as \${secret:${key}}; you can never read it.`;
  return `${request.agendaItemId} ended without saving ${handle} (${state}${reason === undefined ? '' : `: ${reasonWords(reason, request.target.kind, unsettled)}`}). If you still need it saved, call secure_paste again or ask the owner.`;
}

/** What the ferret's view says once a task-plan line filled its card. */
const PLAN_FILLED_AGENT_NOTE = 'Filled under your task plan.';

/** What the ferret's view says once a standing rule filled its card: never which rule, never the account. */
const RULE_FILLED_AGENT_NOTE = 'Filled under a rule the owner approved in advance.';

/** The line a paste card that a rule did not fill after all carries: the same words whatever went wrong. */
const RULE_MISS_CONTEXT_LINE = "A paste rule you approved didn't apply here, so you're asked as usual.";

/** How a card a task-plan line filled closes, for the agenda history: the line and where, never the account. */
function planFilledNote(line: number, matchKey: string | undefined): string {
  return `Filled under your task plan (line ${String(line + 1)})${matchKey === undefined ? '' : ` on ${matchKey}`}.`;
}

/** How a card a standing rule filled closes, for the agenda history: where, never the rule or the account. */
function ruleFilledNote(matchKey: string | undefined): string {
  return `Filled under your standing rule${matchKey === undefined ? '' : ` on ${matchKey}`}.`;
}

/**
 * The owner's note on a card about the grant tried on it, by its source: filled, or did not apply (and why, when
 * known). `undefined` for a grant that names neither a plan line nor a rule (it fills nothing either: `actorOf`).
 */
function preapprovalOf(
  grant: SignInGrant,
  outcome: 'filled' | 'did-not-apply',
  reason?: GrantMissReason,
): InputRequest['preapproval'] {
  const why = outcome === 'did-not-apply' && reason !== undefined ? { reason } : {};
  if (grant.source === 'rule')
    return grant.rule === undefined
      ? undefined
      : { by: 'rule', rule: grant.rule.id, revision: grant.rule.revision, outcome, ...why };
  return { by: 'plan', plan: grant.plan?.id ?? '', line: grant.plan?.line ?? 0, outcome, ...why };
}

/** Who a grant fill is recorded as: the plan line, or the standing rule at the revision the passkey approved. */
function actorOf(grant: SignInGrant): InputActor | undefined {
  if (grant.source === 'rule')
    return grant.rule === undefined
      ? undefined
      : { kind: 'sign-in-rule', rule: grant.rule.id, revision: grant.rule.revision };
  return grant.plan === undefined ? undefined : { kind: 'plan', planId: grant.plan.id, line: grant.plan.line };
}

/** One grant that was tried on a card and did not fill it, and why. */
interface GrantMiss {
  readonly grant: SignInGrant;
  readonly reason: GrantMissReason;
}

/** A grant's second match, at the write, failed: nothing is typed, and the card stays for the owner. */
class GrantMissed extends Error {
  constructor(readonly reason: GrantMissReason) {
    super('a pre-approval did not cover this card; nothing was typed');
    this.name = 'GrantMissed';
  }
}

/** A grant could not be checked again before the write (its registry or the accounts unreadable): nothing is typed. */
class GrantUnchecked extends Error {
  constructor() {
    super('a pre-approval could not be checked again; nothing was typed');
    this.name = 'GrantUnchecked';
  }
}

/** What a write under a grant does beyond a tap's: matches again on what was looked at, and clears a password later. */
interface GrantWrite {
  /** Throws (nothing typed) when the grant, read again, no longer covers the facts just seen. */
  recheck(seen: Extract<ObserveResult, { readonly ok: true }>): Promise<void>;
  /** Whether the grant is still held, asked synchronously as the last thing before the write. */
  held(): boolean;
  /** A page password was typed, or may have been: what to check and empty before the hold (`holdMs`, on `names`) ends. */
  typed(job: ClearJob, holdMs: number, names: readonly string[]): void;
  /** The write may have typed something and could not say: the grant stops. */
  uncertain(): Promise<void>;
}
