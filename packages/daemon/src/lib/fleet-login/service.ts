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
 * - **A harness that is not installed** — nothing to launch.
 * - **A flow that recognised nothing** — it ends as ITSELF, saying this host's harness did not offer a
 *   remotable login and naming the host command. Never a hang, never a bare exit code. Both flows depend
 *   on somebody else's output format, and one of them depends on an UNDOCUMENTED flag
 *   (`codex login --device-auth`, empty description at 0.145.0), so this is the path that keeps a
 *   third-party change from becoming an outage.
 *
 * ## One flow per credential, PICKED UP rather than refused
 *
 * Two logins into one store race for it, so a credential has at most one running flow. A second start
 * for it does not launch another and does not refuse either: it answers with the flow already running,
 * marked `resumed`. A person whose page reloaded, whose phone slept or who opened the sign-in from a
 * different screen (setup, Credentials, `fy credential signin`) lands back on the link and code they
 * already had, instead of on an error naming a flow they cannot reach. Every caller here holds the same
 * `fleet`/`configure` authority a status read needs, so picking a flow up shows nobody anything new.
 *
 * `restart` is the other answer: end the running flow, wait for its child to exit — a Codex link
 * sign-in holds this machine's callback port until it does — and start a fresh one in its place.
 *
 * ## A flow nobody follows ends early
 *
 * Every flow ends when its window closes. A flow that can only finish through a person bringing a value
 * BACK — Claude's code, or a Codex link's address — also ends once nobody has read it for
 * {@link HARNESS_LOGIN_IDLE_MINUTES}: nothing can complete it, and a pending Codex link sign-in holds the
 * callback port every other Codex link sign-in on this machine needs. A Codex DEVICE code is exempt,
 * because it completes at the provider with nobody reading — ending it would throw an approval away.
 *
 * ## One Codex flow, two children, in turn
 *
 * A Codex flow can move from a device code to Codex's link sign-in — by itself when Codex says device
 * codes are unavailable, or when the person asks. The flow keeps its id, its window and the authority its
 * start was granted under; the device child is killed and the link child launched in its place. `relaunch` on the
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
import type { CallerGovernance } from '../api/capability.ts';
import { type CredentialSignInTarget, FleetCredentialRefusal, type SignInCheck } from '../fleet/credentials-service.ts';
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
import { CODEX_CALLBACK_PORTS } from './codex-link.ts';
import {
  CODEX_LINK_LOGIN_ARGV,
  CODEX_LINK_START,
  CODEX_LOGIN_ARGV,
  CODEX_LOGIN_START,
  type CodexLoginFailure,
  type CodexLoginStage,
  codexAutomaticLink,
  codexSharedHostEnding,
  codexDelivering,
  codexEnding,
  codexProjection,
  decideCodexSubmit,
  observeCodexLine,
} from './codex-flow.ts';
import { type CallbackPortHolder, type HeldVerdict, heldPortsWords, isLeftoverCodexLogin } from './port-holders.ts';
import type {
  HarnessLoginCallbackDeliver,
  HarnessLoginChild,
  HarnessLoginFlowBase,
  HarnessLoginPortHolders,
  HarnessLoginSpawn,
  HarnessLoginTimer,
} from './ports.ts';

/** Every refusal this surface answers with, so a client branches on cause rather than on prose. */
export type HarnessLoginRefusalCode = 'fleet_login_unavailable' | 'fleet_login_unknown' | 'fleet_login_unauthorized';

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
  /** What a person types to run this binary, so a refusal names a command they actually have. */
  readonly clientName: string;
  /** How long a flow may live. Bounded in minutes, like the browser login window's one-to-sixty. */
  readonly windowMinutes?: number;
  /** Resolves a credential id to what a sign-in for it launches (account model §4.6). */
  readonly credentialTargets: { target(credentialId: string): Promise<CredentialSignInTarget> };
  /** The harness command, by this daemon's one rule. A sign-in launches it directly. */
  readonly locate: (harness: HarnessKind) => string | undefined;
  /** Who listens on Codex's callback ports, so starting over can clear a leftover Codex sign-in. */
  readonly portHolders: HarnessLoginPortHolders;
  /** The ports a Codex link sign-in listens on. Codex's own, unless a test names others. */
  readonly callbackPorts?: readonly number[];
  /**
   * Whether this host shares its loopback ports with other local users (`browserPorts` is not `random`).
   * Read once when a flow starts. On such a host the daemon never moves a Codex flow onto the link
   * sign-in's one fixed port by itself; a person still chooses the link on purpose. Absent means not shared.
   */
  readonly sharedHost?: () => Promise<boolean>;
  /**
   * Told when a sign-in completes, so an open app learns the login's state moved even though no request
   * of its own changed it — the sign-in finished in the background (docs/config-files.md "Live changes").
   */
  readonly onSignedIn?: (credentialId: string) => void;
}

/**
 * How long a daemon that is stopping waits for a sign-in it ended to exit before killing it outright.
 *
 * The wait is RACED, never awaited on its own: a child's exit settles only once its pipes are read to
 * the end, and anything it started that still holds a pipe would keep that from ever happening.
 */
export const HARNESS_LOGIN_SHUTDOWN_GRACE_MS = 2_000;

/** The default login window. Long enough to find a phone, short enough that a stray child is not forever. */
export const HARNESS_LOGIN_WINDOW_MINUTES = 10;

/**
 * How long a flow that needs a person to bring a value back may go unread before it is abandoned.
 *
 * Long enough to sign in at a provider on the same phone (the app is in the background and reads
 * nothing while that happens), short enough that a forgotten Codex link frees the callback port well
 * inside the window.
 */
export const HARNESS_LOGIN_IDLE_MINUTES = 5;

/**
 * How long Claude Code may run before it prints the sign-in link a browser needs.
 *
 * Claude prints its link within a second or two of starting. One that has printed nothing for a minute
 * is waiting on something a browser cannot give it — a terminal, a browser on the host — and a person
 * on a phone would otherwise watch "Starting sign-in…" until the ten-minute window closed. So it ends
 * here, saying that, and the child goes with it.
 */
export const HARNESS_LOGIN_LINK_SECONDS = 60;

/**
 * The start of a sign-in's ending when the harness exited cleanly but its store held no usable login.
 * The finding — where it looked and what each place held — follows it.
 */
export const NO_USABLE_LOGIN = 'the sign-in finished, but no usable login was found for this credential.';

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
  /** Codex only: this host shares its loopback ports, so a device code that fails is not followed by a link on its own. */
  sharedHost: boolean;
  /** When anybody last read or acted on this flow. A flow that needs a reader ends once this goes stale. */
  readAt: number;
  disarmIdle: (() => void) | undefined;
  /** Claude only: ends a flow that never printed its link. */
  disarmLink: (() => void) | undefined;
  /**
   * Set when the harness finished cleanly but its store held no usable login: reads that store again,
   * launching nothing. What a `recheck` submission runs, and why the failed flow offers one.
   */
  recheck: (() => Promise<SignInCheck>) | undefined;
}

const settled = (stage: FlowStage): boolean => stage.stage.stage === 'complete' || stage.stage.stage === 'failed';

const CODEX_PUBLISHED: ReadonlySet<CodexLoginStage['stage']> = new Set([
  'awaiting-approval',
  'awaiting-callback',
  'finishing',
]);

/**
 * A stage that only a person bringing a value back can finish. A Codex device code is not one: the
 * child finishes at the provider by itself, read or not.
 */
const needsReader = (stage: FlowStage): boolean =>
  stage.harness === 'claude' ? stage.stage.stage === 'awaiting-code' : stage.stage.stage === 'awaiting-callback';

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
  /** Set by {@link shutdown}: a daemon that is stopping starts no sign-in it could not then end. */
  #stopped = false;

  constructor(private readonly options: DaemonHarnessLoginOptions) {}

  /**
   * Sign one account-model CREDENTIAL in (design §4.6, E12, E31).
   *
   * The harness's OWN login is launched with that credential's store in its environment — so an empty slot nothing uses yet can be signed
   * in, and every runtime that later names it reads the login this wrote. A caller off this host reaches here
   * only through `fleet.configure`, which holds it behind a live passkey step-up.
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
    return this.#launch(target, request.method === 'link', request.restart === true);
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
    if ('method' in request && request.method === 'recheck') return await this.#recheck(record);
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

  /**
   * Look in the credential's store again, for a sign-in that finished but whose login was not there.
   *
   * Launches nothing and forwards nothing: the harness already exited, and this only reads. A login that
   * landed late — or that the keychain would not hand over a moment ago — completes the flow exactly as
   * if the first read had found it. One still missing keeps the flow failed, with what THIS read found.
   */
  async #recheck(record: FlowRecord): Promise<HarnessLoginSubmission> {
    const recheck = record.recheck;
    if (recheck === undefined) {
      return {
        outcome: 'conflict',
        reason: settled(record.stage)
          ? 'this sign-in did not end with a login to look for again; start a new sign-in instead'
          : 'this sign-in is still running, so there is nothing to look for yet',
      };
    }
    const check = await recheck().catch(
      (): SignInCheck => ({
        signedIn: false,
        finding: 'The store this login is kept in could not be read.',
      }),
    );
    if (check.signedIn) {
      record.recheck = undefined;
      record.stage =
        record.stage.harness === 'claude'
          ? { harness: 'claude', stage: { stage: 'complete' } }
          : { harness: 'codex', stage: { stage: 'complete' } };
      this.options.onSignedIn?.(record.credentialId);
      return { outcome: 'accepted', flow: this.#projection(record) };
    }
    const reason = `${NO_USABLE_LOGIN} ${check.finding}`;
    // A flow offering a recheck is always a failed one — the offer is made only as it ends — so this keeps
    // its ending and replaces only the finding, with what this read saw.
    const failed = record.stage.stage as ClaudeLoginFailure;
    record.stage =
      record.stage.harness === 'claude'
        ? { harness: 'claude', stage: { ...failed, reason } }
        : { harness: 'codex', stage: { ...failed, reason } };
    return { outcome: 'refused', reason };
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

  /**
   * End every sign-in, and do not return until each child has exited or been killed outright.
   *
   * A pending `codex login` holds this machine's `localhost:1455` callback port for as long as it runs.
   * Left behind by a daemon that stopped, it outlived its flow — nobody could see it, cancel it or send
   * it a code — and the next Codex sign-in failed because the port was taken.
   */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    const children: HarnessLoginChild[] = [];
    for (const record of this.#flows.values()) {
      if (record.child !== undefined) children.push(record.child);
      // Killed here as well as by the ending: a flow whose stage already settled is not ended again,
      // and its child must still go. `kill` is idempotent.
      record.child?.kill();
      this.#end(record, 'the daemon stopped, so this sign-in ended with it');
    }
    await this.#gone(children);
  }

  /**
   * Wait for these children to exit, killing outright any still running at the end of the grace.
   *
   * The wait is RACED, never awaited on its own: a child's exit settles only once its pipes are read to
   * the end, and anything it started that still holds a pipe would keep that from ever happening.
   */
  async #gone(children: readonly HarnessLoginChild[]): Promise<void> {
    if (children.length === 0) return;
    let disarm: () => void = () => undefined;
    const exited = Promise.all(children.map(async child => await child.exited.catch(() => 0))).then(() => true);
    const expired = new Promise<boolean>(resolve => {
      disarm = this.options.timer.after(HARNESS_LOGIN_SHUTDOWN_GRACE_MS, () => resolve(false));
    });
    const settledInTime = await Promise.race([exited, expired]);
    disarm();
    if (!settledInTime) for (const child of children) child.kill('SIGKILL');
  }

  // ─── the flow ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The flow already running for this credential, if any — lapsed first, so a flow whose window
   * closed or that nobody followed is not handed back as if it were still waiting.
   */
  #running(key: string): FlowRecord | undefined {
    for (const record of this.#flows.values()) {
      if (record.identityKey !== key || settled(record.stage)) continue;
      this.#lapse(record);
      if (!settled(record.stage)) return record;
    }
    return undefined;
  }

  #launch(
    target: Extract<CredentialSignInTarget, { kind: 'store' }>,
    link: boolean,
    restart: boolean,
  ): HarnessLoginFlow {
    if (this.#stopped)
      throw new HarnessLoginRefusal('fleet_login_unavailable', 'this daemon is stopping, so it starts no sign-in');
    // Nothing between here and the record landing in `#flows` awaits, so of two starts for one
    // credential the later finds the earlier here.
    const running = this.#running(target.credentialId);
    if (running !== undefined && !restart) {
      this.#touch(running);
      return { ...this.#projection(running), resumed: true };
    }
    // Starting over: the old child is ended now and the new one launched only once it has exited, so the
    // two never hold one store — or one Codex callback port — at the same time.
    const previous = running?.child;
    if (running !== undefined) this.#end(running, 'this sign-in was replaced by a new one');
    const record = this.#record(target.harness, target.credentialId, link);
    // Deliberately not awaited: a start answers with the flow so a surface can begin polling, and the
    // login itself takes as long as a person takes. Every failure is recorded on the record, so nothing
    // here can reject into an unhandled rejection.
    void this.#run(target, record, {
      replaced: previous === undefined ? [] : [previous],
      clearPorts: restart && target.harness === 'codex',
    });
    return this.#projection(record);
  }

  /**
   * Starting a Codex sign-in over: stop any leftover Codex sign-in still listening on the callback port,
   * and name — never stop — anything else there.
   *
   * A leftover is one {@link isLeftoverCodexLogin} PROVES is a Codex login run by this daemon's own
   * user: a daemon killed before it could end its sign-ins leaves exactly that, and it keeps the port
   * from every later link sign-in. A link sign-in that would find EVERY callback port still taken ends
   * here, saying which program holds each one, rather than launching Codex to fail on it.
   */
  async #clearCallbackPorts(record: FlowRecord): Promise<void> {
    const ports = this.options.callbackPorts ?? CODEX_CALLBACK_PORTS;
    const holders = await this.options.portHolders.holders(ports);
    if (holders === undefined) return;
    const kept: { readonly holder: CallbackPortHolder; readonly verdict: HeldVerdict }[] = [];
    for (const holder of holders) {
      if (!isLeftoverCodexLogin(holder, this.options.portHolders.ownUid)) kept.push({ holder, verdict: 'not-codex' });
      else if (!(await this.options.portHolders.stop(holder.pid))) kept.push({ holder, verdict: 'could-not-stop' });
    }
    const linking = record.stage.harness === 'codex' && record.stage.stage.stage === 'linking';
    if (!linking || !ports.every(port => kept.some(entry => entry.holder.port === port))) return;
    this.#endWith(record, {
      stage: 'failed',
      reason: `Codex cannot listen for the sign-in: ${heldPortsWords(kept)}`,
      remedy: 'Stop that program yourself and start over, or sign in with a device code instead.',
    });
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
      sharedHost: false,
      readAt: startedAt,
      disarmIdle: undefined,
      disarmLink: undefined,
      recheck: undefined,
    };
    this.#flows.set(record.flowId, record);
    record.disarm = this.options.timer.after(window, () => {
      this.#expire(record);
    });
    this.#armIdle(record);
    if (harness === 'claude')
      record.disarmLink = this.options.timer.after(HARNESS_LOGIN_LINK_SECONDS * 1_000, () => {
        record.disarmLink = undefined;
        if (record.stage.harness !== 'claude' || record.stage.stage.stage !== 'starting') return;
        this.#end(
          record,
          `Claude Code started but printed no sign-in link within ${String(HARNESS_LOGIN_LINK_SECONDS)} seconds, so this sign-in cannot be finished from a browser`,
        );
      });
    return record;
  }

  /** Somebody read or acted on this flow: its idle clock starts again. */
  #touch(record: FlowRecord): void {
    record.readAt = this.options.clock.now();
    if (!settled(record.stage)) this.#armIdle(record);
  }

  /**
   * The idle deadline. When it fires on a flow that still needs a reader, nobody is coming back to it;
   * on any other stage — a device code the provider may still approve — it simply looks again later.
   */
  #armIdle(record: FlowRecord): void {
    record.disarmIdle?.();
    record.disarmIdle = this.options.timer.after(HARNESS_LOGIN_IDLE_MINUTES * 60_000, () => {
      record.disarmIdle = undefined;
      if (settled(record.stage)) return;
      if (needsReader(record.stage)) this.#expire(record);
      else this.#armIdle(record);
    });
  }

  /**
   * End this flow if its window has closed, or if it needs a reader and nobody has read it for the idle
   * time — checked lazily as well as by timer, because a suspended host wakes up with both overdue.
   */
  #lapse(record: FlowRecord): void {
    const now = this.options.clock.now();
    if (now >= record.expiresAt) this.#expire(record);
    else if (needsReader(record.stage) && now - record.readAt >= HARNESS_LOGIN_IDLE_MINUTES * 60_000)
      this.#expire(record);
  }

  /**
   * Launch the harness's own login against one credential's store, and prove the store afterwards.
   *
   * The environment is sanitized, then given the store's variables, so a sign-in started from inside an
   * agent session cannot authenticate against that session's login.
   */
  async #run(
    target: Extract<CredentialSignInTarget, { kind: 'store' }>,
    record: FlowRecord,
    before: { readonly replaced: readonly HarnessLoginChild[]; readonly clearPorts: boolean },
  ): Promise<void> {
    try {
      await this.#gone(before.replaced);
      if (before.clearPorts && !settled(record.stage)) await this.#clearCallbackPorts(record);
      if (settled(record.stage)) return;
      const binary = this.options.locate(target.harness);
      if (binary === undefined) {
        this.#end(
          record,
          `the ${target.harness} command is not installed on this machine, so there is nothing to sign in with`,
        );
        return;
      }
      await target.prepare();
      record.sharedHost = target.harness === 'codex' && (await this.options.sharedHost?.()) === true;
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
      const check = await target.check();
      if (settled(record.stage)) return;
      if (!check.signedIn) {
        // Offered BEFORE the ending, so the failed flow every reader sees already says it can look again.
        record.recheck = async () => await target.check();
        this.#end(record, `${NO_USABLE_LOGIN} ${check.finding}`);
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
    // Codex could not get a device code at all: move on to the link sign-in by itself, unless the link's one
    // fixed port is shared with other users of this host, in which case the person is told and chooses.
    if (next.stage === 'device-unavailable') {
      if (record.sharedHost) this.#endWith(record, codexSharedHostEnding());
      else this.#switchToLink(record, codexAutomaticLink());
    } else record.stage = { harness: 'codex', stage: next };
  }

  /** Record that the sign-in completed, unless this flow had already ended. */
  #finish(record: FlowRecord): void {
    if (settled(record.stage)) return;
    record.disarm?.();
    record.disarm = undefined;
    record.disarmIdle?.();
    record.disarmIdle = undefined;
    record.disarmLink?.();
    record.disarmLink = undefined;
    record.stage =
      record.stage.harness === 'claude'
        ? { harness: 'claude', stage: { stage: 'complete' } }
        : { harness: 'codex', stage: { stage: 'complete' } };
    this.options.onSignedIn?.(record.credentialId);
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
    record.disarmIdle?.();
    record.disarmIdle = undefined;
    record.disarmLink?.();
    record.disarmLink = undefined;
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

  /**
   * This flow, or a refusal. A flow that lapsed ends before it is read; one that did not counts as read.
   *
   * The refusal names no flow id: it is read by a person, and an internal handle is not something they
   * can act on.
   */
  #require(flowId: string): FlowRecord {
    const record = this.#flows.get(flowId);
    if (record === undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unknown',
        'that sign-in is no longer running on this machine; it may have finished or run out of time',
      );
    }
    this.#lapse(record);
    this.#touch(record);
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
    const flow = stage.harness === 'claude' ? claudeProjection(base, stage.stage) : codexProjection(base, stage.stage);
    return flow.state === 'failed' && record.recheck !== undefined ? { ...flow, recheck: true } : flow;
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
