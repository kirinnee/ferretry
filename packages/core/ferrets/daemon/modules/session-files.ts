import { ApiError, type Log, type RootHandle, type RootsPort } from '@ferretry/kernel/contract';
import { type Duration, milliseconds } from '@ferretry/std';
import { FileSessionEffectLedger } from '../adapters/session/effects/file-session-effect-ledger.ts';
import {
  FileSessionEnvironmentStore,
  FileSessionTaskStore,
  NodeSessionCredentialIssuer,
  NodeWorkingDirectoryResolver,
  StorageSessionCapabilityHashStore,
  StorageSessionLifecycleRepository,
} from '../adapters/session/lifecycle/index.ts';
import { OwnFolder } from '../adapters/session/sessions-root.ts';
import { StorageSessionProvenanceStore } from '../adapters/session/provenance/storage-session-provenance-store.ts';
import { InMemoryLaunchGate } from '../adapters/session/resume/in-memory-launch-gate.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import type { FerretSessionPort } from '../lib/ferrets/service.ts';
import type { ClockPort } from '../lib/ports.ts';
import type { SessionProtocolEnvelope } from '../adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { type SessionId, parseSessionId } from '../lib/session-id.ts';
import {
  defaultSessionLifecycleSettings,
  SessionCredentialRotation,
  type SessionEnvironmentStore,
  type SessionLifecycleLauncher,
  SessionLifecycleService,
} from '../lib/session/lifecycle/index.ts';
import { SessionProvenanceRecorder, type SessionAncestry } from '../lib/session/provenance/recorder.ts';
import { SessionProvenanceStamper } from '../lib/session/provenance/stamper.ts';
import type { SessionAncestor, SessionSpawnRequest } from '../lib/session/provenance/types.ts';

/**
 * A lifecycle launcher that opens nothing: every member answers the spine's 503 when CALLED, so a launch through a
 * lifecycle built without Terminals' launcher refuses before any pane exists (and before the first turn is typed).
 */
const NO_LAUNCHER = new Proxy({} as SessionLifecycleLauncher, {
  get: (_target, member) =>
    typeof member === 'symbol'
      ? undefined
      : () => {
          throw new ApiError(
            503,
            `Launching a ferret pane (${member}) is not built yet in this version of Ferretry.`,
            'plugin_unavailable',
          );
        },
});

/** What the ferret's private session files are built from. */
export interface SessionFilesDeps {
  /** The kernel's roots; `sessions` is the one root these files may sit on. */
  readonly roots: Pick<RootsPort, 'root'>;
  readonly storage: DaemonStorage;
  readonly clock: ClockPort;
  /** The kernel's sleep, for the launch gate's poll. */
  readonly sleep: (delay: Duration) => Promise<void>;
  readonly paths: ConstructorParameters<typeof NodeWorkingDirectoryResolver>[0];
  /** Every ferret the fleet holds, as lineage resolution may consult it (without any stamp: that is read here). */
  readonly fleet: () => readonly Omit<SessionAncestor, 'provenance'>[];
  /** What opens a pane: Terminals' to bind. Without it a lifecycle refuses at the launch, before anything is typed. */
  readonly launcher?: SessionLifecycleLauncher;
  readonly log: Pick<Log, 'warn'>;
}

/**
 * Ferrets' per-ferret private session files, all on the internal `sessions` root (`state/ferrets/sessions/<ferret>/`):
 * the environment (the plaintext credential, `environment.json`, `0600`), the assigned task (`turns/turn-001.md`) and
 * the effect ledger (`effects/`). Every handle is scoped to ONE minted ferret folder, and every store asserts it was
 * handed that root, so none of them can be built on `work` or on any owner's tree.
 *
 * One launch gate and one serial queue for the whole process: a second of either would not see the first one's launches.
 */
export class SessionFiles {
  /** ONE gate, shared by the lifecycle, the resume, the sends, the exit observer and the interrupted-launch reconciler. */
  readonly launchGate: InMemoryLaunchGate;
  private readonly serial = new KeyedSerialExecutor();
  private readonly credentials = new NodeSessionCredentialIssuer();
  private readonly hashes: StorageSessionCapabilityHashStore;
  private readonly provenance: StorageSessionProvenanceStore;
  private readonly stamper: SessionProvenanceStamper;
  private readonly recorder: SessionProvenanceRecorder;
  private readonly ancestry: SessionAncestry;
  /** The environment of any ferret, read through its own folder. There is no member that returns it to a caller. */
  readonly environment: SessionEnvironmentStore;
  /** The spawn stamp and the private folder, as a launch asks for them. */
  readonly port: FerretSessionPort;

  constructor(private readonly deps: SessionFilesDeps) {
    this.launchGate = new InMemoryLaunchGate(async ms => await deps.sleep(milliseconds(ms)));
    this.hashes = new StorageSessionCapabilityHashStore(deps.storage);
    this.provenance = new StorageSessionProvenanceStore(deps.storage);
    this.stamper = new SessionProvenanceStamper(deps.clock);
    this.ancestry = {
      snapshot: async () =>
        new Map(
          await Promise.all(
            deps.fleet().map(async ancestor => {
              const stored = await this.provenance.read(ancestor.id);
              return [
                ancestor.id,
                { ...ancestor, ...(stored.provenance === undefined ? {} : { provenance: stored.provenance }) },
              ] as const;
            }),
          ),
        ),
    };
    this.recorder = new SessionProvenanceRecorder(this.stamper, this.provenance, this.ancestry);
    this.environment = {
      read: async id => await this.environmentStore(id).read(id),
      write: async (id, environment) => await this.environmentStore(id).write(id, environment),
    };
    this.port = {
      prepare: async ferret => await this.prepare(ferret),
      stamp: async request => await this.stampAtStart(request),
      carry: async request => await this.carryOnResume(request),
    };
  }

  /** The ferret's own `sessions` handle: one minted folder, internal, private. */
  root(ferret: string): RootHandle {
    return this.deps.roots.root('sessions', { subfolder: ferret });
  }

  environmentStore(id: SessionId): FileSessionEnvironmentStore {
    return new FileSessionEnvironmentStore(this.root(id), id);
  }

  taskStore(id: SessionId): FileSessionTaskStore {
    return new FileSessionTaskStore(this.root(id), id);
  }

  effectLedger(id: SessionId): FileSessionEffectLedger {
    return new FileSessionEffectLedger(this.root(id), id);
  }

  /** One lifecycle for one session: its stores on its own folder, the shared gate and queue. */
  createLifecycle = (id: SessionId, envelope?: SessionProtocolEnvelope): SessionLifecycleService =>
    new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(this.deps.storage, envelope),
        launcher: this.deps.launcher ?? NO_LAUNCHER,
        tasks: this.taskStore(id),
        effects: this.effectLedger(id),
        directories: new NodeWorkingDirectoryResolver(this.deps.paths),
        // The id is already minted by the caller, so the record and the plan cannot disagree about which session this is.
        ids: { next: () => id },
        clock: this.deps.clock,
        serial: this.serial,
        credentials: this.credentials,
        environment: this.environmentStore(id),
        rotation: new SessionCredentialRotation({
          credentials: this.credentials,
          environment: this.environmentStore(id),
          hashes: this.hashes,
        }),
        launches: this.launchGate,
      },
      defaultSessionLifecycleSettings,
    );

  /** Makes the ferret's folder (`0700`) or narrows an existing wider one: before anything is written for this launch. */
  private async prepare(ferret: string): Promise<void> {
    await new OwnFolder(this.root(parseSessionId(ferret))).ensure();
  }

  /**
   * A START records who caused the ferret, in its session document. The document is made by the lifecycle's create
   * (`createLifecycle`), which this build does not drive yet, so a ferret started by Ferrets' own service has none to
   * merge into: nothing is created for it and the start goes on (a session with no stamp is the answer "nobody has
   * decided", which every reader already handles). A document that is there and cannot take the stamp refuses the start.
   */
  private async stampAtStart(request: SessionSpawnRequest): Promise<void> {
    const id = parseSessionId(request.id);
    if ((await this.deps.storage.readConfig(id)) === undefined) {
      this.deps.log.warn('a ferret has no session document yet, so its spawn stamp was not recorded', { ferret: id });
      return;
    }
    const stamped = this.stamper.stamp(request, await this.ancestry.snapshot());
    const stored = await this.provenance.read(id);
    // The stored stamp wins: a start over a document that already carries one (a retried start) never rewrites it.
    if (stored.provenance !== undefined) return;
    await this.provenance.write(id, {
      provenance: stamped.provenance,
      ...(stamped.label === undefined ? {} : { label: stamped.label }),
    });
  }

  /**
   * A RESUME brings the stamp forward: the recorder re-resolves lineage and only ever strengthens it, the stored
   * document winning on every spawn fact. The request carries the session's CURRENT label, so a resume never drops
   * the group the session belongs to.
   */
  private async carryOnResume(request: SessionSpawnRequest): Promise<void> {
    const id = parseSessionId(request.id);
    if ((await this.deps.storage.readConfig(id)) === undefined) return;
    const stored = await this.provenance.read(id);
    const label = request.label ?? stored.label;
    await this.recorder.recordRelaunch({ ...request, ...(label === undefined ? {} : { label }) });
  }
}
