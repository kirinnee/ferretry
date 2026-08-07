import { createHash } from 'node:crypto';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type {
  SessionEffectAdmission,
  SessionEffectHeldStanding,
  SessionEffectKey,
  SessionEffectLedger,
} from '../effects/index.ts';
import {
  assignedTaskDocument,
  createSessionRecord,
  firstTurnInstruction,
  lifecycleSessionId,
  transitionSessionRecord,
} from './policy.ts';
import type { SessionLifecycleSettings } from './settings.ts';
import {
  type CreateSessionLifecycleRequest,
  SESSION_BOARD_CAPABILITY_VARIABLE,
  type SessionCredentialIssuer,
  type SessionEnvironmentStore,
  type SessionIdFactory,
  type SessionLifecycleEvent,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
  type SessionLifecycleRepository,
  type SessionTaskStore,
  type WorkingDirectoryResolver,
} from './types.ts';

/** Runtime setup that must finish after launch but before the agent receives turn one. */
export type SessionBeforeFirstTurn = (record: SessionLifecycleRecord) => Promise<void>;

/** Everything outside the lifecycle's own decisions. */
export interface SessionLifecyclePorts {
  readonly repository: SessionLifecycleRepository;
  readonly launcher: SessionLifecycleLauncher;
  readonly tasks: SessionTaskStore;
  /**
   * The one durable owner of irreversible pane effects. Required: silently omitting it would turn a
   * daemon restart back into permission to re-type a first turn the agent may already have taken.
   */
  readonly effects: SessionEffectLedger;
  readonly directories: WorkingDirectoryResolver;
  readonly ids: SessionIdFactory;
  readonly clock: ClockPort;
  /**
   * Serializes every mutation of one session. The status machine alone guarantees nothing under
   * concurrency: two callers that read the same pre-transition record both find their transition
   * legal, and the loser's launch then overwrites a healthy session.
   */
  readonly serial: SerialExecutor;
  /**
   * Mints the session's own credential, when this daemon issues one.
   *
   * Optional together with `environment`: a daemon wired without both keeps the pre-credential
   * behaviour exactly — no secret is minted, no environment file is written, and the pane launches
   * with the environment it always had.
   */
  readonly credentials?: SessionCredentialIssuer;
  readonly environment?: SessionEnvironmentStore;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coordinates durable lifecycle decisions with injected persistence and terminal ports. */
export class SessionLifecycleService {
  constructor(
    private readonly ports: SessionLifecyclePorts,
    private readonly settings: SessionLifecycleSettings,
  ) {}

  async create(request: CreateSessionLifecycleRequest): Promise<SessionLifecycleRecord> {
    const cwd = await this.ports.directories.resolve(request.cwd);
    const id = this.ports.ids.next();
    return await this.ports.serial.run(id, async () => {
      // Ids are minted here, so an existing record means a collision, never a client naming a live
      // session — and either way the live session's record must not be reset under it.
      if (await this.ports.repository.read(id)) throw new Error(`session already exists: ${id}`);
      if (request.sessionCapabilityHash !== undefined && this.ports.credentials === undefined)
        throw new Error('a session capability hash requires a lifecycle-issued credential');
      if (this.ports.credentials !== undefined && this.ports.environment === undefined)
        throw new Error('a session credential issuer requires a durable environment store');
      // Minted before either credential-bearing write, so the exact plaintext/hash pair is fixed
      // for this attempt. The reservation below carries neither; plaintext still precedes the hash.
      const credential = this.ports.credentials?.issue();
      const created = createSessionRecord(
        { ...request, ...(credential === undefined ? {} : { sessionCapabilityHash: credential.hash }) },
        { id, cwd, at: this.ports.clock.now(), settings: this.settings },
      );
      if (await this.ports.launcher.alive(created.record))
        throw new Error(`tmux session ${created.record.config.tmuxSession} is already live`);
      // Reserve only the storage layout — no config, state, or event becomes visible yet. The
      // plaintext MUST then become durable before the hash-bearing record: repository writes can
      // tear after making config.json visible, and the opposite order would let a retry adopt a
      // session whose credential exists only as an unrecoverable value in dead daemon memory.
      await this.ports.repository.reserve(id);
      if (credential !== undefined && this.ports.environment !== undefined)
        await this.ports.environment.write(id, { [SESSION_BOARD_CAPABILITY_VARIABLE]: credential.capability });
      await this.ports.repository.write(created.record, created.event);
      return created.record;
    });
  }

  async start(id: string, beforeFirstTurn?: SessionBeforeFirstTurn): Promise<SessionLifecycleRecord> {
    const parsed = lifecycleSessionId(id);
    return await this.ports.serial.run(parsed, async () => {
      const current = await this.require(parsed);
      const live = await this.ports.launcher.alive(current);
      if (current.state.status === 'running') {
        // Idempotent by design: a retried start must never open a second pane for one session.
        if (live) return current;
        throw new Error(`session ${parsed} is running but its terminal is gone; stop it before starting it again`);
      }
      const firstTurn = this.firstTurnEffect(current);
      const firstTurnStanding =
        firstTurn === undefined ? undefined : await this.ports.effects.inspect(firstTurn.key, firstTurn.fingerprint);
      if (firstTurnStanding === 'settled') {
        if (!live)
          throw new Error(
            `session ${parsed} already delivered its first turn but its terminal is gone; revive it rather than ` +
              'relaunching and repeating startup',
          );
        const starting =
          current.state.status === 'starting'
            ? current
            : await this.persist(transitionSessionRecord(current, 'starting', this.ports.clock.now()));
        return await this.persist(transitionSessionRecord(starting, 'running', this.ports.clock.now()));
      }
      // A record already `starting` is a launch a crash interrupted, not an illegal call: resume it
      // instead of wedging the session on a self-transition it can never make.
      const starting =
        current.state.status === 'starting'
          ? current
          : await this.persist(transitionSessionRecord(current, 'starting', this.ports.clock.now()));
      if (firstTurnStanding === 'unsettled' || firstTurnStanding === 'conflict')
        throw await this.recordFailure(starting, this.firstTurnRefusal(parsed, firstTurnStanding));
      if (!live) await this.launch(starting);
      if (beforeFirstTurn !== undefined) {
        try {
          // Startup waits HERE, through the launcher's existing prompt owner. Interactive controls
          // keep their one-frame refusal semantics and can never queue behind a live turn.
          await this.ports.launcher.ready(starting);
          await beforeFirstTurn(starting);
        } catch (error) {
          throw await this.recordFailure(starting, error);
        }
      }
      await this.deliverFirstTurn(starting, firstTurn);
      return await this.persist(transitionSessionRecord(starting, 'running', this.ports.clock.now()));
    });
  }

  async createAndStart(
    request: CreateSessionLifecycleRequest,
    beforeFirstTurn?: SessionBeforeFirstTurn,
  ): Promise<SessionLifecycleRecord> {
    const created = await this.create(request);
    return await this.start(created.config.id, beforeFirstTurn);
  }

  async stop(id: string, reason = this.settings.defaultStopReason): Promise<SessionLifecycleRecord> {
    const parsed = lifecycleSessionId(id);
    return await this.ports.serial.run(parsed, async () => {
      const current = await this.require(parsed);
      if (current.state.status === 'stopped') return current;
      try {
        await this.ports.launcher.snapshot(current);
        await this.ports.launcher.stop(current);
      } catch (error) {
        // A pane that refused to die is the one failure an operator must be able to see: record it
        // as its own status with the error, rather than leaving a `running` record and no evidence.
        await this.persist(
          transitionSessionRecord(
            current,
            'kill_failed',
            this.ports.clock.now(),
            `${reason}: ${failureMessage(error)}`,
          ),
        );
        throw error;
      }
      return await this.persist(transitionSessionRecord(current, 'stopped', this.ports.clock.now(), reason));
    });
  }

  /**
   * Launches, retrying a failed attempt up to the configured budget. A pane that exists after a
   * failure is someone else's: retrying would either fail forever or fight a live agent, so the
   * failure is recorded instead.
   */
  private async launch(record: SessionLifecycleRecord): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.ports.launcher.launch(record);
        return;
      } catch (error) {
        if (attempt >= this.settings.launchAttempts || (await this.ports.launcher.alive(record)))
          throw await this.recordFailure(record, error);
      }
    }
  }

  /**
   * Hands the agent its assignment. An auto session whose task never arrives is an agent sitting at
   * an idle prompt, so a delivery failure fails the launch rather than reporting a running session.
   */
  private async deliverFirstTurn(
    record: SessionLifecycleRecord,
    effect: ReturnType<SessionLifecycleService['firstTurnEffect']>,
  ): Promise<void> {
    const prompt = record.config.prompt;
    if (prompt === undefined) return;
    if (effect === undefined) throw new Error('a first-turn prompt has no durable effect identity');
    let admission: SessionEffectAdmission | undefined;
    try {
      const taskFile = await this.ports.tasks.writeAssignedTask(record.config.id, assignedTaskDocument(prompt));
      await this.ports.launcher.deliver(record, firstTurnInstruction(taskFile), async () => {
        admission = await this.ports.effects.begin(effect.key, effect.fingerprint, this.ports.clock.now());
        if (admission === 'conflict' || admission === 'unsettled')
          throw this.firstTurnRefusal(record.config.id, admission);
        // `settled` aborts this delivery at the exact pre-write boundary. The catch below recognises
        // it as a successful replay, while the launcher never reaches its first composer mutation.
        if (admission === 'settled') throw new FirstTurnSettledReplay();
      });
      if (admission !== 'perform')
        throw new Error(
          `session ${record.config.id}'s launcher delivered a first turn without durably admitting the pane write`,
        );
      await this.ports.effects.settle(effect.key, effect.fingerprint, this.ports.clock.now());
    } catch (error) {
      if (error instanceof FirstTurnSettledReplay && admission === 'settled') return;
      throw await this.recordFailure(record, error);
    }
  }

  /** The one initial turn this lifecycle may type, keyed beneath the session it acts on. */
  private firstTurnEffect(
    record: SessionLifecycleRecord,
  ): { readonly key: SessionEffectKey; readonly fingerprint: string } | undefined {
    const prompt = record.config.prompt;
    if (prompt === undefined) return undefined;
    return {
      key: { sessionId: record.config.id, effectId: 'turn-1' },
      fingerprint: createHash('sha256').update(assignedTaskDocument(prompt), 'utf8').digest('hex'),
    };
  }

  private firstTurnRefusal(id: SessionId, standing: Exclude<SessionEffectHeldStanding, 'settled'>): Error {
    return new Error(
      standing === 'conflict'
        ? `session ${id}'s first-turn effect id is held for a different assignment`
        : `session ${id}'s first-turn delivery began but never settled; refusing to type an assignment the agent may already have taken`,
    );
  }

  private async recordFailure(record: SessionLifecycleRecord, error: unknown): Promise<unknown> {
    try {
      await this.ports.launcher.snapshot(record);
    } catch {
      // Terminal failure is still durable when its optional frame capture fails; the missing artifact
      // is served later as absent evidence rather than fabricated as a blank frame.
    }
    await this.persist(transitionSessionRecord(record, 'failed', this.ports.clock.now(), failureMessage(error)));
    return error;
  }

  private async persist(transition: {
    readonly record: SessionLifecycleRecord;
    readonly event: SessionLifecycleEvent;
  }): Promise<SessionLifecycleRecord> {
    await this.ports.repository.write(transition.record, transition.event);
    return transition.record;
  }

  private async require(id: SessionId): Promise<SessionLifecycleRecord> {
    const record = await this.ports.repository.read(id);
    if (!record) throw new Error(`session not found: ${id}`);
    return record;
  }
}

/** Internal control flow: a concurrent settled turn is a replay, never a lifecycle failure. */
class FirstTurnSettledReplay extends Error {}
