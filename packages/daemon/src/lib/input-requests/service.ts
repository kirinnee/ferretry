import {
  type AgendaId,
  INPUT_DEFAULT_EXPIRY_SECONDS,
  INPUT_ERROR_CODES,
  INPUT_JOURNAL_EVENT_TYPES,
  INPUT_MAX_CHECK_FAILURES,
  INPUT_MAX_PENDING_PER_SESSION,
  INPUT_MAX_RAISES_PER_HOUR,
  INPUT_PROMPT_MAX_LENGTH,
  INPUT_QUARANTINE_EVENT_TYPES,
  INPUT_QUARANTINE_SECONDS,
  type InputActor,
  type InputAgentView,
  type InputAuditDetail,
  type InputAuditEvent,
  type InputDeliverBody,
  type InputDeliverResult,
  type InputEvent,
  type InputQuarantine,
  type InputQuarantineEvent,
  type InputRaise,
  type InputReason,
  type InputRequest,
  type InputTarget,
  type InputTargetFacts,
  inputValueProblem,
  unpadInputValue,
} from '@ferretry/protocol';
import { digestFacts, digestLine } from './digest.ts';
import type { EphemeralValues } from './ephemeral-values.ts';
import { InputRequestError } from './errors.ts';
import type {
  InputAgendaPort,
  InputAgentNotifier,
  InputAudit,
  InputCaller,
  InputClock,
  InputIds,
  InputJournal,
  InputSessionDirectory,
  InputTargetPort,
  InputTimers,
  InputTrustedPrograms,
  TypeResult,
} from './ports.ts';
import type { QuarantineHold, QuarantineRegistry } from './quarantine.ts';
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

const TITLES = { secret: 'Needs a secret', private: 'Needs a code', plain: 'Needs an answer' } as const;

interface Held {
  request: InputRequest;
  checkFailures: number;
  /** Every `deliveryId` seen and what came of it, so a retry gets the first outcome and never types twice. */
  readonly deliveries: Map<string, Promise<InputDeliverResult>>;
  readonly waiters: Set<() => void>;
}

export interface InputRequestServiceDependencies {
  readonly target: InputTargetPort;
  readonly agenda: InputAgendaPort;
  readonly notifier: InputAgentNotifier;
  readonly journal: InputJournal;
  readonly audit: InputAudit;
  readonly clock: InputClock;
  readonly ids: InputIds;
  readonly timers: InputTimers;
  readonly trusted: InputTrustedPrograms;
  readonly sessions: InputSessionDirectory;
  readonly values: EphemeralValues;
  /** The terminals a secret was just typed into, which an agent may not read until the window ends. */
  readonly quarantine: QuarantineRegistry;
  /** Masks every known secret and every just-typed value in text shown to the owner; rejects when it cannot. */
  readonly redact: (text: string) => Promise<string>;
}

const instant = (ms: number): string => new Date(ms).toISOString();

const isFinal = (request: InputRequest): boolean => FINAL.has(request.state);

export class InputRequestService {
  private readonly held = new Map<string, Held>();
  private readonly raises = new Map<string, number[]>();
  private readonly lock = new SessionLock();

  constructor(private readonly deps: InputRequestServiceDependencies) {}

  /** The agent raises. Nothing in `raise` was observed; everything in the answer and the card was. */
  async raise(sessionId: string, raise: InputRaise): Promise<InputAgentView> {
    if (raise.target.kind !== 'terminal')
      throw new InputRequestError('bad_request', 'only terminal inputs can be requested for now');
    await this.sweep();
    return await this.lock.run(sessionId, async () => await this.admit(sessionId, raise, raise.target));
  }

  /** Runs `work` while no other raise, agent keystroke, close or secure write runs in this session. */
  async exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return await this.lock.run(sessionId, work);
  }

  private async admit(sessionId: string, raise: InputRaise, target: InputTarget): Promise<InputAgentView> {
    const now = this.deps.clock.now();
    this.guardRate(sessionId, target, now);
    const seen = await this.deps.target.observe(sessionId, target);
    if (!seen.ok) {
      throw new InputRequestError(
        seen.reason === 'target_gone' ? 'not_found' : 'bad_request',
        seen.reason === 'target_gone'
          ? `there is no terminal named ${target.key} in this session`
          : 'that target cannot take an input request',
      );
    }
    this.guardScope(raise, seen.facts);
    const shown = await this.project(sessionId, seen.facts, [target.key, ...(seen.names ?? [])]);
    const expiresAt = instant(now + (raise.expiresInSeconds ?? INPUT_DEFAULT_EXPIRY_SECONDS) * 1000);
    const requestId = this.deps.ids.requestId();
    const card = await this.deps.agenda.raise(sessionId, {
      requestId,
      title: TITLES[raise.sensitivity],
      ask: askOf(shown, raise.sensitivity),
      prompt: raise.prompt,
      blocking: raise.blocking ?? raise.sensitivity === 'secret',
      expiresAt,
      ...(raise.chain === undefined ? {} : { chain: raise.chain }),
    });
    if (!card.ok) throw new InputRequestError('unavailable', card.message);
    const request: InputRequest = {
      id: requestId,
      sessionId,
      agendaItemId: card.id,
      target: raise.target,
      prompt: raise.prompt,
      sensitivity: raise.sensitivity,
      submit: raise.submit,
      raisedAt: instant(now),
      expiresAt,
      ...(raise.chain === undefined ? {} : { chain: raise.chain }),
      observed: shown,
      observedDigest: digestFacts(seen.facts),
      state: 'pending',
    };
    try {
      await this.journal(request, 'requested');
    } catch {
      await this.deps.agenda.close(sessionId, card.id, 'Input request could not be recorded.');
      throw new InputRequestError('unavailable', 'Ferretry could not record the request, so it did not ask the owner');
    }
    this.held.set(requestId, { request, checkFailures: 0, deliveries: new Map(), waiters: new Set() });
    this.noteRaise(sessionId, now);
    await this.record(request, 'input.requested', { kind: 'agent' }, auditDetail(request));
    return this.view(request);
  }

  /**
   * The narrow v1: a terminal takes a `secret` only while the program is not echoing it, and a `plain` answer the
   * card calls visible. A code that echoes (`private`) is not typed by the daemon into a terminal yet, because
   * the screen would then hold it where the agent reads.
   */
  private guardScope(raise: InputRaise, facts: InputTargetFacts): void {
    if (raise.sensitivity === 'private')
      throw new InputRequestError(
        'bad_request',
        'a code that shows on screen cannot be typed for you into a terminal yet; ask the owner in chat to type it there',
      );
    if (raise.sensitivity === 'secret' && facts.kind === 'terminal' && facts.echo !== 'off')
      throw new InputRequestError(
        'conflict',
        facts.echo === 'on'
          ? 'the terminal is echoing what is typed, so a secret would show on screen; wait for a password prompt, or raise this as plain if it is not secret'
          : 'Ferretry could not tell whether the terminal echoes, so it will not ask for a secret here',
        INPUT_ERROR_CODES.echoOn,
      );
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
    return this.view(held.request);
  }

  /** The requests still open, newest last: for one session or, with none named, for all. Owner only. */
  async list(caller: InputCaller, sessionId?: string): Promise<readonly InputRequest[]> {
    requireOwner(caller);
    await this.sweep();
    const open = [...this.held.values()]
      .map(held => held.request)
      .filter(request => !isFinal(request) && (sessionId === undefined || request.sessionId === sessionId))
      .sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
    return await Promise.all(open.map(async request => await this.exposed(request)));
  }

  /**
   * The request as the owner's client may read it: the prompt line the terminal showed and the program's
   * command line pass the redactor (a screen can echo a value, and an argv can carry one), and are cut to
   * their limits again. Nothing here is the held copy, so the raw binding material stays in RAM.
   */
  private async exposed(request: InputRequest): Promise<InputRequest> {
    const facts = request.observed;
    const prompt = (await this.deps.redact(request.prompt)).slice(0, INPUT_PROMPT_MAX_LENGTH);
    if (facts === undefined) return { ...request, prompt };
    return { ...request, prompt, observed: await this.project(request.sessionId, facts, [request.target.key]) };
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

  private async project(
    sessionId: string,
    facts: InputTargetFacts,
    names: readonly string[],
  ): Promise<InputTargetFacts> {
    if (facts.kind !== 'terminal') return facts;
    if (this.quarantined(sessionId, names)) return maskedFacts(facts);
    const clip = async (text: string, limit: number): Promise<string> =>
      (await this.deps.redact(text)).slice(0, limit).trimEnd();
    return {
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
  }

  /** `text` with any value delivered to this session in the redaction window masked, for an agent's terminal reads. */
  scrub(sessionId: string, text: string): string {
    return this.deps.values.scrub(sessionId, text);
  }

  /** The pending request on a surface, so an agent cannot type into the field the owner has been asked about. */
  pendingOn(sessionId: string, target: { readonly kind: string; readonly key: string }): AgendaId | undefined {
    for (const { request } of this.held.values()) {
      if (request.sessionId !== sessionId || isFinal(request)) continue;
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
    return await this.exposed(held.request);
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
    for (const sessionId of sessionIds) {
      await this.restoreQuarantines(sessionId, now).catch(() => this.deps.quarantine.lockSession(sessionId));
    }
    this.deps.quarantine.unlock();
    for (const sessionId of sessionIds) {
      const latest = new Map<string, InputEvent>();
      for (const event of await this.deps.journal.history(sessionId)) {
        if (event.sessionId === sessionId) latest.set(event.requestId, event);
      }
      for (const event of latest.values()) await this.revive(event, now);
    }
  }

  /** A quarantine still running when the daemon stopped is running again, for the time it had left. */
  private async restoreQuarantines(sessionId: string, now: number): Promise<void> {
    let holds: { readonly hold?: string; readonly names: readonly string[]; readonly until: number }[] = [];
    for (const event of await this.deps.journal.quarantines(sessionId)) {
      if (event.sessionId !== sessionId) continue;
      if (event.type === INPUT_QUARANTINE_EVENT_TYPES.started) {
        const entry = { hold: event.hold, names: event.names, until: Date.parse(event.until) };
        holds = [...holds.filter(held => event.hold === undefined || held.hold !== event.hold), entry];
      } else if (event.hold !== undefined) holds = holds.filter(held => held.hold !== event.hold);
      else holds = holds.filter(held => !held.names.some(name => event.names.includes(name)));
    }
    for (const { names, until } of holds) if (until > now) this.deps.quarantine.restore(sessionId, names, until);
  }

  /** The terminals of a session kept from an agent's eyes now, for the owner's viewer. Owner only. */
  quarantines(caller: InputCaller, sessionId: string): readonly InputQuarantine[] {
    requireOwner(caller);
    return this.deps.quarantine.list(sessionId).map(({ key, until }) => ({ key, until: instant(until) }));
  }

  /** When a terminal's quarantine ends, for a reader that must refuse until then. */
  quarantinedUntil(sessionId: string, names: readonly (string | undefined)[]): number | undefined {
    return this.deps.quarantine.until(sessionId, names);
  }

  /** The owner opens a quarantined terminal to the agent again. Owner only; it is recorded and journalled. */
  async endQuarantine(caller: InputCaller, sessionId: string, key: string): Promise<void> {
    const owner = requireOwner(caller);
    const names = this.deps.quarantine.end(sessionId, key);
    if (names === undefined) throw new InputRequestError('not_found', `${key} is not quarantined`);
    const at = instant(this.deps.clock.now());
    await this.deps.journal
      .quarantine(sessionId, { type: INPUT_QUARANTINE_EVENT_TYPES.ended, sessionId, names: [...names], until: at, at })
      .catch(() => undefined);
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
    if (Date.parse(event.expiresAt) <= now || event.target.kind !== 'terminal') return;
    const prompt = await this.deps.agenda.promptOf(event.sessionId, event.agendaItemId);
    if (prompt === undefined || this.held.has(event.requestId)) return;
    const target: InputTarget = { kind: 'terminal', key: event.target.key };
    const request: InputRequest = {
      id: event.requestId,
      sessionId: event.sessionId,
      agendaItemId: event.agendaItemId,
      target,
      prompt,
      sensitivity: event.sensitivity,
      submit: event.submit ?? 'offer-owner',
      raisedAt: event.at,
      expiresAt: event.expiresAt,
      state: 'pending',
    };
    const held: Held = { request, checkFailures: 0, deliveries: new Map(), waiters: new Set() };
    this.held.set(request.id, held);
    const seen = await this.deps.target.observe(request.sessionId, target);
    if (!seen.ok) {
      await this.finish(held, 'cancelled', 'interrupted', undefined, { closeCard: true, tellAgent: true });
      return;
    }
    held.request = {
      ...request,
      observed: await this.project(request.sessionId, seen.facts, [target.key, ...(seen.names ?? [])]),
      observedDigest: digestFacts(seen.facts),
    };
  }

  /** A write was begun and never recorded as done: it may have landed, so the request ends and never types again. */
  private async interrupt(event: InputEvent): Promise<void> {
    if (this.held.has(event.requestId) || event.target.kind !== 'terminal') return;
    const prompt = (await this.deps.agenda.promptOf(event.sessionId, event.agendaItemId)) ?? 'input request';
    const request: InputRequest = {
      id: event.requestId,
      sessionId: event.sessionId,
      agendaItemId: event.agendaItemId,
      target: { kind: 'terminal', key: event.target.key },
      prompt,
      sensitivity: event.sensitivity,
      submit: event.submit ?? 'offer-owner',
      raisedAt: event.at,
      expiresAt: event.expiresAt ?? event.at,
      state: 'delivering',
    };
    const held: Held = { request, checkFailures: 0, deliveries: new Map(), waiters: new Set() };
    this.held.set(request.id, held);
    if (event.sensitivity === 'secret') await this.holdAfterRestart(request);
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

  private async attempt(held: Held, body: InputDeliverBody, by: InputActor): Promise<InputDeliverResult> {
    const { request } = held;
    const fail = async (code: InputReason, error: InputRequestError): Promise<never> => {
      await this.checkFailed(held, code);
      throw error;
    };
    held.request = { ...request, state: 'delivering' };
    let hold: QuarantineHold | undefined;
    try {
      if (body.secretName !== undefined)
        throw new InputRequestError('bad_request', 'saved secrets are not available yet; type the value instead');
      const value = body.padded === undefined ? undefined : unpadInputValue(body.padded);
      if (value === undefined)
        throw new InputRequestError('bad_request', 'the value was not sent in the expected form');
      const problem = inputValueProblem(value, request.sensitivity);
      if (problem !== undefined) throw new InputRequestError('bad_request', problem);
      if (body.observedDigest !== request.observedDigest) return await fail('target_changed', targetChanged());
      const submitted = body.submit && request.submit !== 'agent';
      const seen = await this.deps.target.observe(request.sessionId, request.target);
      if (!seen.ok) return await fail('target_gone', targetChanged());
      if (digestFacts(seen.facts) !== request.observedDigest) return await fail('target_changed', targetChanged());
      const refusal = this.consumerRefusal(
        request,
        seen.facts,
        await this.project(request.sessionId, seen.facts, [request.target.key, ...(seen.names ?? [])]),
        body,
      );
      if (refusal !== undefined) return await fail(refusal.reason, refusal.error);
      if (request.sensitivity === 'secret') hold = await this.holdFor(request, seen.names);
      try {
        await this.journal(request, 'delivering', undefined, undefined, body.deliveryId);
      } catch {
        await this.letGo(request, hold);
        hold = undefined;
        throw new InputRequestError('unavailable', 'Ferretry could not record the attempt, so nothing was typed');
      }
      if (request.sensitivity === 'secret') this.deps.values.hold(request.sessionId, value, request.agendaItemId);
      const typed: TypeResult = await this.deps.target
        .type(request.sessionId, request.target, value, submitted, seen.facts)
        .catch((): TypeResult => 'uncertain');
      if (typed === 'uncertain') {
        await this.settle(request, hold);
        hold = undefined;
        await this.finish(held, 'refused', 'interrupted', undefined, {
          closeCard: true,
          tellAgent: true,
          uncertain: true,
        });
        throw new InputRequestError(
          'unavailable',
          'Ferretry could not confirm the value was typed cleanly, so it stopped and will not type it again; check the terminal',
        );
      }
      if (typed !== 'typed') {
        await this.letGo(request, hold);
        hold = undefined;
        await this.journalQuietly({ ...held.request, state: 'pending' }, 'requested');
        return await fail(typed, targetChanged());
      }
      await this.settle(request, hold);
      hold = undefined;
      await this.finish(held, 'delivered', undefined, by, { closeCard: true, tellAgent: true, submitted });
      return {
        id: request.id,
        deliveryId: body.deliveryId,
        state: 'delivered',
        submitted,
      };
    } catch (error) {
      // A hold still open here is for a write that may have started: it runs its window rather than lifting.
      await this.settle(request, hold);
      if (held.request.state === 'delivering') held.request = { ...held.request, state: 'pending' };
      throw error;
    }
  }

  /**
   * The terminal is held BEFORE the value is typed, and the hold is journalled before anything is written. If
   * the journal cannot take it nothing is typed: a hold that a restart would not bring back is no hold. The
   * hold belongs to this attempt alone and cannot expire while the write is in flight; a pre-write end time
   * of two windows covers the write landing late, and {@link settle} replaces it with the exact one.
   */
  private async holdFor(request: InputRequest, seenNames: readonly string[] | undefined): Promise<QuarantineHold> {
    const names = [...new Set([request.target.key, ...(seenNames ?? [])])].slice(0, 4);
    const hold = this.deps.quarantine.begin(request.sessionId, names);
    try {
      await this.journalHold(
        request,
        hold,
        INPUT_QUARANTINE_EVENT_TYPES.started,
        this.deps.clock.now() + 2 * QUARANTINE_MS,
      );
    } catch {
      this.deps.quarantine.release(hold);
      throw new InputRequestError('unavailable', 'Ferretry could not record the quarantine, so nothing was typed');
    }
    return hold;
  }

  /** The write was made, or may have been: this hold now runs a full window from here. */
  private async settle(request: InputRequest, hold: QuarantineHold | undefined): Promise<void> {
    if (hold === undefined) return;
    const until = this.deps.quarantine.settle(hold);
    await this.journalHold(request, hold, INPUT_QUARANTINE_EVENT_TYPES.started, until).catch(() => undefined);
  }

  /** Nothing was typed after all: this attempt's hold is let go. Another delivery's hold on the terminal stays. */
  private async letGo(request: InputRequest, hold: QuarantineHold | undefined): Promise<void> {
    if (hold === undefined) return;
    this.deps.quarantine.release(hold);
    const at = this.deps.clock.now();
    await this.journalHold(request, hold, INPUT_QUARANTINE_EVENT_TYPES.ended, at).catch(() => undefined);
  }

  /** A write was begun before a restart and never recorded as done: the terminal is held again for a full window. */
  private async holdAfterRestart(request: InputRequest): Promise<void> {
    const hold = this.deps.quarantine.begin(request.sessionId, [request.target.key]);
    await this.settle(request, hold);
  }

  private async journalHold(
    request: InputRequest,
    hold: QuarantineHold,
    type: InputQuarantineEvent['type'],
    until: number,
  ): Promise<void> {
    await this.deps.journal.quarantine(request.sessionId, {
      type,
      sessionId: request.sessionId,
      names: [...hold.names],
      hold: `${request.id}/${hold.id}`,
      until: instant(until),
      at: instant(this.deps.clock.now()),
    });
  }

  private consumerRefusal(
    request: InputRequest,
    facts: InputTargetFacts,
    shown: InputTargetFacts,
    body: InputDeliverBody,
  ): { reason: InputReason; error: InputRequestError } | undefined {
    if (facts.kind !== 'terminal') return undefined;
    if (request.sensitivity === 'secret' && facts.echo !== 'off')
      return {
        reason: 'echo_on',
        error: new InputRequestError(
          'conflict',
          facts.echo === 'on'
            ? 'the terminal is echoing what is typed, so a secret would show on screen'
            : 'Ferretry could not tell whether the terminal echoes, so it will not type a secret',
          INPUT_ERROR_CODES.echoOn,
        ),
      };
    if (
      request.sensitivity !== 'plain' &&
      !facts.recognisedConsumer &&
      !this.deps.trusted.isTrusted(digestLine(facts.foreground.comm))
    ) {
      if (body.trustProgram !== true)
        return {
          reason: 'not_secret_field',
          error: new InputRequestError(
            'conflict',
            `${shown.kind === 'terminal' ? shown.foreground.comm : 'this program'} is not a program Ferretry knows asks for secrets; tick "I trust this program" to type anyway`,
            'trust_required',
          ),
        };
      this.deps.trusted.trust(digestLine(facts.foreground.comm));
    }
    return undefined;
  }

  /** A check failed: nothing was typed. Three failures end the request; fewer leave it pending. */
  private async checkFailed(held: Held, reason: InputReason): Promise<void> {
    held.checkFailures += 1;
    held.request = { ...held.request, state: 'pending' };
    if (held.checkFailures >= INPUT_MAX_CHECK_FAILURES)
      await this.finish(held, 'refused', 'check_failures', undefined, { closeCard: true, tellAgent: true });
    else await this.record(held.request, 'input.refused', { kind: 'daemon' }, { ...auditDetail(held.request), reason });
  }

  private async finish(
    held: Held,
    state: 'delivered' | 'refused' | 'expired' | 'cancelled',
    reason: InputReason | undefined,
    by: InputActor | undefined,
    options: { closeCard: boolean; tellAgent: boolean; submitted?: boolean; uncertain?: boolean },
  ): Promise<void> {
    const at = instant(this.deps.clock.now());
    const outcome =
      state === 'delivered' && by !== undefined
        ? { at, by, submitted: options.submitted ?? false, source: 'typed' as const }
        : undefined;
    const seenDetail = auditDetail(held.request, this.quarantined(held.request.sessionId, [held.request.target.key]));
    const { observed: _seen, observedDigest: _digest, ...rest } = held.request;
    held.request = {
      ...rest,
      state,
      ...(outcome === undefined ? {} : { outcome }),
    };
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
      ...seenDetail,
      ...(reason === undefined ? {} : { reason }),
      ...(state === 'delivered' ? { source: 'typed' as const, submitted: options.submitted ?? false } : {}),
    });
    if (options.closeCard) await this.deps.agenda.close(request.sessionId, request.agendaItemId, noteOf(state, reason));
    if (options.tellAgent)
      await this.deps.notifier.tell(
        request.sessionId,
        request.agendaItemId,
        tellOf(request, state, reason, options.uncertain === true),
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

  private view(request: InputRequest): InputAgentView {
    const quarantined = this.quarantined(request.sessionId, [request.target.key]);
    const facts =
      request.observed?.kind === 'terminal' && quarantined ? maskedFacts(request.observed) : request.observed;
    const terminal = facts?.kind === 'terminal' ? facts : undefined;
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
      ...(request.outcome === undefined
        ? {}
        : { submitted: request.outcome.submitted, source: request.outcome.source }),
      ...(request.state === 'pending' ? { note: `Waiting for the owner on ${request.agendaItemId}.` } : {}),
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

function targetChanged(): InputRequestError {
  return new InputRequestError(
    'conflict',
    'what is on the terminal is no longer what the card showed; nothing was typed',
    INPUT_ERROR_CODES.targetChanged,
  );
}

const PLAIN_FLAG = 'Not secret: the ferret can see this value.';

function askOf(facts: InputTargetFacts, sensitivity: InputRequest['sensitivity']): string {
  const where = facts.kind === 'terminal' ? `Type it into ${facts.foreground.comm}` : 'Type it into the page';
  return sensitivity === 'plain' ? `${where}. ${PLAIN_FLAG}` : where;
}

function auditDetail(request: InputRequest, quarantined = false): InputAuditDetail {
  const facts = request.observed;
  return {
    targetKind: request.target.kind,
    sensitivity: request.sensitivity,
    ...(facts?.kind === 'terminal'
      ? { consumer: quarantined ? QUARANTINE_NOTICE : facts.foreground.comm, recognised: facts.recognisedConsumer }
      : {}),
  };
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

function noteOf(state: string, reason: InputReason | undefined): string {
  return reason === undefined ? `Input request ${state}.` : `Input request ${state}: ${reason.replaceAll('_', ' ')}.`;
}

function tellOf(request: InputRequest, state: string, reason: InputReason | undefined, uncertain: boolean): string {
  if (uncertain)
    return `${request.agendaItemId} was interrupted while the owner's value was going into %terminal:${request.target.key}; it may be partly or fully typed there. Read the terminal before you act, and ask in chat if you still need it.`;
  if (state === 'delivered')
    return `${request.agendaItemId} was answered and typed into %terminal:${request.target.key}. Read the terminal to continue.`;
  return `${request.agendaItemId} ended without a value (${state}${reason === undefined ? '' : `: ${reason.replaceAll('_', ' ')}`}). Ask in chat if you still need it.`;
}
