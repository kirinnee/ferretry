import type { CallContext, FerretId, RouteHandler, SocketAccept, StateFileDef } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import type { FerretIngestEvidence, FerretsApi, FerretSummary, FerretWaitFiles } from '../../contract/index.ts';
import type manifest from '../../manifest.ts';
import type { RunnerSessionGit } from '../adapters/session/filesystem/index.ts';
import type { SessionFilesystem } from '../lib/session/filesystem/index.ts';
import type { HarnessTranscript } from '../adapters/session/live/harness-transcript.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import type { HistoryEventSource } from '../modules/fleet-events.ts';
import type { BuiltMoves } from '../moves.ts';
import type { BuiltWorktrees } from '../modules/worktrees.ts';
import type { SessionFiles } from '../modules/session-files.ts';
import type { AgentPinService } from '../lib/agent-pins/index.ts';
import type { OutdatedMark } from '../lib/fleet-list/outdated-mark.ts';
import type { BootPassGate } from '../lib/session/auto-resume/boot-gate.ts';
import type { LaunchStepRegistrar } from '../lib/ferrets/launch-steps.ts';
import type { FerretsService } from '../lib/ferrets/service.ts';
import type { LaunchInstructionSectionId } from '../lib/protocol/session.ts';
import type { FerretRegistry } from '../lib/registry/registry.ts';
import type { StateHomeLaunchReach } from '../lib/route-security/state-home.ts';

/**
 * A Ferrets FEATURE: one file under `daemon/features/`, one default export, nothing else to edit. The generator
 * (`scripts/gen/registries.ts`) lists every file in this folder into `daemon/generated/features.ts`, and `build()` in
 * `daemon/index.ts` registers them all, so a feature that adds a route, a socket, a job or a piece of the Ferrets port
 * adds ONE file and touches no composition root.
 */
export interface FerretsFeature {
  /** What this feature is called in a wiring fault (a duplicate route, a feature that throws). Unique. */
  readonly id: string;
  /**
   * Builds the feature from the shared composition and returns what it serves. Jobs are added here through
   * `f.kernel.jobs.add`, subscriptions through `f.kernel`; nothing runs before the daemon serves except what a job does.
   */
  readonly register: (f: FerretsContext) => FeatureContribution | undefined;
}

/** What one feature serves. Route and socket keys are the manifest's; two features serving one key is a wiring fault. */
export interface FeatureContribution {
  readonly routes?: Readonly<Record<string, RouteHandler>>;
  readonly sockets?: Readonly<Record<string, SocketAccept>>;
  /** Members this feature adds to the Ferrets port every needer is handed (a read it owns). */
  readonly port?: Partial<FerretsApi>;
}

/**
 * Values a feature needs from one that registers beside it, or from the service the composition builds before any
 * feature runs. The composition (`index.ts`) assigns what it owns; a feature assigns what it builds. Read at the moment
 * of use, never at registration (the service's ports call them lazily).
 */
export interface LateBindings {
  /** Brings a ferret's next turn-watch look forward (the turn-watch feature). */
  wakeTurnWatch?: (ferret: FerretId) => void;
  /** Opens once the auto-resume boot pass has closed its recorder; the turn watch's vanished-pane observers wait on it. */
  bootPass?: BootPassGate;
  /** The managed worktrees (the worktrees feature). */
  worktrees?: BuiltWorktrees;
  /** The moves and forks (the moves feature). */
  moves?: BuiltMoves;
}

type Daemon = DaemonContext<typeof manifest>;
type WaitDocument = typeof FerretWaitFiles extends StateFileDef<string, infer Shape> ? Shape : never;

/** The shared composition every feature registers against: what `index.ts` builds once, in one place. */
export interface FerretsContext {
  /** The context the kernel handed Ferrets' `build` (a feature that composes another module's `needs` takes it whole). */
  readonly daemon: Daemon;
  readonly kernel: Daemon['kernel'];
  readonly hooks: Daemon['hooks'];
  readonly needs: Daemon['needs'];
  readonly log: ReturnType<Daemon['kernel']['log']['child']>;
  readonly registry: FerretRegistry;
  readonly service: FerretsService;
  /** The session store (documents, config, state, archive) and the ferret's private session files. */
  readonly sessionStore: DaemonStorage;
  readonly sessionFiles: SessionFiles;
  /** Adds to what every launch asks (a pane variable each), at registration only: sealed once the features have run. */
  readonly launch: LaunchStepRegistrar;
  /** Resolves once the held records and tokens are loaded. */
  readonly ready: () => Promise<void>;
  /** Settles once the session store's archive is loaded (it may reject: a load that failed). */
  readonly storeLoaded: Promise<unknown>;
  /** Resolves once the archive is read or has failed to load (a load that failed holds no archived name). */
  readonly archiveRead: () => Promise<void>;
  /** The callsigns and names the fleet holds: its records and the archived sessions. */
  readonly heldClaims: () => ReturnType<FerretRegistry['nameClaims']>;
  /** Appends one event to a ferret's `history.jsonl` and publishes it on the journal stream. */
  readonly appendHistory: (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly eventSource: HistoryEventSource;
  /** The owner's sidebar pins, and the clock their records and each ferret's notes share. */
  readonly agentPins: AgentPinService;
  readonly pinClock: { readonly now: () => string };
  /** The transcript through the harness that wrote it (the turn fold and both stream sources read it). */
  readonly transcripts: HarnessTranscript;
  /** The registry edge the state document's lifecycle status follows, and the ended ferret's environment file removal. */
  readonly followStatus: (ferret: FerretId, state: FerretSummary['state'], cause: 'lifecycle' | 'reconcile') => void;
  readonly removeEnvironment: (ferret: FerretId) => void;
  /** A ferret's `waiting.json`, or an empty one: what it declared, the time credited for it, and when it finished. */
  readonly parkedFile: (ferret: FerretId) => Promise<WaitDocument>;
  /** The file browser's service for one ferret (it pins that ferret's `work` root), and the Git it runs through. */
  readonly sessionFilesystemOf: (ferret: string) => SessionFilesystem;
  readonly sessionGit: RunnerSessionGit;
  /** The model a ferret is really running, and what its documents say that the insights index needs. */
  readonly displayModelOf: (ferret: FerretId) => Promise<string | undefined>;
  readonly ingestEvidenceOf: (ferret: FerretId) => Promise<FerretIngestEvidence | undefined>;
  /** What a launch now would tell a running ferret, against what its own launch told it. */
  readonly outdated: {
    readonly sections: (ferret: FerretId) => Promise<readonly LaunchInstructionSectionId[]>;
    readonly marks: OutdatedMark;
  };
  /** The ferret an id or a name addresses, or none. */
  readonly resolveFerret: (reference: string) => FerretId | undefined;
  /** The ferret a path names (`:ferretId`): an id or a name; refuses with 400, 404 or 409. */
  readonly pathFerret: (call: CallContext) => Promise<FerretId>;
  /** A ferret may stop, resume or rename itself and its helpers; a person any ferret. */
  readonly mayAct: (call: CallContext, target: FerretId) => void;
  /** An agent reaches only its own ferret and its helpers'; a person is unaffected. */
  readonly agentMayReach: (call: CallContext, target: FerretId) => void;
  /** The request body as JSON (`{}` when empty; 400 `invalid_json` otherwise). */
  readonly parseJson: (text: string) => unknown;
  readonly body: (call: CallContext) => Promise<unknown>;
  /** The state-home fence a launch folder is judged by, and the folders a governed device may launch in. */
  readonly stateHomeReach: StateHomeLaunchReach;
  readonly knownLaunchRoots: () => Promise<readonly string[]>;
  /** Wakes the views of the ferret list: a change the registry does not carry (a pin) says so. */
  readonly publishChanged: (ferret: string) => void;
  /** Whether the archive took this ferret out of the live set; brings an archived ferret back. */
  readonly isArchived: (ferret: string) => boolean;
  readonly reviveArchived: (ferret: string) => Promise<void>;
  readonly late: LateBindings;
}
