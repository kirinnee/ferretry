/**
 * The daemon side of a UI-driven harness login.
 *
 * ## The one property everything else serves
 *
 * **This daemon never holds a token.** It launches the account's own wrapper, publishes at most two
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
 * ## What is reused rather than rewritten
 *
 * `FleetLoginService` in the fleet package already walks IDENTITIES rather than accounts: it syncs a
 * sibling's credential first, asks a human only when nobody in the identity has a usable one, and fans
 * the fresh credential out afterwards. That arithmetic — thirty wrappers on six provider accounts costing
 * six interactions — is inherited here for free, by supplying it a `FleetLoginPort` that drives a remote
 * flow instead of a terminal. Two consequences worth knowing:
 *
 * - **A login can complete without a child ever being spawned.** If a sibling has a usable credential the
 *   fleet clones it and nobody is asked for anything; the flow goes straight from `starting` to
 *   `complete`. That is the good case, not a bug.
 * - **A login that exits zero but leaves the identity with no usable credential is a FAILURE**, because
 *   the fleet's own service already decides that, and this flow reports what it decided.
 *
 * ## What is refused, and why each refusal is its own
 *
 * - **A harness that declares no interactive login** — nothing to launch.
 * - **An account whose credential comes from a token file, the environment or the configuration** —
 *   nothing to log in to. Offering it would be a control that cannot succeed.
 * - **A second flow for one identity** — two logins into one identity race for the same homes. Note the
 *   pre-existing gap this widens rather than closes: the fleet's only cross-process lock guards `apply`,
 *   so `fy fleet login` on the host and a flow here still have nothing between them. This service can
 *   only be single-flight within itself, and it says so.
 * - **A missing wrapper** — and with NO `PATH` fallback. `process-login.ts` falls back to the bare CLI
 *   because a person on an unprovisioned host still needs to log in; a daemon started by a service
 *   manager inherits no shell profile, so the same fallback here would resolve against a `PATH` that
 *   cannot contain the fleet's bin directory. The refusal names `fy fleet apply` instead.
 * - **A flow that recognised nothing** — it ends as ITSELF, saying this host's harness did not offer a
 *   remotable login and naming `fy fleet login`. Never a hang, never a bare exit code. Both flows depend
 *   on somebody else's output format, and one of them depends on an UNDOCUMENTED flag
 *   (`codex login --device-auth`, empty description at 0.145.0), so this is the path that keeps a
 *   third-party change from becoming an outage.
 */
import {
  buildFleetIdentities,
  credentialSourceOf,
  decideLoginApplicability,
  type FleetCredentialSource,
  type FleetCredentialStore,
  type FleetIdentity,
  type FleetIdentityMember,
  FleetIdentityService,
  type FleetIdentityStatus,
  type FleetLoginResult,
  FleetLoginService,
  type FleetLoginTarget,
  type HarnessLoginDeclarations,
  referencedEnvNames,
  type ResolvedAccount,
  resolveAccounts,
  sanitizeHarnessEnv,
  wrapperNameOf,
} from '@ferretry/fleet';
import type { FleetConfig, FleetManifest } from '@ferretry/fleet';
import type {
  FleetCredentialReading,
  FleetCredentialSource as ProtocolCredentialSource,
  FleetLoginAccount,
  FleetLoginAccountOutcome,
  FleetLoginIdentity,
  FleetLoginReadiness,
  HarnessLoginFlow,
  HarnessLoginStartRequest,
  HarnessLoginSubmission,
} from '@ferretry/protocol';
import type { CallerGovernance, ChangeConfirmation } from '../api/capability.ts';
import {
  CLAUDE_LOGIN_ARGV,
  CLAUDE_LOGIN_START,
  type ClaudeLoginStage,
  claudeProjection,
  decideClaudeSubmit,
  observeClaudeLine,
} from './claude-flow.ts';
import {
  CODEX_LOGIN_ARGV,
  CODEX_LOGIN_START,
  type CodexLoginStage,
  codexProjection,
  decideCodexSubmit,
  observeCodexLine,
} from './codex-flow.ts';
import type {
  HarnessLoginChild,
  HarnessLoginFlowBase,
  HarnessLoginSpawn,
  HarnessLoginTimer,
  HarnessLoginWrapperSource,
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

/**
 * The two reads this needs of the fleet, which the fleet subsystem already serves.
 *
 * Narrowed to two methods rather than taking the whole subsystem: this service must be able to read what
 * the fleet declares and publishes, and must not be able to propose a change, apply one, or write an
 * asset. It is also why no configuration or manifest loading is duplicated here.
 */
// Not exported: the composition root satisfies it structurally with the fleet subsystem it already
// builds, so a name on the package surface would be a second way to describe one seam.
interface HarnessLoginFleetReader {
  config(): Promise<FleetConfig>;
  accounts(): Promise<FleetManifest>;
}

export interface DaemonHarnessLoginOptions {
  readonly fleet: HarnessLoginFleetReader;
  /** Reads and clones credentials. Returns classifications and copies bytes; never yields material. */
  readonly credentials: FleetCredentialStore;
  readonly clock: { now(): number };
  /** A flow handle. Supplied, so identity is never clock-derived and therefore never guessable. */
  readonly mintId: () => string;
  readonly spawn: HarnessLoginSpawn;
  /** This process's environment, which is sanitized before any child sees it. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readWrapper: HarnessLoginWrapperSource;
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
  /** Which harnesses declare an interactive login. Defaulted to the shipped table. */
  readonly declarations?: HarnessLoginDeclarations;
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
  readonly accountId: string;
  readonly identityKey: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  stage: FlowStage;
  child: HarnessLoginChild | undefined;
  disarm: (() => void) | undefined;
  /** True once a child was launched, so "nothing was recognised" is distinguishable from "never ran". */
  spawned: boolean;
}

const settled = (stage: FlowStage): boolean => stage.stage.stage === 'complete' || stage.stage.stage === 'failed';

const published = (stage: FlowStage): boolean =>
  stage.harness === 'claude' ? stage.stage.stage === 'awaiting-code' : stage.stage.stage === 'awaiting-approval';

const instant = (milliseconds: number): string => new Date(Math.trunc(milliseconds)).toISOString();

/**
 * What the credential store found, as the wire says it.
 *
 * `not-read` when a login does not apply, and that is not a cosmetic choice: for an account whose
 * credential comes from a token file, whatever sits in the harness's own store is not this account's
 * credential, so reporting it `missing` would tell a correctly-configured account that it is broken.
 */
function readingOf(status: FleetIdentityStatus, member: FleetIdentityMember, applies: boolean): FleetCredentialReading {
  if (!applies) return { state: 'not-read' };
  const found = status.members.find(entry => entry.member.accountId === member.accountId);
  if (found === undefined) return { state: 'not-read' };
  const reading = found.reading;
  if (reading.state === 'unreadable') {
    return { state: 'unreadable', reason: reading.reason ?? 'the credential could not be read' };
  }
  if (reading.state === 'missing') return { state: 'missing' };
  return {
    state: reading.state,
    ...(reading.expiresAt === undefined ? {} : { expiresAt: instant(reading.expiresAt) }),
  };
}

/** The fleet's own per-account outcomes, carried rather than collapsed. */
const outcomesOf = (results: readonly FleetLoginResult[]): readonly FleetLoginAccountOutcome[] =>
  results.map(result => ({
    accountId: result.accountId,
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
  }));

export class HarnessLoginService {
  readonly #flows = new Map<string, FlowRecord>();
  readonly #identities: FleetIdentityService;

  constructor(private readonly options: DaemonHarnessLoginOptions) {
    this.#identities = new FleetIdentityService(options.credentials);
  }

  /**
   * Which provider logins this host has, and what each one needs.
   *
   * Grouped by IDENTITY because that is what a login is of: one approval covers every lane sharing the
   * credential, and a surface that offered a per-account button would spend an approval per wrapper and
   * still leave siblings signed out.
   */
  async readiness(): Promise<FleetLoginReadiness> {
    const { identities, sources } = await this.#context();
    const rows: FleetLoginIdentity[] = [];
    for (const identity of identities) {
      const status = await this.#identities.surveyOne(identity);
      rows.push(this.#identityRow(identity, status, sources));
    }
    return { identities: rows };
  }

  /** Start one identity's login, confirmed against the operator password when this caller owes one. */
  async start(request: HarnessLoginStartRequest, governance: CallerGovernance | undefined): Promise<HarnessLoginFlow> {
    // Absent governance is refused rather than waved through. It cannot arise through the served route,
    // which declares a capability and therefore always has one built, and the safe reading of "nobody
    // can tell me where this caller stands" is not "launch a login on the host".
    if (governance === undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unauthorized',
        'this daemon cannot say whether this caller may sign this fleet in',
      );
    }

    const { identities, sources } = await this.#context();
    const identity = identities.find(candidate =>
      candidate.members.some(member => member.accountId === request.accountId),
    );
    if (identity === undefined) {
      throw new HarnessLoginRefusal(
        'fleet_login_unavailable',
        `no fleet account "${request.accountId}" is published on this host`,
      );
    }

    this.#assertLoginApplies(identity, request.accountId, sources);
    this.#assertSingleFlight(identity);
    if (governance.confirmChange) await this.#confirm(identity.key, request.operatorPassword);

    return this.#launch(identity, request.accountId);
  }

  /** This flow as it stands, expiring it first if its window has closed. */
  async status(flowId: string): Promise<HarnessLoginFlow> {
    return this.#projection(this.#require(flowId));
  }

  /**
   * Forward the one value a person brings back.
   *
   * The value is passed straight to the child's stdin and to nothing else. It is not held on the record,
   * not put in the answer, and not named in any refusal — the flow module that decides whether a write is
   * allowed never receives it, which is what makes write-only a property of the shape.
   */
  async submit(flowId: string, value: string): Promise<HarnessLoginSubmission> {
    const record = this.#require(flowId);
    const stage = record.stage;
    const decision = stage.harness === 'claude' ? decideClaudeSubmit(stage.stage) : decideCodexSubmit(stage.stage);
    if (decision.decision !== 'write') return { outcome: decision.decision, reason: decision.reason };

    const write = record.child?.write ?? (async () => false);
    const accepted = await write(`${value}\n`);
    return accepted
      ? { outcome: 'accepted', flow: this.#projection(record) }
      : {
          outcome: 'unconfirmed',
          reason:
            'the harness was no longer reading, so nobody can say whether that code arrived; check whether this account is signed in before trying again',
        };
  }

  /** End this flow and its child. */
  async cancel(flowId: string): Promise<HarnessLoginFlow> {
    const record = this.#require(flowId);
    this.#end(record, 'this sign-in was cancelled');
    return this.#projection(record);
  }

  // ─── reading the fleet ──────────────────────────────────────────────────────────────────────────

  /** The declared configuration and the published manifest, joined the one way that is safe. */
  async #context(): Promise<{
    readonly identities: readonly FleetIdentity[];
    readonly sources: ReadonlyMap<string, FleetCredentialSource>;
  }> {
    const [config, manifest] = [await this.options.fleet.config(), await this.options.fleet.accounts()];
    return { identities: buildFleetIdentities(config, manifest), sources: this.#sources(config) };
  }

  /**
   * Where each declared account's credential comes from.
   *
   * Read from the configuration, never from the host: nothing is stat-ed and no secret is touched. An
   * account the configuration no longer declares is absent from this map, and {@link #sourceOf} answers
   * `undeclared` for it — the fail-closed reading, because a wrapper whose declaration is gone may well
   * export a credential nobody here can see.
   */
  #sources(config: FleetConfig): ReadonlyMap<string, FleetCredentialSource> {
    const resolved: readonly ResolvedAccount[] = resolveAccounts(config);
    return new Map(resolved.map(account => [account.id, credentialSourceOf(account, config.secretsFile)] as const));
  }

  #sourceOf(sources: ReadonlyMap<string, FleetCredentialSource>, accountId: string): FleetCredentialSource {
    return sources.get(accountId) ?? { source: 'undeclared' };
  }

  /**
   * One account's credential source in the shape the wire union can carry.
   *
   * `secret-store` is a member the fleet domain has and the protocol does not, and this narrows it to
   * `environment` for the row a browser receives. That is a TRUE narrowing rather than a substitute:
   * the daemon resolves the secret and puts the value into the environment the wrapper is launched in,
   * so both the variable named and the "there is no sign-in to run for it" verdict are exactly right;
   * what the browser loses is the sentence naming Ferretry's own store as where it came from.
   *
   * It is here rather than in the fleet package because the fleet package is where the precise fact
   * belongs — `credentialSourceOf` answers `secret-store` and every host-side surface reads it. The
   * wire is the one place that cannot say it yet, and widening the protocol union means a matching arm
   * in the browser's copy, which is a separate unit's file. So the loss is one sentence, in one
   * surface, and it is written down here and in `docs/fleet-env-profiles.md` rather than discovered.
   */
  #wireSource(source: FleetCredentialSource): ProtocolCredentialSource {
    return source.source === 'secret-store' ? { source: 'environment', variable: source.variable } : source;
  }

  #identityRow(
    identity: FleetIdentity,
    status: FleetIdentityStatus,
    sources: ReadonlyMap<string, FleetCredentialSource>,
  ): FleetLoginIdentity {
    const accounts: FleetLoginAccount[] = identity.members.map(member => {
      const source = this.#sourceOf(sources, member.accountId);
      const login = decideLoginApplicability(identity.kind, source, this.options.declarations);
      return {
        accountId: member.accountId,
        kind: identity.kind,
        displayName: member.displayName,
        // The NAME, not the published path. It is what a person types, and it is the key the daemon's
        // own usage feed reports under — so a surface can join a quota figure onto this row exactly.
        // The path is on `/v1/fleet/accounts` for anybody who needs it; this row is a sign-in view.
        wrapper: wrapperNameOf(member.wrapper),
        mode: member.mode,
        available: member.available,
        credential: readingOf(status, member, login.applies),
        source: this.#wireSource(source),
        login,
      };
    });
    const verdict = status.verdict;
    return {
      identity: identity.key,
      kind: identity.kind,
      verdict: verdict.kind,
      ...('reason' in verdict ? { reason: verdict.reason } : {}),
      // Non-empty by construction: `buildFleetIdentities` only produces an identity from a member the
      // manifest published, so there is no identity here with nothing in it.
      accounts,
    };
  }

  // ─── refusals ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Refuse a login that could not succeed, in the words that say where the credential DOES come from.
   *
   * The account named in the request decides, not the identity: a person clicks a row.
   */
  #assertLoginApplies(
    identity: FleetIdentity,
    accountId: string,
    sources: ReadonlyMap<string, FleetCredentialSource>,
  ): void {
    const source = this.#sourceOf(sources, accountId);
    const login = decideLoginApplicability(identity.kind, source, this.options.declarations);
    if (login.applies) return;
    const because =
      login.because === 'harness-has-no-login'
        ? (login.harnessReason ?? `the ${identity.kind} harness has no interactive login`)
        : describeSource(source);
    throw new HarnessLoginRefusal('fleet_login_unavailable', `there is no sign-in to run for this account: ${because}`);
  }

  /**
   * One flow per identity at a time.
   *
   * Two logins into one identity race for the same homes, and the fleet has no cross-process lock over
   * credential writes — its only lock guards `apply`. So this is single-flight WITHIN this daemon, and the
   * refusal says which flow holds the identity rather than implying nothing else can.
   */
  #assertSingleFlight(identity: FleetIdentity): void {
    for (const record of this.#flows.values()) {
      if (record.identityKey !== identity.key || settled(record.stage)) continue;
      throw new HarnessLoginRefusal(
        'fleet_login_in_progress',
        `a sign-in for "${identity.key}" is already running as flow "${record.flowId}"; finish or cancel it first`,
      );
    }
  }

  /** Prove the operator password against THIS start, or refuse in words naming the next step. */
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

  #launch(identity: FleetIdentity, accountId: string): HarnessLoginFlow {
    this.#prune();
    const startedAt = this.options.clock.now();
    const window = (this.options.windowMinutes ?? HARNESS_LOGIN_WINDOW_MINUTES) * 60_000;
    const record: FlowRecord = {
      flowId: this.options.mintId(),
      accountId,
      identityKey: identity.key,
      startedAt,
      expiresAt: startedAt + window,
      stage:
        identity.kind === 'claude'
          ? { harness: 'claude', stage: CLAUDE_LOGIN_START }
          : { harness: 'codex', stage: CODEX_LOGIN_START },
      child: undefined,
      disarm: undefined,
      spawned: false,
    };
    this.#flows.set(record.flowId, record);
    record.disarm = this.options.timer.after(window, () => {
      this.#end(record, 'this sign-in ran out of time before it finished');
    });

    // Deliberately not awaited: a start answers with the flow so a surface can begin polling, and the
    // login itself takes as long as a person takes. Every failure is recorded on the record, so nothing
    // here can reject into an unhandled rejection.
    void this.#run(identity, record);
    return this.#projection(record);
  }

  /**
   * Drive the fleet's own login service, with this flow as its interactive port.
   *
   * Nothing else decides what happens to the identity: one approval, deliver the credential across the
   * lanes, report per-account outcomes. This method's whole job is to be the terminal that is not there.
   *
   * THE ACCOUNT IS PASSED, and it used to not be. This ran the whole identity with nobody named, so the
   * fleet service picked the identity's interactive lane, launched THAT wrapper, and the flow went on
   * reporting `accountId` — the account a person actually clicked — as though the two were the same
   * thing. Worse, a `full` pass reads what the homes hold: a revoked token still classifies as valid,
   * so pressing Sign in on the one account the provider is rejecting answered `usable` for every lane
   * and never launched anything at all. Naming the account makes it the pass's subject, which is both
   * the thing a `reauthenticate` pass is for and the home it must prove holds a credential at the end.
   */
  async #run(identity: FleetIdentity, record: FlowRecord): Promise<void> {
    const fleetLogin = new FleetLoginService({
      identities: this.#identities,
      loginPort: { login: async target => await this.#runChild(record, target) },
    });
    try {
      const results = await fleetLogin.login({
        identities: [identity],
        accountIds: [record.accountId],
        mode: 'reauthenticate',
      });
      this.#finish(record, outcomesOf(results));
    } catch (error) {
      this.#end(record, error instanceof Error && error.message.length > 0 ? error.message : 'the sign-in failed');
    }
  }

  /**
   * Launch this account's own wrapper with piped stdio and a sanitized environment.
   *
   * The environment is sanitized for the reason `fy fleet login` sanitizes it: a login started from
   * inside an agent session must not inherit that session's provider credentials, or the login for
   * account B authenticates against account A's key. The variables the wrapper deliberately references
   * are read back out of the wrapper itself and preserved.
   */
  async #runChild(
    record: FlowRecord,
    target: FleetLoginTarget,
  ): Promise<{ status: 'logged-in' } | { status: 'failed'; message: string }> {
    if (settled(record.stage)) return { status: 'failed', message: 'this sign-in ended before the harness started' };

    const script = await this.options.readWrapper(target.wrapper);
    if (script === undefined) {
      // NO `PATH` FALLBACK. A daemon started by a service manager inherits no shell profile, so a
      // name-based lookup cannot resolve the fleet's own bin directory however correctly it was
      // provisioned — the fallback would launch some other installation, in some other home.
      const message = `this account's wrapper is not on the host, so there is nothing to sign in — run \`${this.options.clientName} fleet apply\` first`;
      this.#end(record, message);
      return { status: 'failed', message };
    }

    const environment = sanitizeHarnessEnv(this.options.environment, referencedEnvNames(script));
    const argv = record.stage.harness === 'claude' ? CLAUDE_LOGIN_ARGV : CODEX_LOGIN_ARGV;
    record.spawned = true;
    const child = this.options.spawn({
      command: [target.wrapper, ...argv],
      environment,
      onLine: line => this.#observe(record, line),
    });
    record.child = child;

    const code = await child.exited;
    record.child = undefined;
    if (settled(record.stage)) return { status: 'failed', message: 'this sign-in ended before the harness finished' };
    if (!published(record.stage)) {
      // The flow recognised nothing it could publish. It ends as itself rather than as an exit code, and
      // names the command that works whatever this harness changed about its output.
      const message = `this host's ${record.stage.harness} did not offer a sign-in that can be driven from a browser`;
      this.#end(record, message);
      return { status: 'failed', message };
    }
    return code === 0 ? { status: 'logged-in' } : { status: 'failed', message: `the sign-in exited with code ${code}` };
  }

  /** Feed one raw output line to this harness's own recogniser. Unclassified lines are dropped. */
  #observe(record: FlowRecord, line: string): void {
    const stage = record.stage;
    record.stage =
      stage.harness === 'claude'
        ? { harness: 'claude', stage: observeClaudeLine(stage.stage, line) }
        : { harness: 'codex', stage: observeCodexLine(stage.stage, line) };
  }

  /** Record the fleet's outcomes, unless this flow had already ended. */
  #finish(record: FlowRecord, accounts: readonly FleetLoginAccountOutcome[]): void {
    if (settled(record.stage)) return;
    record.disarm?.();
    record.disarm = undefined;
    record.stage =
      record.stage.harness === 'claude'
        ? { harness: 'claude', stage: { stage: 'complete', accounts } }
        : { harness: 'codex', stage: { stage: 'complete', accounts } };
  }

  /** End this flow and its child, keeping whatever outcome it already reached. */
  #end(record: FlowRecord, reason: string): void {
    if (settled(record.stage)) return;
    record.disarm?.();
    record.disarm = undefined;
    record.child?.kill();
    record.child = undefined;
    const remedy = `sign this account in on the host with \`${this.options.clientName} fleet login\``;
    const failed = { stage: 'failed', reason, remedy } as const;
    record.stage =
      record.stage.harness === 'claude' ? { harness: 'claude', stage: failed } : { harness: 'codex', stage: failed };
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
      this.#end(record, 'this sign-in ran out of time before it finished');
    }
    return record;
  }

  #projection(record: FlowRecord): HarnessLoginFlow {
    const base: HarnessLoginFlowBase = {
      flowId: record.flowId,
      accountId: record.accountId,
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

/**
 * Where a credential comes from, as one clause a refusal can end with.
 *
 * Exported so it can be proved over every member of the source union, including the one
 * {@link HarnessLoginService} never reaches it with: a function that is total over a discriminated union
 * is a function a new member breaks at compile time, and the arm nobody calls is exactly the arm a
 * future reader would otherwise find empty.
 */
export function describeSource(source: FleetCredentialSource): string {
  if (source.source === 'token-file') {
    return `this account's credential comes from ${source.variable} in ${source.path}, so there is nothing to sign in to`;
  }
  if (source.source === 'environment') {
    return `this account's credential comes from the ${source.variable} environment variable, so there is nothing to sign in to`;
  }
  if (source.source === 'configured-value') {
    return `this account's credential is ${source.variable} as the fleet configuration sets it, so there is nothing to sign in to`;
  }
  if (source.source === 'secret-store') {
    const which = `${source.secrets.length === 1 ? 'secret' : 'secrets'} ${source.secrets.join(', ')}`;
    return `this account's credential is ${source.variable}, which a profile takes from this daemon's secret store (${which}), so there is nothing to sign in to`;
  }
  if (source.source === 'undeclared') {
    return 'nothing in this fleet’s configuration says where this account’s credential comes from';
  }
  return 'this account’s credential is written by the harness’s own sign-in';
}
