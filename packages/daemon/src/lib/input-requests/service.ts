import {
  type AgendaId,
  type CopyMeta,
  copyHandle,
  fillRoleFor,
  INPUT_DEFAULT_EXPIRY_SECONDS,
  INPUT_ERROR_CODES,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_MAX_CHECK_FAILURES,
  INPUT_MAX_PENDING_PER_SESSION,
  INPUT_MAX_REBINDS,
  INPUT_MAX_RAISES_PER_HOUR,
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
  type PushSubject,
  loginDomainsOf,
  type LoginObserved,
  inputRaiseFields,
  inputValueProblem,
  LOGIN_PASSWORD_MIN_LENGTH,
  LOGIN_USERNAME_MAX_LENGTH,
  type LoginEntryId,
  savedRolesOf,
  strongestSensitivity,
  unpadInputValue,
  worstRisk,
} from '@ferretry/protocol';
import { LoginEntryError, type LoginFieldValues } from '../secrets/logins.ts';
import { digestFacts } from './digest.ts';
import type { EphemeralValues } from './ephemeral-values.ts';
import { InputRequestError } from './errors.ts';
import type {
  InputAgendaPort,
  InputAgentNotifier,
  InputAudit,
  InputCaller,
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
  TypeResult,
} from './ports.ts';
import type { QuarantineHold, QuarantineRegistry } from './quarantine.ts';
import { bindingOf, mayRebind } from './rebind.ts';
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
import type { LoginObserver } from './login-observer.ts';
import { savedForFields, targetMatchKey } from './saved-logins.ts';
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
  /** Every name the terminal was seen under (its key and its id), so a quarantine on any of them seals it. */
  names: readonly string[];
  checkFailures: number;
  /** Times the target changed under the card and was found again, so the card was redrawn instead of failing. */
  rebinds: number;
  /** Which target the card is for (`rebind.ts`): a sighting with this binding may redraw the card. Absent: none may. */
  binding?: string;
  /** The document a page's card was raised on: a card redrawn onto another one says so. */
  readonly raisedOn?: string;
  /** The target's key for saved logins (`sudo@kirin-box`), from what the DAEMON saw; never from the agent. */
  matchKey?: string;
  /** The saved login the ferret said it expects: shown to the owner as a hint, never made the one-tap choice. */
  readonly hint?: LoginEntryId;
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
}

/**
 * A page's names in the quarantine registry. Terminals and pages share the registry, so a page's names carry a
 * mark no surface key can start with: a hold on page "app" never seals terminal "app". Page holds are not
 * journalled: a page does not outlive the daemon that drove it.
 */
const PAGE_MARK = '~page:';
const pageName = (name: string): string => `${PAGE_MARK}${name}`;
const isPageHold = (hold: QuarantineHold): boolean => hold.names.every(name => name.startsWith(PAGE_MARK));

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
  /** This machine's host name, for a terminal target's key (`sudo@<host>`). */
  readonly hostName?: string;
  /** Secure copies a paste types from (docs/secure-copy.md). Absent: a paste is refused. */
  readonly sealed?: InputSealedPort;
  /** The owner's pre-approval rules. Absent: every paste waits for the owner. */
  readonly rules?: InputPasteRules;
  /**
   * Told about every value typed into a terminal or a page, once it landed: the facts a saved login keeps
   * (docs/input-requests.md, "Login recipes") come only from here. Absent: no facts are kept.
   */
  readonly observer?: Pick<LoginObserver, 'delivered' | 'tainted'>;
}

const instant = (ms: number): string => new Date(ms).toISOString();

const isFinal = (request: InputRequest): boolean => FINAL.has(request.state);

export class InputRequestService {
  private readonly held = new Map<string, Held>();
  /**
   * What a card being raised is about, by request id, while `agenda.raise` runs: the card's push is made INSIDE that
   * raise (the deadline push, buzz.ts), before the request is held, so `pushSubjectOf` must already know it.
   */
  private readonly raising = new Map<string, { readonly sessionId: string; readonly subject: PushSubject }>();
  private readonly raises = new Map<string, number[]>();
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
    const observedFacts = kept ? await this.observedFacts() : [];
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
    this.raising.set(requestId, { sessionId, subject: sensitivity === 'code' ? 'one-time-code' : 'other' });
    const card = await this.deps.agenda
      .raise(sessionId, {
        requestId,
        title: copy === undefined ? titleOf(fields) : PASTE_TITLE,
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
      throw new InputRequestError('unavailable', 'Ferretry could not record the request, so it did not ask the owner');
    }
    const matchKey = targetMatchKey(seen.facts, this.deps.hostName ?? '');
    const held: Held = {
      request,
      names: [target.key, ...(seen.names ?? [])],
      checkFailures: 0,
      rebinds: 0,
      binding: bindingOf(seen.facts),
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
    if (copy !== undefined) await this.underRule(held, copy, seen.facts, raise.submit);
    return this.view(held);
  }

  /**
   * A paste the owner approved IN ADVANCE: delivered now, under the rule, still as one guarded write with the
   * card raised, audited and closed so it shows in the log. Runs inside the raise's turn of the session lock.
   * Only a target that hides what is typed is pasted unasked. A use is given back only when NOTHING may have
   * been typed; an uncertain write spends it.
   */
  private async underRule(
    held: Held,
    copy: CopyMeta,
    facts: InputTargetFacts,
    submit: InputRaise['submit'],
  ): Promise<void> {
    if (!hidesTyping(facts) || !ruleMayPaste(copy, facts, held.request.fields)) return;
    const ruleId = this.deps.rules?.reserve(held.request.sessionId, copy.from, facts);
    if (ruleId === undefined) return;
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
    }
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

  /**
   * What the owner's card may offer from the saved logins. A store that cannot be read offers nothing
   * rather than failing the card: the owner can still type the value.
   */
  private async savedView(held: Held): Promise<InputRequest['saved']> {
    const { logins } = this.deps;
    if (logins === undefined || held.request.state !== 'pending') return undefined;
    const entries = await logins.entries().catch(() => []);
    return savedForFields(held.request.fields, held.matchKey, entries, held.hint);
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
    if (held === undefined || held.request.state !== 'pending') return;
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
    const matchKey = targetMatchKey(seen.facts, this.deps.hostName ?? '');
    if (matchKey !== undefined) held.matchKey = matchKey;
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
  ): Promise<InputDeliverResult> {
    const { request } = held;
    held.request = { ...request, state: 'delivering' };
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
      const submitted = body.submit && request.submit !== 'agent';
      const looked = await this.deps.target.observe(request.sessionId, request.target, request.fields.map(pointerOf));
      const seen =
        looked.ok && digestFacts(looked.facts) === request.observedDigest ? looked : await this.lookAgain(held, looked);
      // A secure copy is opened HERE, like a saved value: after every check that can refuse without typing, and only to be typed.
      if (pasted !== undefined)
        typed.set((request.fields[0] as InputRequestField).id, await this.openCopy(held, pasted));
      // A saved value is opened HERE, inside the use boundary, after every check that can refuse without
      // typing, and only to be typed: it is in no request, event, audit entry, result or error.
      const values: InputFieldValue[] = [];
      for (const field of request.fields) {
        const text = typed.get(field.id) ?? (await this.fill(field, body.entry as LoginEntryId));
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
          observed: await this.observedFacts(),
          probed: held.probed === true,
          submitted,
          steered: this.tainted(request.sessionId, Date.parse(request.raisedAt)),
        });
        const lock = request.lock === undefined ? now : longerLock(request.lock, now);
        held.request = { ...held.request, lock };
        hold = await this.holdFor(request, held.names, lock.seconds * 1000);
      }
      try {
        await this.journal(held.request, 'delivering', undefined, undefined, body.deliveryId);
      } catch {
        await this.letGo(hold);
        hold = undefined;
        throw new InputRequestError('unavailable', 'Ferretry could not record the attempt, so nothing was typed');
      }
      // Every value that is masked is held before it is typed, so a read racing the write already hides it.
      for (const [index, field] of fields.entries())
        if (maskedFromReads(field, typed))
          this.deps.values.hold(request.sessionId, (values[index] as InputFieldValue).text, request.agendaItemId);
      const outcome: TypeResult = await this.deps.target
        .type(request.sessionId, request.target, values, submitted, seen.facts)
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
      );
      await this.finish(held, 'delivered', undefined, by, {
        closeCard: true,
        tellAgent: true,
        submitted,
        ...(pasted === undefined ? {} : { sealed: true }),
        ...(body.entry === undefined ? {} : { entry: body.entry }),
        ...(saved === undefined ? {} : { saved: saved.ok }),
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
   * the saved login typed or kept, with its sign-in hosts. Total.
   */
  private async observeLogin(
    held: Held,
    facts: InputTargetFacts,
    values: readonly InputFieldValue[],
    submitted: boolean,
    deliveredAt: number,
    login: LoginEntryId | undefined,
  ): Promise<void> {
    const observer = this.deps.observer;
    const { request } = held;
    if (observer === undefined || request.target.kind === 'secret' || request.source !== undefined) return;
    try {
      const entry =
        login === undefined ? undefined : (await this.deps.logins?.entries())?.find(each => each.id === login);
      const secrets = request.fields
        .map((field, index) => (field.sensitivity === 'plain' ? undefined : values[index]?.text))
        .filter((text): text is string => text !== undefined);
      await observer.delivered({
        sessionId: request.sessionId,
        ...(entry === undefined ? {} : { login: entry.id }),
        domains: entry === undefined ? [] : loginDomainsOf(entry),
        target: request.target,
        facts,
        fields: request.fields,
        secrets,
        submitted,
        ...(held.matchKey === undefined ? {} : { matchKey: held.matchKey }),
        surfaces: [...held.names],
        since: Date.parse(request.raisedAt),
        deliveredAt,
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

  /** Every saved login's observed facts, for the lock; none when the store cannot be read (the lock stays long). */
  private async observedFacts(): Promise<readonly LoginObserved[]> {
    const entries = await this.deps.logins?.entries().catch(() => []);
    return (entries ?? []).flatMap(entry => entry.observed ?? []);
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

  private async fill(field: InputRequestField, entry: LoginEntryId): Promise<string> {
    const logins = this.deps.logins as InputLoginPort;
    const value = await logins
      .fill(entry, fillRoleFor(field.sensitivity), this.deps.clock.now())
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
    const surfaceNames = [...new Set([request.target.key, ...(seenNames ?? [])])].slice(0, 4);
    const names = request.target.kind === 'browser' ? surfaceNames.map(pageName) : surfaceNames;
    const hold = this.deps.quarantine.begin(request.sessionId, names, request.id, window);
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
    const matchKey = targetMatchKey(seen.facts, this.deps.hostName ?? '');
    if (matchKey !== undefined) held.matchKey = matchKey;
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
            observed: await this.observedFacts(),
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
    },
  ): Promise<void> {
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
            ...(options.saved === undefined ? {} : { saved: options.saved }),
          }
        : {}),
    });
    if (options.closeCard)
      await this.deps.agenda.close(
        request.sessionId,
        request.agendaItemId,
        noteOf(state, reason, request.target.kind, options.unsettled === true),
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
    return undefined;
  }

  private view({ request, names }: Held): InputAgentView {
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
          ? { note: `Waiting for the owner on ${request.agendaItemId}.` }
          : request.outcome?.by.kind === 'rule'
            ? { note: 'Pasted under a rule the owner approved in advance.' }
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
  if (!facts.recognisedConsumer)
    return {
      level: 'amber',
      reason:
        'The program reading the terminal is a bare shell or not one known to ask for secrets, so the value may land somewhere unexpected.',
    };
  return { level: 'green', reason: 'Typing is hidden and the program is one known to ask for a password.' };
}

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
