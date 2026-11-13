import { createHash } from 'node:crypto';
import type {
  ConversationFinder,
  Delivery,
  DialogReader,
  FoundConversation,
  Harness,
  HarnessDialog as FerretDialog,
  HarnessInstall,
  HarnessLaunchSettings,
  HarnessMissing,
  HarnessTranscriptBytes,
  HarnessTranscriptStamp,
  HarnessTranscriptTail,
  HomePlan,
  LaunchSpec,
  OutboundMessage,
  Runner,
  RunnerHandle,
  Started,
  StartRefusal,
  TranscriptEntry,
  TranscriptReader,
  TurnUsage,
  UpdateResult,
  UsageReader,
} from '@ferretry/core-ferrets/contract';
import { LaunchRefusal, materializeSkills, openTranscriptBytes } from '@ferretry/core-ferrets/contract';
import { MAX_ROOT_WINDOW_BYTES } from '@ferretry/kernel/contract';
import type {
  ChildEnvironment,
  Clock,
  ConfigFileDef,
  ConfigPort,
  FencedPath,
  FerretId,
  Redaction,
  RootHandle,
  RootsPort,
  RootStat,
  SpawnPort,
  StatePort,
} from '@ferretry/kernel/contract';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_LAUNCH_SETTINGS,
  CLAUDE_CODE_SETTINGS,
  type HarnessConfig,
} from '../../contract/index.ts';
import type { DialogAnswerService } from '../lib/dialog/service.ts';
import { MAX_HOME_DOCUMENT_BYTES as MAX_CLAUDE_JSON_BYTES, mergeClaudeJson } from '../lib/harness/claude-json.ts';
import { claudeTranscriptPath, isConversationId } from '../lib/harness/claude-path.ts';
import { HOME_FILES, homeText, launchCommand } from '../lib/harness/launch.ts';
import {
  compareLaunchSettings,
  type LaunchSettingsInputs,
  launchSettingsRecord,
} from '../lib/harness/launch-settings.ts';
import { markCutWindow, parseEntries, parseTail, parseUsage } from '../lib/harness/transcript.ts';
import { parseHarnessDialog } from '../lib/pane/harness-dialog.ts';
import { parsePermissionPrompt } from '../lib/pane/permission-prompt.ts';
import type { PermissionAnswerService } from '../lib/permission/service.ts';
import { type HarnessUpdateSubsystem, HarnessUpdateRefusal } from '../lib/update/service.ts';
import type { LocationSource, Probe } from '../lib/update/ports.ts';
import type { PaneDirectory } from './tmux-pane.ts';

export interface ClaudeHarnessDeps {
  readonly roots: RootsPort;
  readonly config: ConfigPort;
  /** This plugin's own state: what each ferret was last launched under (`launch-settings/<ferret>.json`). */
  readonly state: Pick<StatePort, 'read' | 'write' | 'remove' | 'version'>;
  readonly spawn: SpawnPort;
  readonly clock: Clock;
  readonly redaction: Redaction;
  readonly location: LocationSource;
  readonly probe: Probe;
  readonly update: HarnessUpdateSubsystem & { settled(): Promise<void> };
  readonly panes: PaneDirectory;
  readonly permission: PermissionAnswerService;
  readonly dialog: DialogAnswerService;
  /** A fresh conversation id: Claude takes `--session-id`, so the daemon assigns it. */
  readonly newConversationId: () => string;
  /** The user's documented Claude history home; only its projects subtree is read. */
  readonly historyHome: () => Promise<string>;
}

const TMUX_TIMEOUT_MS = 5_000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** How much of the end of a transcript one tail read takes: a turn's records are near the end. */
const TAIL_READ_BYTES = 512 * 1024;
const FIRST_RECORDS_BYTES = 16 * 1024;
/** A launch record is four fingerprints (~330 bytes); one larger than this is not one, and is never read. */
const MAX_LAUNCH_RECORD_BYTES = 4 * 1024;
const UNKNOWN_LAUNCH: HarnessLaunchSettings = { kind: 'unknown' };

const configFile = CLAUDE_CODE_CONFIG as unknown as ConfigFileDef<HarnessConfig>;
const settingsCollection = CLAUDE_CODE_SETTINGS as never;
const hooksCollection = CLAUDE_CODE_HOOKS as never;

/**
 * Claude Code as a harness (§4.3): the value of `harnesses:claude-code`. It finds `claude`, writes a ferret's home
 * in Claude's own format inside `agent-homes`, starts and resumes it through whatever runner Ferrets hands it,
 * delivers messages into its pane, and reads its transcript and usage back. It never opens a sign-in file.
 */
export class ClaudeHarness implements Harness {
  readonly key = 'claude-code' as const;
  /** Claude spends an Anthropic sign-in, an API key, or a proxy or endpoint that speaks the Anthropic API. */
  readonly accepts = ['anthropic', 'api-key', 'proxy', 'endpoint'] as const;
  /**
   * Today's stop key, harmless at an idle prompt (today's `STOP_KEY_SAFE_WHEN_IDLE`): at an interactive pane it clears a
   * half-typed composer or closes a menu, which is what "stop" means to the person pressing it.
   */
  readonly turnStop = { key: 'Escape', safeWhenIdle: true } as const;
  readonly #delivered = new Set<string>();

  constructor(private readonly deps: ClaudeHarnessDeps) {}

  async discover(): Promise<HarnessInstall | HarnessMissing> {
    const location = await this.deps.location.locate();
    if (location.outcome === 'absent')
      return { found: false, reason: `claude was not found (looked in: ${location.searched.join(', ')})` };
    if (location.outcome === 'override-absent')
      return { found: false, reason: `${location.declaredBy} names ${location.path}, but ${location.reason}` };
    const version = await this.deps.probe.version(location.path);
    if (version.state !== 'ok') return { found: false, reason: `claude at ${location.path}: ${version.reason}` };
    return { found: true, binary: location.path, version: version.version };
  }

  async update(): Promise<UpdateResult> {
    try {
      await this.deps.update.start({});
      await this.deps.update.settled();
    } catch (error) {
      if (error instanceof HarnessUpdateRefusal) return { updated: false, sentence: error.message };
      throw error;
    }
    const job = (await this.deps.update.view()).job;
    if (job?.state !== 'finished') return { updated: false, sentence: 'The update did not finish.' };
    const report = job.report;
    return {
      updated: report.outcome === 'succeeded',
      ...(report.to === undefined ? {} : { version: report.to }),
      sentence: report.message,
    };
  }

  /** `state/claude-code/agent-homes/<ferret>`, resolved through this plugin's own `agent-homes` root (S42). */
  async homeFor(ferret: FerretId): Promise<FencedPath> {
    return this.fenced(this.home(ferret).resolve(''));
  }

  async prepareHome(spec: LaunchSpec): Promise<HomePlan> {
    return await this.prepareHomeFrom(spec, this.launchInputs());
  }

  /** The home written from ONE read of this plugin's configuration, the same read the argv and the record are built from. */
  private async prepareHomeFrom(spec: LaunchSpec, inputs: LaunchSettingsInputs): Promise<HomePlan> {
    const home = await this.ensureHome(spec);
    // Nothing is written into a home under a folder chain another user could rewrite (v4's checked directory chain, now the
    // kernel's rule).
    await this.requirePrivateChain(home);
    // The selected skills: Skills' shared folders linked into `skills/`, the rest of that folder swept (one link rule).
    await materializeSkills(home, spec.parts, []);
    const text = homeText({
      folder: spec.folder,
      permissionMode: inputs.permissionMode,
      instructions: spec.instructions,
      parts: spec.parts,
      settings: inputs.settings as never,
      hooks: inputs.hooks as never,
      effort: spec.effort,
      fast: spec.options?.fast,
    });
    const files: FencedPath[] = [];
    const write = async (name: string, content: string): Promise<void> => {
      const path = this.fenced(home.resolve(name));
      await home.writeText(path, content);
      files.push(path);
    };
    await write(HOME_FILES.memory, text.memory);
    await write(HOME_FILES.settings, text.settings);
    await write(HOME_FILES.overlay, text.overlay);
    // MERGED into the document already there, never replaced: Claude keeps its own decisions in it (a project
    // server the person disabled among them), and a launch must not undo them (today's wrapper seed).
    const claudeJson = await this.claudeJsonText(home, text.claudeJson);
    if (claudeJson !== undefined) await write(HOME_FILES.claudeJson, claudeJson);
    if (text.mcp !== undefined) await write(HOME_FILES.mcp, text.mcp);
    return { files, args: [] };
  }

  async start(spec: LaunchSpec, runner: Runner, env: ChildEnvironment): Promise<Result<Started, StartRefusal>> {
    return await this.launch(spec, runner, env, { kind: 'new', id: this.deps.newConversationId() });
  }

  async resume(
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation: string,
  ): Promise<Result<Started, StartRefusal>> {
    return await this.launch(spec, runner, env, { kind: 'resume', id: harnessConversation });
  }

  async stop(ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void> {
    this.deps.panes.remember(ferret, handle);
    await runner.stop(handle, how);
    this.deps.panes.forget(ferret);
  }

  /** Idempotent by message id: delivering one id twice delivers it once. */
  async deliver(ferret: FerretId, handle: RunnerHandle, message: OutboundMessage): Promise<Delivery> {
    if (this.#delivered.has(message.id)) return { status: 'delivered', id: message.id };
    this.deps.panes.remember(ferret, handle);
    const text = [message.text, ...(message.attachments ?? []).map(path => `@${path}`)].join('\n');
    const typed = await this.tmux(['send-keys', '-t', handle, '-l', '--', text]);
    if (!typed.ok) return { status: 'refused', id: message.id, reason: typed.error };
    const entered = await this.tmux(['send-keys', '-t', handle, 'Enter']);
    if (!entered.ok) return { status: 'refused', id: message.id, reason: entered.error };
    this.#delivered.add(message.id);
    return { status: 'delivered', id: message.id };
  }

  readonly transcript: TranscriptReader = {
    read: async (ferret, after, limit) => {
      const entries = await this.entries(ferret);
      const from = after === undefined ? 0 : entries.findIndex(entry => entry.id === after) + 1;
      return entries.slice(from, limit === undefined ? undefined : from + limit);
    },
    readCovering: async (ferret, since) => {
      const read = await this.window(ferret);
      const first = read.entries[0];
      return {
        entries: read.entries,
        covered: !read.cut || (first !== undefined && Date.parse(first.at) <= Date.parse(since)),
      };
    },
    follow: (ferret, signal) => this.follow(ferret, signal),
    find: async (ferret, entry) => (await this.entries(ferret)).find(candidate => candidate.id === entry),
  };

  readonly usage: UsageReader = {
    turns: async (ferret, since) => {
      const text = await this.transcriptText(ferret);
      const turns: readonly TurnUsage[] = text === undefined ? [] : parseUsage(text);
      return since === undefined ? turns : turns.filter(turn => turn.at >= since);
    },
  };

  readonly dialogs: DialogReader = {
    current: async ferret => {
      const frame = await this.capture(ferret);
      if (frame === undefined) return undefined;
      const permission = parsePermissionPrompt(frame);
      if (permission !== undefined)
        return {
          id: permission.id,
          kind: 'permission',
          prompt: permission.question,
          choices: permission.options.map(option => option.label),
        } satisfies FerretDialog;
      const dialog = parseHarnessDialog(frame);
      return dialog === undefined
        ? undefined
        : ({
            id: dialog.id,
            kind: 'harness',
            prompt: dialog.title,
            choices: dialog.options.map(option => option.label),
          } satisfies FerretDialog);
    },
    answer: async (ferret, dialog, choice) => {
      const number = Number(choice);
      const current = await this.dialogs.current(ferret);
      if (current === undefined || current.id !== dialog)
        return { status: 'refused', id: dialog, reason: 'that prompt is gone, so nothing was sent' };
      const answer = Number.isInteger(number)
        ? ({ kind: 'choice', number } as const)
        : choice === 'deny' || choice === 'escape'
          ? null
          : undefined;
      if (answer === undefined) return { status: 'refused', id: dialog, reason: `${choice} is not a choice` };
      try {
        if (current.kind === 'permission') {
          const result = await this.deps.permission.answer(
            ferret,
            answer === null ? { kind: 'deny', requestId: dialog } : { ...answer, requestId: dialog },
          );
          return { status: result.cleared ? 'delivered' : 'queued', id: dialog };
        }
        const result = await this.deps.dialog.answer(
          ferret,
          answer === null ? { kind: 'escape', dialogId: dialog } : { ...answer, dialogId: dialog },
        );
        return { status: result.cleared ? 'delivered' : 'queued', id: dialog };
      } catch (error) {
        return { status: 'refused', id: dialog, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  /** Claude's own conversations on this machine, read from its documented history folder only. */
  readonly conversations: ConversationFinder = {
    list: async folder => {
      const historyHome = await this.deps.historyHome();
      if (!historyHome.startsWith('/')) return [];
      const history = this.deps.roots.root('harness-history', { subfolder: historyHome });
      const projects = history.resolve('projects');
      if (!projects.ok) return [];
      const found: FoundConversation[] = [];
      for (const directory of await history.list(projects.value).catch(() => [])) {
        const dir = history.resolve(`projects/${directory}`);
        if (!dir.ok) continue;
        for (const name of await history.list(dir.value).catch(() => [])) {
          if (!name.endsWith('.jsonl') || !isConversationId(name.slice(0, -'.jsonl'.length))) continue;
          const file = history.resolve(`projects/${directory}/${name}`);
          if (!file.ok) continue;
          const stat = await history.stat(file.value);
          if (stat === undefined) continue;
          const head = await history.readText(file.value, FIRST_RECORDS_BYTES).catch(() => '');
          const cwd = firstCwd(head);
          if (cwd === undefined || (folder !== undefined && cwd !== folder)) continue;
          found.push({ id: name.slice(0, -'.jsonl'.length), folder: cwd, updatedAt: stat.modified });
        }
      }
      return found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
  };

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────

  private async launch(
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    conversation: { readonly kind: 'new' | 'resume'; readonly id: string },
  ): Promise<Result<Started, StartRefusal>> {
    if (!isConversationId(conversation.id)) throw new Error('the conversation id must be one plain name (S45)');
    const found = await this.discover();
    if (!found.found) return err('unavailable');
    // ONE read of the configuration per launch: the home, the argv and the record all describe the same settings, so a
    // reload between them cannot leave a record that differs from what the process runs on.
    const inputs = this.launchInputs();
    await this.prepareHomeFrom(spec, inputs);
    const command = launchCommand({
      binary: found.binary,
      home: spec.home,
      permissionMode: inputs.permissionMode,
      model: spec.model,
      hasMcp: spec.parts.some(part => part.kind === 'mcp'),
      conversation,
      readable: spec.readable,
    });
    const spec2 = { ferret: spec.ferret, command, cwd: spec.folder, env };
    await this.recordLaunchSettings(spec.ferret, inputs);
    // Persist only the identity and cwd we chose, so a fresh daemon reads the same exact transcript.
    const home = this.home(spec.ferret);
    await home.writeText(
      this.fenced(home.resolve(HOME_FILES.conversation)),
      `${JSON.stringify({ format: 1, id: conversation.id, cwd: spec.folder })}\n`,
    );
    // Checked again immediately before the runner is asked: a folder made writable since the write is seen here.
    await this.requirePrivateChain(home);
    const started = await runner.start(spec2);
    if (!started.ok) return started;
    this.deps.panes.remember(spec.ferret, started.value.handle);
    return ok({ running: started.value, harnessConversation: conversation.id });
  }

  /**
   * The ferret's home, made before anything is written through it (today's `directory` operation, 0700): created or
   * narrowed by the kernel through the checked `agent-homes` folder, refused when a link or a file is at its name. The
   * scoped handle then re-proves on every read and write that no link from FY_HOME down rebases it (S42).
   */
  private async ensureHome(spec: LaunchSpec): Promise<RootHandle> {
    const home = this.home(spec.ferret);
    if (this.fenced(home.resolve('')) !== spec.home)
      throw new Error('the launch home does not match the ferret agent-homes subfolder');
    const homes = this.deps.roots.root('agent-homes');
    await homes.ensurePrivateDirectory(this.fenced(homes.resolve(spec.ferret)));
    return home;
  }

  /**
   * Refuses the launch, with the kernel's sentence, when any folder from FY_HOME down to the ferret's home is a link, is
   * owned by someone else or is writable by its group or everyone. Nothing is changed or narrowed: a check, not a lock
   * (docs/secrets.md names what that leaves).
   */
  private async requirePrivateChain(home: RootHandle): Promise<void> {
    const verdict = await home.checkPrivateChain(this.fenced(home.resolve('.')));
    if (!verdict.ok) throw new LaunchRefusal(`the ferret was not started: ${verdict.error.reason}`);
  }

  /**
   * The `.claude.json` to write, or `undefined` to leave it as it is (already seeded, or a document that cannot be
   * merged — see `mergeClaudeJson`). Read through the ferret's own home, so a link or a file the root refuses fails
   * the launch exactly as the write would; one too large to read is left as it is, like one that is not JSON.
   */
  private async claudeJsonText(home: RootHandle, fresh: string): Promise<string | undefined> {
    const path = this.fenced(home.resolve(HOME_FILES.claudeJson));
    const info = await home.stat(path);
    if (info === undefined || info.kind !== 'file') return mergeClaudeJson(undefined, fresh);
    if (info.size > MAX_CLAUDE_JSON_BYTES) return undefined;
    return mergeClaudeJson(await home.readText(path, MAX_CLAUDE_JSON_BYTES), fresh);
  }

  private home(ferret: FerretId): RootHandle {
    if (!isConversationId(ferret)) throw new Error('the ferret id must be one plain name');
    return this.deps.roots.root('agent-homes', { ferret, subfolder: ferret });
  }

  private fenced(resolved: ReturnType<RootHandle['resolve']>): FencedPath {
    if (!resolved.ok) throw new Error(`the home refused a file: ${String(resolved.error)}`);
    return resolved.value;
  }

  private async tmux(args: readonly string[]): Promise<Result<true, string>> {
    try {
      const result = await this.deps.spawn.run('tmux', args, { timeout: milliseconds(TMUX_TIMEOUT_MS) });
      return result.exitCode === 0
        ? ok(true)
        : err(result.stderr.trim() || `tmux exited ${String(result.exitCode ?? result.signal)}`);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }

  private async capture(ferret: FerretId): Promise<string | undefined> {
    try {
      const pane = this.deps.panes.require(ferret);
      const result = await this.deps.spawn.run('tmux', ['capture-pane', '-p', '-t', pane], {
        timeout: milliseconds(TMUX_TIMEOUT_MS),
      });
      return result.exitCode === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  /** One stat of the transcript this ferret's assigned conversation wrote (`Harness.transcriptStamp`). */
  async transcriptStamp(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined> {
    const found = await this.transcriptFile(ferret);
    if (found === undefined) return undefined;
    return { file: found.file, size: found.stat.size, mtimeMs: Date.parse(found.stat.modified) };
  }

  /**
   * The assigned conversation's transcript as a windowed, UNMASKED byte handle (`Harness.transcriptBytes`, G162): the
   * file `transcriptFile` proved, read in windows and re-checked for replacement on every read, with an opaque token and
   * no path. Its one consumer (Conversation's reader) masks every answer it cuts from these bytes.
   */
  async transcriptBytes(ferret: FerretId): Promise<HarnessTranscriptBytes | undefined> {
    try {
      const found = await this.transcriptFile(ferret);
      return found === undefined
        ? undefined
        : await openTranscriptBytes(found.home, found.file, 'claude', sha256Hex, { clock: this.deps.clock });
    } catch {
      // A transcript the root refuses (a link put where the file was, a fence it cannot pass) is no proved transcript:
      // none is offered, and the root's refusal is not passed on.
      return undefined;
    }
  }

  /** The newest `limit` records of that transcript, without their text (`Harness.transcriptTail`). */
  async transcriptTail(ferret: FerretId, limit: number): Promise<HarnessTranscriptTail> {
    const found = await this.transcriptFile(ferret);
    if (found === undefined) return { kind: 'unresolved' };
    const tail = await found.home.readTail(found.file, TAIL_READ_BYTES).catch(() => undefined);
    if (tail === undefined) return { kind: 'unreadable' };
    const text = new TextDecoder().decode(tail.bytes);
    const partial = tail.size > tail.bytes.length;
    // A window that reads no message, work or turn boundary whole cannot say where the turn stands: the newest record is
    // larger than it (or only bookkeeping and an unfinished line follow the cut one), which is a turn at work (never "no
    // transcript", so the pane alone cannot end it). The window is never widened: one wider parse is a synchronous slice
    // on the daemon's main thread (ruling #44).
    const records = markCutWindow(parseTail(text, partial), partial);
    return { kind: 'read', records: records.slice(-limit) };
  }

  /**
   * Whether a relaunch would run this ferret on other settings of this plugin's than its last start or resume did
   * (`Harness.launchSettings`, W2-c): the fingerprints recorded then against the ones the configuration gives now. Names
   * sections only. Total: no record, a record too large to be one, a damaged one or any failure is `unknown`, and what
   * failed is dropped unread.
   */
  async launchSettings(ferret: FerretId): Promise<HarnessLaunchSettings> {
    try {
      if (!isConversationId(ferret)) return UNKNOWN_LAUNCH;
      const size = (await this.deps.state.version(CLAUDE_CODE_LAUNCH_SETTINGS, ferret))?.size;
      if (size === undefined || size > MAX_LAUNCH_RECORD_BYTES) return UNKNOWN_LAUNCH;
      const recorded = await this.deps.state.read(CLAUDE_CODE_LAUNCH_SETTINGS, ferret);
      if (!recorded.ok || recorded.value === undefined) return UNKNOWN_LAUNCH;
      return compareLaunchSettings(recorded.value, launchSettingsRecord(this.launchInputs()));
    } catch {
      return UNKNOWN_LAUNCH;
    }
  }

  /** The settings a launch now runs under, from this plugin's own configuration (the effort is the launch's, not here). */
  private launchInputs(): LaunchSettingsInputs {
    return {
      permissionMode: this.deps.config.file(configFile)?.permissionMode ?? 'auto',
      settings: this.deps.config.collection(settingsCollection) as never,
      hooks: this.deps.config.collection(hooksCollection) as never,
    };
  }

  /**
   * Records what this launch runs under, before the process starts. A launch never fails over it: when the record
   * cannot be written, the one an earlier launch left is removed, so the answer for this process is `unknown` and
   * never an older launch's.
   */
  private async recordLaunchSettings(ferret: FerretId, inputs: LaunchSettingsInputs): Promise<void> {
    const record = launchSettingsRecord(inputs);
    try {
      await this.deps.state.write(CLAUDE_CODE_LAUNCH_SETTINGS, record, ferret);
    } catch {
      try {
        await this.deps.state.remove(CLAUDE_CODE_LAUNCH_SETTINGS, ferret);
        // A damaged record fails the write above (the kernel guard refuses to write over it) and the remove clears it:
        // write once more, so this launch is recorded and the answer is current now, not unknown until the next launch.
        await this.deps.state.write(CLAUDE_CODE_LAUNCH_SETTINGS, record, ferret).catch(() => undefined);
      } catch {
        // Nothing more can be done: the read then finds whatever is left, and a damaged record reads as unknown.
      }
    }
  }

  /** The exact transcript of the assigned id in its encoded cwd, including after a daemon restart; never one found by guessing. */
  private async transcriptFile(
    ferret: FerretId,
  ): Promise<{ readonly home: RootHandle; readonly file: FencedPath; readonly stat: RootStat } | undefined> {
    const home = this.home(ferret);
    const binding = home.resolve(HOME_FILES.conversation);
    if (!binding.ok) return undefined;
    let identity: unknown;
    try {
      identity = JSON.parse(await home.readText(binding.value, FIRST_RECORDS_BYTES));
    } catch {
      return undefined;
    }
    if (typeof identity !== 'object' || identity === null) return undefined;
    const { format, id, cwd } = identity as { format?: unknown; id?: unknown; cwd?: unknown };
    if (format !== 1 || !isConversationId(id) || typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
    const file = home.resolve(claudeTranscriptPath(cwd, id));
    if (!file.ok) return undefined;
    const stat = await home.stat(file.value);
    if (stat?.kind !== 'file') return undefined;
    return { home, file: file.value, stat };
  }

  /** Read only the assigned id in its encoded cwd, including after a daemon restart. */
  private async transcriptText(ferret: FerretId): Promise<string | undefined> {
    const found = await this.transcriptFile(ferret);
    return found === undefined ? undefined : await found.home.readText(found.file, MAX_TRANSCRIPT_BYTES);
  }

  /**
   * The NEWEST part of the transcript, up to `MAX_TRANSCRIPT_BYTES`, as entries already masked. A long conversation's
   * newest turns are the ones that matter (a delivered send, the turn in progress), so a file larger than the window is
   * read from its END, never its start. The window's first line is dropped unless the byte before it ends a record (it is
   * the end of a record whose start is outside the window); `cut` says the window does not start the file.
   */
  private async window(
    ferret: FerretId,
  ): Promise<{ readonly entries: readonly TranscriptEntry[]; readonly cut: boolean }> {
    const found = await this.transcriptFile(ferret);
    if (found === undefined) return { entries: [], cut: false };
    const start = Math.max(0, found.stat.size - MAX_TRANSCRIPT_BYTES);
    const cut = start > 0;
    // One byte BEFORE a cut window tells whether it begins on a record boundary.
    const from = cut ? start - 1 : 0;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (from + total < found.stat.size) {
      const length = Math.min(MAX_ROOT_WINDOW_BYTES, found.stat.size - from - total);
      const chunk = await found.home.readBytes(found.file, { offset: from + total, length });
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    let keep = 0;
    if (cut) {
      const newline = bytes.indexOf(0x0a);
      // No newline at all: the window is the middle of one record, and nothing in it is complete.
      keep = newline < 0 ? bytes.length : bytes[0] === 0x0a ? 1 : newline + 1;
    }
    // The same record gets the same id in a whole read and in a cut one: an id that has none of its own is its byte offset
    // IN THE FILE (`from + keep` is where these bytes begin in it), not a place within whatever window was read.
    const entries = await this.deps.redaction.read(scope =>
      parseEntries(bytes.subarray(keep), from + keep).map(entry =>
        entry.text === undefined ? entry : { ...entry, text: scope.text(entry.text) },
      ),
    );
    return { entries, cut };
  }

  /** Entries, already masked when they leave the reader. */
  private async entries(ferret: FerretId): Promise<readonly TranscriptEntry[]> {
    return (await this.window(ferret)).entries;
  }

  private async *follow(ferret: FerretId, signal: AbortSignal): AsyncIterable<TranscriptEntry> {
    const seen = new Set<string>();
    while (!signal.aborted) {
      for (const entry of await this.entries(ferret)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        yield entry;
      }
      await this.deps.clock.sleep(milliseconds(1_000), signal).catch(() => undefined);
    }
  }
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The folder Claude recorded on the first record that names one. */
function firstCwd(head: string): string | undefined {
  for (const line of head.split('\n')) {
    try {
      const record: unknown = JSON.parse(line);
      const cwd = typeof record === 'object' && record !== null ? (record as { cwd?: unknown }).cwd : undefined;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch {
      // A line cut off by the read limit, or a record that is not JSON: no folder from it.
    }
  }
  return undefined;
}
