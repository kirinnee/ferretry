/**
 * The daemon side of a UI-driven harness login.
 *
 * ## The one property everything else serves
 *
 * **This daemon never holds a token.** It launches the harness's own login, publishes at most two
 * values out of what that child printed, forwards at most one value in, and lets the harness write its
 * own credential into its own store. There is no field on this object, no field on a record, and no
 * field on the wire that a token could occupy. `docs/design/harness-login.md` §3.2 is the argument and
 * `docs/secrets.md:38-42` is the rule.
 *
 * The one credential in the flow is Claude's authorization code, and it is bound to a PKCE verifier that
 * lives inside the child — observable in the URL the child prints
 * (`code_challenge_method=S256`, claude-code 2.1.220). It is written to a pipe and dropped.
 * **Non-retention is the protection here, not redaction**: the secrets redactor masks values the vault
 * holds, and this value is never stored anywhere for it to mask.
 *
 * ## TWO FLOWS, DISPATCHED, NOT ABSTRACTED
 *
 * `./claude-flow.ts` and `./codex-flow.ts` are two sets of pure functions over two different stage
 * unions. This service holds one of them per record as a tagged union and switches on the tag. There is
 * no base class, no shared driver and no parameterised program table: what the two harnesses have in
 * common is a child process and a deadline, which are this file's business, and what they do not have in
 * common is the entire login.
 *
 * ## One credential at a time
 *
 * A sign-in names one account-model CREDENTIAL (design §4.6). The harness's own login is launched with
 * that credential's STORE in its environment, so an empty slot nothing uses yet can be signed in, and
 * every runtime that names it reads the login this wrote. A sign-in that exits zero but leaves the
 * store with no usable login is a FAILURE.
 *
 * ## What is refused, and why each refusal is its own
 *
 * - **A credential that is not a login** — one from the environment, or one this machine cannot reach.
 *   The credentials surface says why in words; offering it would be a control that cannot succeed.
 * - **A second flow for one credential** — two logins into one store race for it. This service can only
 *   be single-flight within itself, and it says so.
 * - **A harness that is not installed** — nothing to launch.
 * - **A flow that recognised nothing** — it ends as ITSELF, saying this host's harness did not offer a
 *   remotable login and naming the host command. Never a hang, never a bare exit code. Both flows depend
 *   on somebody else's output format, and one of them depends on an UNDOCUMENTED flag
 *   (`codex login --device-auth`, empty description at 0.145.0), so this is the path that keeps a
 *   third-party change from becoming an outage.
 *
 * ## One Codex flow, two children, in turn
 *
 * A Codex flow can move from a device code to Codex's link sign-in — by itself when Codex says device
 * codes are unavailable, or when the person asks. The flow keeps its id, its window and the password its
 * start proved; the device child is killed and the link child launched in its place. `relaunch` on the
 * record is what tells the run loop that this exit was the switch and not the end.
 *
 * The link sign-in's return trip is an ADDRESS, carrying an authorization code. It goes from
 * {@link HarnessLoginService.submit} through the Codex flow's check to the delivery port and nowhere
 * else, exactly as Claude's code goes to stdin and nowhere else.
 */
import { type HarnessKind, sanitizeHarnessEnv } from '@ferretry/fleet';
import type {
  HarnessLoginFlow,
  HarnessLoginStartRequest,
  HarnessLoginSubmission,
  HarnessLoginSubmitRequest,
} from '@ferretry/protocol';
import type { CallerGovernance, ChangeConfirmation } from '../api/capability.ts';
import { type CredentialSignInTarget, FleetCredentialRefusal } from '../fleet/credentials-service.ts';
import {
  CLAUDE_LOGIN_ARGV,
  CLAUDE_LOGIN_START,
  type ClaudeLoginFailure,
  type ClaudeLoginStage,
  claudeCodeSent,
  claudeEnding,
  claudeProjection,
  decideClaudeSubmit,
  observeClaudeLine,
} from './claude-flow.ts';
import {
  CODEX_LINK_LOGIN_ARGV,
  CODEX_LINK_START,
  CODEX_LOGIN_ARGV,
  CODEX_LOGIN_START,
  type CodexLoginFailure,
  type CodexLoginStage,
  codexAutomaticLink,
  codexDelivering,
  codexEnding,
  codexProjection,
  decideCodexSubmit,
  observeCodexLine,
} from './codex-flow.ts';
import type {
  HarnessLoginCallbackDeliver,
  HarnessLoginChild,
  HarnessLoginFlowBase,
  HarnessLoginSpawn,
  HarnessLoginTimer,
} from './ports.ts';

/** Every refusal this surface answers with, so a client branches on cause rather than on prose. */
export type HarnessLoginRefusalCode =
  | 'fleet_login_unavailable'
  | 'fleet_login_in_progress'
  | 'fleet_login_unknown'
  | 'fleet_login_unauthorized';

export class HarnessLoginRefusal extends Error {
  constructor(
    readonly code: HarnessLoginRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessLoginRefusal';
  }
}

export interface DaemonHarnessLoginOptions {
  readonly clock: { now(): number };
  /** A flow handle. Supplied, so identity is never clock-derived and therefore never guessable. */
  readonly mintId: () => string;
  readonly spawn: HarnessLoginSpawn;
  /** Delivers a checked Codex callback address to Codex's own listener on this machine. */
  readonly deliverCallback: HarnessLoginCallbackDeliver;
  /** This process's environment, which is sanitized before any child sees it. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timer: HarnessLoginTimer;
  /**
   * Proves the operator password for ONE start.
   *
   * The same closure shape the fleet's proposal apply takes, and for the same reason: this service must
   * be able to ask "was this password right" without being able to read one, hold one, or reach anything
   * else the grant service can do. The attempt it spends is one of the same five an unlock spends, so
   * there is no second budget and no second gate.
   */
  readonly confirmChange: (password: string) => Promise<ChangeConfirmation>;
  /** What a person types to run this binary, so a refusal names a command they actually have. */
  readonly clientName: string;
  /** How long a flow may live. Bounded in minutes, like the browser login window's one-to-sixty. */
  readonly windowMinutes?: number;
  /** Resolves a credential id to what a sign-in for it launches (account model §4.6). */
  readonly credentialTargets: { target(credentialId: string): Promise<CredentialSignInTarget> };
  /** The harness command, by this daemon's one rule. A sign-in launches it directly. */
  readonly locate: (harness: HarnessKind) => string | undefined;
}

/** The default login window. Long enough to find a phone, short enough that a stray child is not forever. */
export const HARNESS_LOGIN_WINDOW_MINUTES = 10;

/** How many settled flows are kept so a poller can still read its own outcome. */
const RETAINED_FLOWS = 8;

/** One harness's stage, tagged so this service can dispatch without either flow knowing the other. */
type FlowStage =
  | { readonly harness: 'claude'; readonly stage: ClaudeLoginStage }
  | { readonly harness: 'codex'; readonly stage: CodexLoginStage };

interface FlowRecord {
  readonly flowId: string;
  readonly credentialId: string;
  readonly identityKey: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  stage: FlowStage;
  child: HarnessLoginChild | undefined;
  disarm: (() => void) | undefined;
  /** True once a child was launched, so "nothing was recognised" is distinguishable from "never ran". */
  spawned: boolean;
  /** The running child is being replaced (a Codex device code moving to a link), so its exit is not the end. */
  relaunch: boolean;
}

const settled = (stage: FlowStage): boolean => stage.stage.stage === 'complete' || stage.stage.stage === 'failed';

const CODEX_PUBLISHED: ReadonlySet<CodexLoginStage['stage']> = new Set([
  'awaiting-approval',
  'awaiting-callback',
  'finishing',
]);

const published = (stage: FlowStage): boolean =>
  stage.harness === 'claude' ? stage.stage.stage === 'awaiting-code' : CODEX_PUBLISHED.has(stage.stage.stage);

const instant = (milliseconds: number): string => new Date(Math.trunc(milliseconds)).toISOString();

/** What to run for this flow's current stage. A Codex flow in `linking` runs the link sign-in. */
const argvFor = (stage: FlowStage): readonly string[] => {
  if (stage.harness === 'claude') return CLAUDE_LOGIN_ARGV;
  return stage.stage.stage === 'linking' ? CODEX_LINK_LOGIN_ARGV : CODEX_LOGIN_ARGV;
};

export class HarnessLoginService {
  readonly #flows = new Map<string, FlowRecord>();

  constructor(private readonly options: DaemonHarnessLoginOptions) {}

  /**
   * Sign one account-model CREDENTIAL in (design §4.6, E12, E31).
   *
   * The harness's OWN login is launched with that credential's store in its environment — so an empty slot nothing uses yet can be signed
   * in, and every runtime that later names it reads the login this wrote. Same gate, same order: every
   * refusal the document can answer is answered before a password attempt is spent.
   */
  async start(request: HarnessLoginStartRequest, governance: CallerGovernance | undefined): Promise<HarnessLoginFlow> {
    // Absent governance is refused rather than waved through. It cannot arise through the served route,
    // which declares a capability and therefore always has one built, and the safe reading of "nobody
    // can tell me where this caller stands" is not "launch a harness on the host".
    if (governance === undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unauthorized',
        'this daemon cannot say whether this caller may sign this machine in',
      );
    }
    const credentialId = request.credentialId;
    let target: CredentialSignInTarget;
    try {
      target = await this.options.credentialTargets.target(credentialId);
    } catch (error) {
      if (error instanceof FleetCredentialRefusal)
        throw new HarnessLoginRefusal('fleet_login_unavailable', error.message);
      throw error;
    }
    if (target.kind === 'refused') throw new HarnessLoginRefusal('fleet_login_unavailable', target.reason);
    if (target.harness === 'claude' && request.method !== undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unavailable',
        'Claude Code has one way to sign in; choosing a device code or a link applies to Codex only',
      );
    }
    // Every refusal the document can answer is answered before a password attempt is spent.
    this.#assertKeyFree(credentialId);
    if (governance.confirmChange) await this.#confirm(credentialId, request.operatorPassword);
    return this.#launch(target, request.method === 'link');
  }

  /** This flow as it stands, expiring it first if its window has closed. */
  async status(flowId: string): Promise<HarnessLoginFlow> {
    return this.#projection(this.#require(flowId));
  }

  /**
   * Forward the one value a person brings back, or move a Codex device code to a link.
   *
   * Claude's value is passed straight to the child's stdin and to nothing else. Codex's address is
   * checked by its flow and delivered to Codex's own listener and to nothing else. Neither is held on the
   * record, put in the answer, or named in any refusal.
   */
  async submit(flowId: string, request: HarnessLoginSubmitRequest): Promise<HarnessLoginSubmission> {
    const record = this.#require(flowId);
    const stage = record.stage;
    if (stage.harness === 'codex') return await this.#submitCodex(record, stage.stage, request);
    if ('method' in request) {
      return { outcome: 'refused', reason: 'Claude Code has one way to sign in, so there is nothing to switch to' };
    }
    const value = request.code;
    const decision = decideClaudeSubmit(stage.stage);
    if (decision.decision !== 'write') return { outcome: decision.decision, reason: decision.reason };
    // Marked BEFORE the write, so a refusal Claude sends back straight away lands on top of this rather
    // than under it — and so the previous refusal is not read as a verdict on this code.
    record.stage = { harness: 'claude', stage: claudeCodeSent(stage.stage) };

    const write = record.child?.write ?? (async () => false);
    const accepted = await write(`${value}\n`);
    return accepted
      ? { outcome: 'accepted', flow: this.#projection(record) }
      : {
          outcome: 'unconfirmed',
          reason:
            'the harness was no longer reading, so nobody can say whether that code arrived; check whether this login is signed in before trying again',
        };
  }

  /** A Codex flow's submission: a switch to the link sign-in, or the address it ended on. */
  async #submitCodex(
    record: FlowRecord,
    stage: CodexLoginStage,
    request: HarnessLoginSubmitRequest,
  ): Promise<HarnessLoginSubmission> {
    const decision = decideCodexSubmit(stage, request);
    if (decision.decision === 'switch') {
      this.#switchToLink(record, CODEX_LINK_START);
      return { outcome: 'accepted', flow: this.#projection(record) };
    }
    if (decision.decision !== 'deliver') return { outcome: decision.decision, reason: decision.reason };
    // Marked BEFORE the delivery, so a second address sent while this one is in flight is refused.
    record.stage = { harness: 'codex', stage: codexDelivering() };
    const outcome = await this.options.deliverCallback(decision.delivery);
    if (outcome === 'delivered') return { outcome: 'accepted', flow: this.#projection(record) };
    if (outcome === 'refused') {
      // Codex said it was not waiting for this and kept waiting, so the screen goes back to the paste box.
      if (record.stage.harness === 'codex' && record.stage.stage.stage === 'finishing')
        record.stage = { harness: 'codex', stage };
      return {
        outcome: 'refused',
        reason:
          'Codex was not waiting for that address. Use the link on this screen, then paste the address it leads to.',
      };
    }
    return {
      outcome: 'unconfirmed',
      reason:
        'Codex was no longer listening, so nobody can say whether that address arrived; check whether this login is signed in before trying again',
    };
  }

  /** Replace a Codex device-code child with the link sign-in, inside this same flow. */
  #switchToLink(record: FlowRecord, stage: CodexLoginStage): void {
    record.stage = { harness: 'codex', stage };
    if (record.child === undefined) return;
    record.relaunch = true;
    record.child.kill();
  }

  /** End this flow and its child. */
  async cancel(flowId: string): Promise<HarnessLoginFlow> {
    const record = this.#require(flowId);
    this.#end(record, 'this sign-in was cancelled');
    return this.#projection(record);
  }

  // ─── refusals ───────────────────────────────────────────────────────────────────────────────────

  /**
   * One flow per credential at a time.
   *
   * Two logins into one store race for it. So this is single-flight WITHIN this daemon, and the
   * refusal says which flow holds the credential rather than implying nothing else can.
   */
  #assertKeyFree(key: string): void {
    for (const record of this.#flows.values()) {
      if (record.identityKey !== key || settled(record.stage)) continue;
      throw new HarnessLoginRefusal(
        'fleet_login_in_progress',
        `a sign-in for "${key}" is already running as flow "${record.flowId}"; finish or cancel it first`,
      );
    }
  }

  /** Prove the operator password against THIS sign-in, or refuse in words naming the next step. */
  async #confirm(identityKey: string, password: string | undefined): Promise<void> {
    const refuse = (message: string): never => {
      throw new HarnessLoginRefusal('fleet_login_unauthorized', message);
    };
    if (password === undefined) {
      return refuse(
        `signing "${identityKey}" in from off this host needs this machine's operator password, entered against this exact sign-in`,
      );
    }
    const outcome = await this.options.confirmChange(password);
    if (outcome.kind === 'confirmed') return;
    if (outcome.reason === 'rate-limited') {
      return refuse(
        `too many wrong operator passwords have been tried on this machine, so it is not checking any more of them for now; "${identityKey}" was not signed in. Wait for the lockout to pass, or clear it on the host with \`${this.options.clientName} daemon password set\`.`,
      );
    }
    if (outcome.reason === 'no-password') {
      // Handled because the port declares it, not because it can still happen: a machine can no longer
      // go from having a password to not having one while it runs. A branch that stopped answering would
      // tell somebody they mistyped a password on a machine that has none.
      return refuse(
        `this machine has no operator password, so the confirmation for "${identityKey}" could not be checked`,
      );
    }
    return refuse(`that is not this machine's operator password, so "${identityKey}" was not signed in`);
  }

  // ─── the flow ───────────────────────────────────────────────────────────────────────────────────

  #launch(target: Extract<CredentialSignInTarget, { kind: 'store' }>, link: boolean): HarnessLoginFlow {
    // Checked AGAIN, and this is the check that holds: `start`'s copy runs before the password is
    // proved, and that proof is an await, so two starts for one credential can both pass it. Nothing
    // between here and the record landing in `#flows` awaits, so the later of the two is refused here.
    this.#assertKeyFree(target.credentialId);
    const record = this.#record(target.harness, target.credentialId, link);
    // Deliberately not awaited: a start answers with the flow so a surface can begin polling, and the
    // login itself takes as long as a person takes. Every failure is recorded on the record, so nothing
    // here can reject into an unhandled rejection.
    void this.#run(target, record);
    return this.#projection(record);
  }

  #record(harness: HarnessKind, credentialId: string, link: boolean): FlowRecord {
    this.#prune();
    const startedAt = this.options.clock.now();
    const window = (this.options.windowMinutes ?? HARNESS_LOGIN_WINDOW_MINUTES) * 60_000;
    const record: FlowRecord = {
      flowId: this.options.mintId(),
      credentialId,
      identityKey: credentialId,
      startedAt,
      expiresAt: startedAt + window,
      stage:
        harness === 'claude'
          ? { harness: 'claude', stage: CLAUDE_LOGIN_START }
          : { harness: 'codex', stage: link ? CODEX_LINK_START : CODEX_LOGIN_START },
      child: undefined,
      disarm: undefined,
      spawned: false,
      relaunch: false,
    };
    this.#flows.set(record.flowId, record);
    record.disarm = this.options.timer.after(window, () => {
      this.#expire(record);
    });
    return record;
  }

  /**
   * Launch the harness's own login against one credential's store, and prove the store afterwards.
   *
   * The environment is sanitized, then given the store's variables, so a sign-in started from inside an
   * agent session cannot authenticate against that session's login.
   */
  async #run(target: Extract<CredentialSignInTarget, { kind: 'store' }>, record: FlowRecord): Promise<void> {
    try {
      const binary = this.options.locate(target.harness);
      if (binary === undefined) {
        this.#end(
          record,
          `the ${target.harness} command is not installed on this machine, so there is nothing to sign in with`,
        );
        return;
      }
      await target.prepare();
      if (settled(record.stage)) return;
      let code: number;
      do {
        record.relaunch = false;
        record.spawned = true;
        const child = this.options.spawn({
          command: [binary, ...target.arguments, ...argvFor(record.stage)],
          environment: { ...sanitizeHarnessEnv(this.options.environment), ...target.environment },
          onLine: line => this.#observe(record, line),
        });
        record.child = child;
        code = await child.exited;
        record.child = undefined;
        if (settled(record.stage)) return;
      } while (record.relaunch);
      // Asked BEFORE "was anything published": a link sign-in whose ports were taken never printed a
      // link, and saying why is worth more than saying it offered nothing.
      const ending = this.#ending(record.stage, { exit: code });
      if (ending !== undefined) {
        this.#endWith(record, ending);
        return;
      }
      if (!published(record.stage)) {
        this.#end(
          record,
          `this host's ${record.stage.harness} did not offer a sign-in that can be driven from a browser`,
        );
        return;
      }
      if (code !== 0) {
        this.#end(record, `the sign-in exited with code ${code}`);
        return;
      }
      if (!(await target.signedIn())) {
        this.#end(record, 'the sign-in finished, but no usable login was written for this credential');
        return;
      }
      this.#finish(record);
    } catch (error) {
      this.#end(record, error instanceof Error && error.message.length > 0 ? error.message : 'the sign-in failed');
    }
  }

  /** Feed one raw output line to this harness's own recogniser. Unclassified lines are dropped. */
  #observe(record: FlowRecord, line: string): void {
    const stage = record.stage;
    if (stage.harness === 'claude') {
      record.stage = { harness: 'claude', stage: observeClaudeLine(stage.stage, line) };
      return;
    }
    const next = observeCodexLine(stage.stage, line);
    // Codex could not get a device code at all: move on to the link sign-in by itself.
    if (next.stage === 'device-unavailable') this.#switchToLink(record, codexAutomaticLink());
    else record.stage = { harness: 'codex', stage: next };
  }

  /** Record that the sign-in completed, unless this flow had already ended. */
  #finish(record: FlowRecord): void {
    if (settled(record.stage)) return;
    record.disarm?.();
    record.disarm = undefined;
    record.stage =
      record.stage.harness === 'claude'
        ? { harness: 'claude', stage: { stage: 'complete' } }
        : { harness: 'codex', stage: { stage: 'complete' } };
  }

  /** End this flow and its child, keeping whatever outcome it already reached. */
  #end(record: FlowRecord, reason: string): void {
    const remedy = `sign this login in on the host with \`${this.options.clientName} credential signin ${record.credentialId}\``;
    this.#endWith(record, { stage: 'failed', reason, remedy });
  }

  /**
   * End this flow with a failure that has already been decided — the ordinary one {@link #end} builds,
   * or a code ending from the harness's own flow, whose remedy is a fresh code rather than the host CLI.
   */
  #endWith(record: FlowRecord, failed: ClaudeLoginFailure | CodexLoginFailure): void {
    if (settled(record.stage)) return;
    record.disarm?.();
    record.disarm = undefined;
    record.child?.kill();
    record.child = undefined;
    record.stage =
      record.stage.harness === 'claude' ? { harness: 'claude', stage: failed } : { harness: 'codex', stage: failed };
  }

  /**
   * The window closed. A flow a person was acting on — a link or a code on their screen — ends by saying
   * THAT expired, because the host command the ordinary ending names is not what they need next.
   */
  #expire(record: FlowRecord): void {
    const ending = this.#ending(record.stage, 'window');
    if (ending === undefined) this.#end(record, 'this sign-in ran out of time before it finished');
    else this.#endWith(record, ending);
  }

  /** The harness's own reading of how this flow ends because of its code, if it does. */
  #ending(
    stage: FlowStage,
    cause: 'window' | { readonly exit: number },
  ): ClaudeLoginFailure | CodexLoginFailure | undefined {
    return stage.harness === 'claude' ? claudeEnding(stage.stage, cause) : codexEnding(stage.stage, cause);
  }

  /** This flow, or a refusal. A window that has closed ends the flow before it is read. */
  #require(flowId: string): FlowRecord {
    const record = this.#flows.get(flowId);
    if (record === undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unknown',
        `no sign-in "${flowId}" is running on this host; it may have finished or run out of time`,
      );
    }
    if (this.options.clock.now() >= record.expiresAt) {
      this.#expire(record);
    }
    return record;
  }

  #projection(record: FlowRecord): HarnessLoginFlow {
    const base: HarnessLoginFlowBase = {
      flowId: record.flowId,
      credentialId: record.credentialId,
      identity: record.identityKey,
      startedAt: instant(record.startedAt),
      expiresAt: instant(record.expiresAt),
    };
    const stage = record.stage;
    return stage.harness === 'claude' ? claudeProjection(base, stage.stage) : codexProjection(base, stage.stage);
  }

  /**
   * Keep the most recent settled flows so a poller can read its own outcome, and drop the rest.
   *
   * Recency is INSERTION ORDER, which a `Map` preserves — not `startedAt`. Two flows started inside the
   * same millisecond carry the same instant, so a sort on the clock would drop an arbitrary pair of
   * them and a poller would sometimes find its own flow gone and sometimes not. Insertion order is the
   * only ordering this service can state truthfully.
   */
  #prune(): void {
    const done = [...this.#flows.values()].filter(record => settled(record.stage));
    for (const record of done.slice(0, Math.max(0, done.length - RETAINED_FLOWS))) {
      this.#flows.delete(record.flowId);
    }
  }
}
