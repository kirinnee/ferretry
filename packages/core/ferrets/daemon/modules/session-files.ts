import { createHash, randomUUID } from 'node:crypto';
import { ApiError, type Log, type RootHandle, type RootsPort } from '@ferretry/kernel/contract';
import { FERRET_READABLE_FOLDERS, FERRET_SESSIONS_ROOT } from '../../contract/sessions-root.ts';
import type { FerretTurnAuthor, FerretTurnWritten } from '../../contract/port.ts';
import { type Duration, type Instant, instantFromEpochMs, milliseconds } from '@ferretry/std';
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
import {
  type RegisteredAncestor,
  StorageSessionAncestry,
} from '../adapters/session/provenance/storage-session-ancestry.ts';
import { StorageSessionProvenanceStore } from '../adapters/session/provenance/storage-session-provenance-store.ts';
import { InMemoryLaunchGate } from '../adapters/session/resume/in-memory-launch-gate.ts';
import { FileResumeTurnStore } from '../adapters/session/resume/file-resume-turn-store.ts';
import { StorageResumeRepository } from '../adapters/session/resume/storage-resume-repository.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import type { FerretSessionPort, OpeningFile, ReviveTurn, ReviveTurnRequest } from '../lib/ferrets/service.ts';
import { type SessionDocumentSeed, sessionDocument, sessionStateDocument } from '../lib/ferrets/session-document.ts';
import { assignedTaskDocument, queuedPayloadFile } from '../lib/protocol/turn-handoff.ts';
import { firstTurnInstruction } from '../lib/session/lifecycle/policy.ts';
import type { SessionEffectKey } from '../lib/session/effects/types.ts';
import { defaultSessionResumeSettings } from '../lib/session/resume/settings.ts';
import { resumeTurnDocument, resumeTurnInstruction } from '../lib/session/resume/policy.ts';
import type { ClockPort } from '../lib/ports.ts';
import type { SessionProtocolEnvelope } from '../adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { type SessionId, parseSessionId, tryParseSessionId } from '../lib/session-id.ts';
import {
  defaultSessionLifecycleSettings,
  SessionCredentialRotation,
  type SessionEnvironmentStore,
  type SessionLifecycleLauncher,
  SessionLifecycleService,
} from '../lib/session/lifecycle/index.ts';
import { SessionProvenanceRecorder, type SessionAncestry } from '../lib/session/provenance/recorder.ts';
import { resolveWardenLineage } from '../lib/session/provenance/lineage.ts';
import { SessionProvenanceStamper } from '../lib/session/provenance/stamper.ts';
import type { SessionSpawnRequest } from '../lib/session/provenance/types.ts';
import { SessionConfigSchema } from '../lib/protocol/session.ts';

/** The id a lineage question about a ferret that does not exist yet carries; it names no real session. */
const UNSTARTED_FERRET = '(not started)';

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

/**
 * The one initial turn a start may type, keyed beneath the ferret it acts on: today's lifecycle `firstTurnEffect`, word
 * for word (`turn-1`, fingerprinted by the SHA-256 of the assigned task document).
 */
function firstTurnEffect(
  id: SessionId,
  prompt: string,
): { readonly key: SessionEffectKey; readonly fingerprint: string } {
  return {
    key: { sessionId: id, effectId: 'turn-1' },
    fingerprint: createHash('sha256').update(assignedTaskDocument(prompt), 'utf8').digest('hex'),
  };
}

/** What the ferret's private session files are built from. */
export interface SessionFilesDeps {
  /** The kernel's roots; `sessions` is the one root these files may sit on. */
  readonly roots: Pick<RootsPort, 'root'>;
  readonly storage: DaemonStorage;
  readonly clock: ClockPort;
  /** The kernel's sleep, for the launch gate's poll. */
  readonly sleep: (delay: Duration) => Promise<void>;
  readonly paths: ConstructorParameters<typeof NodeWorkingDirectoryResolver>[0];
  /**
   * Every ferret the registry holds, as it was ASKED to be. Lineage reads each one's session document strictly and
   * takes the label, parent and stamp from there; this answer is used only for a ferret that has no document yet.
   */
  readonly fleet: () => readonly RegisteredAncestor[];
  /** What opens a pane: Terminals' to bind. Without it a lifecycle refuses at the launch, before anything is typed. */
  readonly launcher?: SessionLifecycleLauncher;
  /**
   * The registry's record of a ferret and its start options, which its session document is made from (ruling #31b).
   * `undefined` for a ferret the registry does not hold: no document can be made for it.
   */
  readonly seed?: (ferret: SessionId) => Omit<SessionDocumentSeed, 'turn'> | undefined;
  readonly log: Pick<Log, 'warn'>;
}

/** The folder of a ferret's own session folder its opening attachments are written to (one of `FERRET_READABLE_FOLDERS`). */
const ATTACHMENTS_FOLDER = 'attachments';

/** The file Claude Code's question hook writes in a ferret's session folder (today's `SessionPaths.questionAsked`). */
const QUESTION_ASKED_FILE = 'question-asked.json';

/**
 * Ferrets' per-ferret private session files, all on the internal `sessions` root (`state/ferrets/sessions/<ferret>/`):
 * the environment (the plaintext credential, `environment.json`, `0600`), the assigned task (`turns/turn-001.md`), every
 * revive's numbered turn (`turns/turn-NNN.md`, its author beside it) and completion markers (`{marker}.marker`), and
 * the effect ledger (`effects/`). It is also the ferret's session-document writer (`config.json`, ruling #31b). Every handle is scoped to ONE minted ferret folder, and every store asserts it was
 * handed that root, so none of them can be built on `work` or on any owner's tree.
 *
 * One launch gate and one serial queue for the whole process: a second of either would not see the first one's launches.
 */
export class SessionFiles {
  /** ONE gate, shared by the lifecycle, the resume, the sends, the exit observer and the interrupted-launch reconciler. */
  readonly launchGate: InMemoryLaunchGate;
  /**
   * ONE per-session mutation queue (today's `sessionMutations`): the lifecycle uses it, and so must every other
   * writer of a session's launch state. GAP(ports-pending: Session adapters): FerretsService's start/stop runs on its
   * own executor, so before a lifecycle may launch a ferret that already exists, that start/stop must run on THIS
   * queue (as must the interrupted-launch reconciler, runtime control, Pack hooks and switches, and answers).
   */
  readonly serial = new KeyedSerialExecutor();
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
  /** Settles once every held ferret has a session document (`backfill`); a stamp and a carry wait for it. */
  private documented: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionFilesDeps) {
    this.launchGate = new InMemoryLaunchGate(async ms => await deps.sleep(milliseconds(ms)));
    this.hashes = new StorageSessionCapabilityHashStore(deps.storage);
    this.provenance = new StorageSessionProvenanceStore(deps.storage);
    this.stamper = new SessionProvenanceStamper(deps.clock);
    // STRICT, unlike `provenance.read` (which answers "no stamp" for the session's OWN damaged document, as today's
    // recorder does): a damaged or vanished ancestor throws, so a start is refused and a resume writes nothing.
    this.ancestry = new StorageSessionAncestry(deps.storage, deps.fleet);
    this.recorder = new SessionProvenanceRecorder(this.stamper, this.provenance, this.ancestry);
    this.environment = {
      read: async id => await this.environmentStore(id).read(id),
      write: async (id, environment) => await this.environmentStore(id).write(id, environment),
    };
    this.port = {
      prepare: async ferret => await this.prepare(ferret),
      stamp: async request => await this.stampAtStart(request),
      carry: async ferret => await this.carryOnResume(ferret),
      // The same source (the ancestor snapshot of the session documents) and the same rule (`resolveWardenLineage`)
      // the start's stamp uses. A snapshot that throws is not caught: the port refuses on a rejection.
      inWardenLineage: async parent => {
        // As the stamp does: after the backfill, so an indexed ferret with no document yet (the boot window) is not
        // read as a damaged ancestor and a non-warden start refused for it.
        await this.documented.catch(() => undefined);
        return resolveWardenLineage({ id: UNSTARTED_FERRET, parent }, await this.ancestry.snapshot()).wardenLineage;
      },
      readable: async ferret => {
        const own = this.root(parseSessionId(ferret));
        return FERRET_READABLE_FOLDERS.map(folder => {
          const resolved = own.resolve(folder);
          if (!resolved.ok) throw new Error('a hand-off folder of this ferret could not be named');
          return resolved.value;
        });
      },
      askedQuestion: async ferret => await this.readAskedQuestion(parseSessionId(ferret)),
      // Claude Code's question hook records the question it asks here (`FY_QUESTION_FILE`, today's `questionAsked`):
      // inside the ferret's own folder on the sessions root, never in its work tree.
      questionFile: async ferret => {
        const named = this.root(parseSessionId(ferret)).resolve(QUESTION_ASKED_FILE);
        if (!named.ok) throw new Error('the question file of this ferret could not be named');
        return named.value;
      },
      assign: async (ferret, prompt) => {
        const id = parseSessionId(ferret);
        return firstTurnInstruction(await this.taskStore(id).writeAssignedTask(id, assignedTaskDocument(prompt)));
      },
      admitFirstTurn: async (ferret, prompt) => {
        const id = parseSessionId(ferret);
        const { key, fingerprint } = firstTurnEffect(id, prompt);
        return await this.effectLedger(id).begin(key, fingerprint, this.deps.clock.now());
      },
      settleFirstTurn: async (ferret, prompt) => {
        const id = parseSessionId(ferret);
        const { key, fingerprint } = firstTurnEffect(id, prompt);
        await this.effectLedger(id).settle(key, fingerprint, this.deps.clock.now());
      },
      revive: async (ferret, request) => await this.revive(parseSessionId(ferret), request),
      turns: async (ferret, options) => {
        const id = parseSessionId(ferret);
        return await this.turnStore(id).list(id, options);
      },
      queued: async (ferret, payload, sendId) => await this.writeQueued(parseSessionId(ferret), payload, sendId),
      writeTurn: async (ferret, document, by) => await this.writeSendTurn(parseSessionId(ferret), document, by),
      clearMarkers: async ferret => await this.turnStore(parseSessionId(ferret)).clearMarkers(parseSessionId(ferret)),
      attachmentsFolder: async ferret => {
        const named = this.root(parseSessionId(ferret)).resolve(ATTACHMENTS_FOLDER);
        if (!named.ok) throw new Error('the attachments folder of this ferret could not be named');
        return named.value;
      },
      attach: async (ferret, files) => await this.writeAttachments(parseSessionId(ferret), files),
    };
  }

  /**
   * A send's turn document (today's `deliver`, `writeTurn`): the next number after the higher of the session counter and the
   * documents on disk, written durably with its author beside it, then counted so a later revive numbers after it.
   * A counter that cannot be saved refuses the write (the send then types nothing), as a revive's does.
   */
  private async writeSendTurn(
    id: SessionId,
    document: string,
    by: FerretTurnAuthor | undefined,
  ): Promise<FerretTurnWritten> {
    await this.ensureDocument(id).catch(() => false);
    const store = this.turnStore(id);
    const turn = await this.nextTurn(id, store, document, by);
    const file = await store.writeTurn(id, turn, document, by);
    await this.count(id, turn);
    return { turn, file };
  }

  /**
   * Gives every ferret the registry holds a session document, once, before any stamp or carry reads the fleet's lineage
   * (ruling #31b). A ferret started or resumed before the writer existed holds only `history.jsonl`, which the session
   * store indexes; today's strict ancestry refuses every stamp while an indexed session has no document, so without this
   * pass the first documented start would be refused fleet-wide. A ferret whose document cannot be made is named in the
   * log (its id only) and left as it was: its ancestry still refuses, as today's does.
   *
   * The gate is set the moment this is CALLED, before the ferret list is known, so the daemon half calls it while it
   * builds: a stamp can never run between the build and the pass and see the gate still open.
   */
  backfill(ferrets: () => Promise<readonly string[]>): Promise<void> {
    this.documented = (async () => {
      for (const ferret of await ferrets()) {
        // Parsed INSIDE the per-ferret catch: one id the session store refuses (upper case is a valid ferret id but
        // not a stored session id) is named and skipped, never the end of the pass for every ferret after it.
        const id = tryParseSessionId(ferret);
        if (id === undefined) {
          this.deps.log.warn('a ferret id is not a session id, so it was given no session document', { ferret });
          continue;
        }
        await this.ensureDocument(id).catch(() =>
          this.deps.log.warn('a ferret session document could not be made', { ferret: id }),
        );
      }
    })();
    return this.documented;
  }

  /**
   * THE SESSION-DOCUMENT WRITER (ruling #31b): makes the ferret's `config.json` (and the `state.json` beside it) from
   * the registry's record when it has none, and never touches one that is there. `false` when the registry holds no
   * record to make it from. A document that cannot be read throws (no catch): "unreadable" is never taken for "absent",
   * so a damaged document is never written over.
   */
  private async ensureDocument(id: SessionId): Promise<boolean> {
    if ((await this.deps.storage.readConfig(id)) !== undefined) return true;
    const seed = this.deps.seed?.(id);
    if (seed === undefined) return false;
    const full: SessionDocumentSeed = { ...seed, turn: await this.turnStore(id).latest(id) };
    const document = SessionConfigSchema.parse(sessionDocument(full, this.deps.clock.now()));
    const write = async () => {
      // Upserts: another writer that made it first wins, exactly as it wrote it.
      await this.deps.storage.upsertConfig(id, current => current ?? document);
      await this.deps.storage.upsertState(id, current => current ?? sessionStateDocument(full));
    };
    // A child's first write retains its lead first, as the lifecycle's create does.
    const parent = seed.record.parent;
    if (parent === undefined) await write();
    else await this.deps.storage.publishChild(parseSessionId(parent), write);
    return true;
  }

  /** The ferret's turn documents and completion markers, on its own folder. */
  turnStore(id: SessionId): FileResumeTurnStore {
    return new FileResumeTurnStore(this.root(id), id);
  }

  /**
   * A revive's turn (today's `SessionResumeService.relaunch`, the turn half): the markers the previous turn left are
   * cleared, and unless the revive invents no turn (an interactive ferret resumed with no message, today's `bare`) the
   * numbered document is written durably first, then counted, all before the relaunch (today's order). Each attempt
   * takes a fresh number ({@link nextTurn}), so a document is never rewritten with other words or left with another
   * turn's author; only an exact replay of a turn written but never counted hands the same document over again.
   */
  private async revive(id: SessionId, request: ReviveTurnRequest): Promise<ReviveTurn | undefined> {
    // A document that cannot be made or read does not stop the revive: the number then comes from the files on disk.
    await this.ensureDocument(id).catch(() => false);
    const store = this.turnStore(id);
    const trimmed = request.message?.trim();
    const bare = request.mode === 'interactive' && !trimmed;
    let turn: ReviveTurn | undefined;
    if (!bare) {
      const settings = defaultSessionResumeSettings;
      const document = resumeTurnDocument(trimmed ?? settings.defaultResumePrompt, settings);
      const number = await this.nextTurn(id, store, document, request.by);
      const file = await store.writeTurn(id, number, document, request.by);
      turn = { turn: number, file, instruction: resumeTurnInstruction(file) };
    }
    await store.clearMarkers(id);
    // Today's order: the counter is saved BEFORE the relaunch (today's `session.resuming` transition carries the
    // turn), so every attempt that wrote a turn holds its own number, and a relaunch that then fails leaves its
    // document on disk as the evidence of what the agent was about to be handed. A counter that cannot be saved
    // refuses the relaunch, as today's transition did; the document stays, and only an exact replay reuses it.
    if (turn !== undefined) await this.count(id, turn.turn);
    return turn;
  }

  /**
   * The number a revive's turn takes: the one after the HIGHER of the counter the session document holds and the
   * documents on disk, so a turn is never numbered onto a document that is already there, whoever wrote it. The one
   * exception is an exact replay — the highest document is above the counter (written, never counted) and its words
   * and author record are exactly the new ones — which hands that same document over again, proved in place.
   */
  private async nextTurn(
    id: SessionId,
    store: FileResumeTurnStore,
    document: string,
    by: ReviveTurnRequest['by'],
  ): Promise<number> {
    const counted = (await new StorageResumeRepository(this.deps.storage).read(id).catch(() => undefined))?.turn ?? 0;
    const latest = await store.latest(id);
    if (latest > counted && (await store.matches(id, latest, document, by))) return latest;
    return Math.max(counted, latest) + 1;
  }

  /** The session document counts `turn`, so the next revive numbers after it. */
  private async count(id: SessionId, turn: number): Promise<void> {
    try {
      await this.deps.storage.updateState(id, current => ({
        ...(typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {}),
        turn,
      }));
    } catch (error) {
      this.deps.log.warn('a revive turn could not be counted, so the ferret was not relaunched', { ferret: id });
      throw error;
    }
  }

  /** The most bytes of `question-asked.json` read: a hook payload is a few kilobytes, so a larger file is not one. */
  private static readonly ASKED_QUESTION_LIMIT = 262_144;

  /** The payload last read per ferret and when it was FIRST seen (a root offers no mtime): the same text keeps its instant. */
  readonly #askedSeen = new Map<SessionId, { readonly payload: string; readonly at: Instant }>();

  /**
   * THIS ferret's `question-asked.json` as the hook left it, bounded, and the instant that payload was first seen (the
   * hook replaces the file whole for every question, so a changed payload is a new question). `undefined` when the file
   * is absent, unreadable or over the bound; reading never throws.
   */
  private async readAskedQuestion(
    id: SessionId,
  ): Promise<{ readonly payload: string; readonly writtenAt: Instant } | undefined> {
    try {
      const root = this.root(id);
      const named = root.resolve(QUESTION_ASKED_FILE);
      if (!named.ok) return undefined;
      const bytes = await root.readBytes(named.value, SessionFiles.ASKED_QUESTION_LIMIT + 1);
      if (bytes.length > SessionFiles.ASKED_QUESTION_LIMIT) return undefined;
      const payload = new TextDecoder().decode(bytes);
      const known = this.#askedSeen.get(id);
      if (known?.payload === payload) return { payload, writtenAt: known.at };
      const at = instantFromEpochMs(Date.parse(this.deps.clock.now()));
      this.#askedSeen.set(id, { payload, at });
      return { payload, writtenAt: at };
    } catch {
      this.#askedSeen.delete(id);
      return undefined;
    }
  }

  /**
   * A message too long to type into a busy pane, written to the ferret's own `channel/queued-<send id>.md` (today's
   * `FileSendTurnStore.writeQueuedPayload`): the folder made `0700` first, the file published durably and `0600`
   * through a temporary name, so an agent that opens the path the instant it is told never reads half a message. The
   * same send id rewrites the same file; an absent or out-of-grammar one takes a fresh id. Answers the absolute path.
   */
  private async writeQueued(id: SessionId, payload: string, sendId: string | undefined): Promise<string> {
    const root = this.root(id);
    await new OwnFolder(root).ensure();
    const relative = (sendId === undefined ? undefined : queuedPayloadFile(sendId)) ?? queuedPayloadFile(randomUUID());
    const named = relative === undefined ? undefined : root.resolve(relative);
    if (named === undefined || !named.ok) throw new Error('a queued message file of this ferret could not be named');
    await root.publish(named.value, new TextEncoder().encode(`${payload}\n`), { mode: 0o600 });
    return named.value;
  }

  /**
   * The files a start was given (`start -f`) written into the ferret's own `attachments/` folder: the session folder made
   * `0700` first, each file published durably and `0600` through a temporary name (the folder itself is made `0700` by the
   * publish). A name that is not a bare file name writes nothing at all, before the first file is written.
   */
  private async writeAttachments(id: SessionId, files: readonly OpeningFile[]): Promise<void> {
    const root = this.root(id);
    await new OwnFolder(root).ensure();
    const named = files.map(file => {
      const path =
        /^[^/\\\0]+$/u.test(file.name) && file.name !== '.' && file.name !== '..'
          ? root.resolve(`${ATTACHMENTS_FOLDER}/${file.name}`)
          : undefined;
      if (path === undefined || !path.ok) throw new Error('an attachment of this ferret could not be named');
      return { path: path.value, contents: file.contents };
    });
    for (const { path, contents } of named)
      await root.publish(path, typeof contents === 'string' ? new TextEncoder().encode(contents) : contents, {
        mode: 0o600,
      });
  }

  /** The ferret's own `sessions` handle: one minted folder, internal, private. */
  root(ferret: string): RootHandle {
    return this.deps.roots.root(FERRET_SESSIONS_ROOT, { subfolder: ferret });
  }

  environmentStore(id: SessionId): FileSessionEnvironmentStore {
    return new FileSessionEnvironmentStore(this.root(id), id);
  }

  /**
   * Deletes an ended ferret's `environment.json` (its credential is dead once it has ended), on the ferret's own queue
   * and only while `stillEnded` still says it has: a resume that began first has a new credential to keep. Never
   * follows a link, a missing file is fine, and the ferret's folder is not made for it. Throws a real fault for the
   * caller to log.
   */
  async removeEnvironment(id: SessionId, stillEnded: () => boolean): Promise<void> {
    await this.serial.run(id, async () => {
      if (stillEnded()) await this.environmentStore(id).remove(id);
    });
  }

  taskStore(id: SessionId): FileSessionTaskStore {
    return new FileSessionTaskStore(this.root(id), id);
  }

  effectLedger(id: SessionId): FileSessionEffectLedger {
    return new FileSessionEffectLedger(this.root(id), id);
  }

  /**
   * One lifecycle for one session: its stores on its own folder, the shared gate and queue. Built without today's
   * conversation `leases` and board `projects` (GAP(ports-pending: Session adapters)): `leases` must be bound before a
   * pane launcher is.
   */
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
   * A START records who caused the ferret, in its session document, which the session-document writer makes first from
   * the registry's record (ruling #31b), after the boot's backfill has given every held ferret one. The ancestry is then
   * read STRICTLY, as today's start reads it, so a damaged, unreadable or vanished ancestor refuses the start. Only a
   * ferret the registry does not hold (none in this build reaches here) has no document to make; it records nothing and
   * says so. A document that is there and cannot take the stamp refuses the start.
   */
  private async stampAtStart(request: SessionSpawnRequest): Promise<void> {
    const id = parseSessionId(request.id);
    await this.documented.catch(() => undefined);
    if (!(await this.ensureDocument(id))) {
      this.deps.log.warn('a ferret has no session document yet, so its spawn stamp was not recorded', { ferret: id });
      return;
    }
    const stamped = this.stamper.stamp(request, await this.ancestry.snapshot());
    // The port admitted this start as outside the Warden's tree, reading the ancestry on its own: if lineage resolves
    // true here after all (a resume of the parent strengthened its stamp in between), the start is refused rather than
    // recorded as the Warden's descendant. The sentence names nothing the caller supplied.
    if (request.notInWardenTree === true && stamped.provenance.wardenLineage)
      throw new Error('a start the port admitted as outside the Warden’s tree would be stamped into it');
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
   * document winning on every spawn fact. A copy of today's `recordRelaunchProvenance`: the label and parent are the
   * ones the session's OWN document holds, never the registry's, because a move, a handover or an owner's edit may
   * have changed either there since the record was written, and a registry label written over the document's would
   * both drop the owner's edit and restamp a warden's child as nobody's.
   *
   * The document is read STRICTLY, as today's `sessions.get` reads it: one that cannot be read, or fails
   * `SessionConfigSchema`, throws, so the resume writes nothing and the stamp on disk stays as it was. The error names
   * the id only. A ferret that ran before the writer existed is given its document first (ruling #31b).
   */
  private async carryOnResume(ferret: string): Promise<void> {
    const id = parseSessionId(ferret);
    await this.documented.catch(() => undefined);
    // A ferret that ran before the writer existed gets its document now; no catch: an unreadable one brings nothing.
    await this.ensureDocument(id);
    const document = await this.deps.storage.readConfig(id);
    if (document === undefined) return;
    const parsed = SessionConfigSchema.safeParse(document);
    if (!parsed.success)
      throw new Error(`session ${id}'s configuration is damaged, so its spawn stamp was not brought forward`);
    const { label, parent } = parsed.data;
    await this.recorder.recordRelaunch({
      id,
      ...(label === undefined ? {} : { label }),
      ...(parent === undefined ? {} : { parent }),
      // A resume is not a spawn: `restamp` recovers the origin from the stored stamp when there is one, and a session
      // with no stamp and no parent was a root start, which is the human case (today's rule, word for word).
      requestedByHuman: parent === undefined,
    });
  }
}
