/**
 * Relaunching an existing session on CURRENT settings, and saying whether its process is on them.
 *
 * A REVIVE IS A BUILD, NEVER A REPLAY. The revive used to re-run the argv the start recorded, only
 * swapping `--session-id` for `--resume`, so everything the daemon learned to put on a launch after
 * that start — the hand-off `Read(...)` rules, a model the owner switched to — never reached the
 * replacement CLI. It now builds the argv the way a start would, from the session's own documents
 * and the fleet as it is now ({@link buildLaunchArgv}), records what it built, and only then turns
 * the create flag into a resume.
 *
 * THE SAME BUILD ANSWERS "IS THIS PROCESS STALE". A relaunch's arguments are compared with the ones
 * the process runs with — less the model, effort and harness session, which describe the run rather
 * than the settings — and the digest of the fleet settings it launched under with the digest taken
 * now. Either differing means a Restart would change something.
 *
 * A SESSION THIS CANNOT REBUILD IS LEFT TO ITS RECORD. One whose documents do not parse, or whose
 * account the fleet no longer publishes, gets no rebuilt argv: the caller replays what it recorded,
 * which is exactly what it would have done before, and the stale check claims nothing it cannot show.
 */

import type { HarnessKind } from '@ferretry/fleet';
import type { SessionConfig, SessionRelaunchDrift, SessionRelaunchSettings, SessionState } from '@ferretry/protocol';
import { type CoreAccount, canServeModel } from '../../core/inventory.ts';
import type { SessionPlanner } from '../../core/session-planner.ts';
import type { SessionId } from '../../session-id.ts';
import { relaunchCommand } from '../transcript/relaunch.ts';
import { buildLaunchArgv, settingsArguments, transcriptLaunchArguments } from './argv.ts';
import { currentLaunchEffort, currentLaunchModel } from './current.ts';

/** What a relaunch reads about one session. */
export interface LaunchSubject {
  readonly config: SessionConfig;
  readonly state: SessionState;
  /** The argv the session's process was last launched with, as its document records it. */
  readonly command: readonly string[];
}

/** A published account and the wrapper that launches it. */
export interface LaunchAccount {
  readonly account: CoreAccount;
  readonly executable: string;
}

/** What a relaunch writes back, so the document describes the process that is about to run. */
export interface RecordedLaunch {
  /** The argv in its CREATE form; a revive's resume flag is decided at launch, never stored. */
  readonly command: readonly string[];
  readonly model: string;
  readonly launchReasoningEffort?: string;
  readonly launchSettings?: string;
}

export interface SessionLaunchPorts {
  readonly subject: (id: SessionId) => Promise<LaunchSubject | undefined>;
  /** The account the fleet publishes under this name now, or nothing when it is gone. */
  readonly account: (agent: string) => Promise<LaunchAccount | undefined>;
  readonly planner: Pick<SessionPlanner, 'plan'>;
  /** The session's hand-off folders, which its `Read(...)` rules name. */
  readonly readableFolders: (id: SessionId) => readonly string[];
  /** A digest of the fleet settings this wrapper launches under now, or nothing when unreadable. */
  readonly settings: (executable: string, harness: HarnessKind) => Promise<string | undefined>;
  /** Whether the harness has written this transcript, i.e. already created its session. */
  readonly transcriptStarted: (file: string) => Promise<boolean>;
  /** The launch authorization a start applies. Throws on an argv the daemon must not run. */
  readonly authorize: (executable: string, argv: readonly string[]) => readonly string[];
  readonly record: (id: SessionId, launch: RecordedLaunch) => Promise<void>;
}

/** One rebuilt launch, before anything is written. */
interface PlannedLaunch {
  readonly argv: readonly string[];
  readonly model: string;
  readonly effort: string | undefined;
  readonly executable: string;
  readonly harness: HarnessKind;
}

/** Nothing to say: the session cannot be rebuilt, so no Restart is offered on its account. */
const UNKNOWN: SessionRelaunchSettings = { current: true, reasons: [] };

export class SessionLaunchService {
  constructor(private readonly ports: SessionLaunchPorts) {}

  /**
   * The argv a revive runs: rebuilt, recorded, then resumed. Nothing when this session cannot be
   * rebuilt, so the caller replays its record.
   */
  async relaunch(id: SessionId): Promise<readonly string[] | undefined> {
    const subject = await this.ports.subject(id);
    if (subject === undefined) return undefined;
    const planned = await this.#plan(id, subject);
    if (planned === undefined) return undefined;
    const argv = this.ports.authorize(planned.executable, planned.argv);
    const settings = await this.ports.settings(planned.executable, planned.harness);
    await this.ports.record(id, {
      command: argv,
      model: planned.model,
      ...(planned.effort === undefined ? {} : { launchReasoningEffort: planned.effort }),
      ...(settings === undefined ? {} : { launchSettings: settings }),
    });
    const transcript = subject.config.transcript?.file;
    const started = transcript !== undefined && (await this.ports.transcriptStarted(transcript));
    return relaunchCommand(argv, started);
  }

  /** Whether the session's process runs on the settings a relaunch would give it now. */
  async drift(id: SessionId): Promise<SessionRelaunchSettings> {
    const subject = await this.ports.subject(id);
    if (subject === undefined) return UNKNOWN;
    const planned = await this.#plan(id, subject);
    if (planned === undefined) return UNKNOWN;
    const reasons: SessionRelaunchDrift[] = [];
    if (JSON.stringify(settingsArguments(subject.command)) !== JSON.stringify(settingsArguments(planned.argv)))
      reasons.push('arguments');
    const recorded = subject.config.launchSettings;
    const now = await this.ports.settings(planned.executable, planned.harness);
    if (recorded !== undefined && now !== undefined && recorded !== now) reasons.push('settings');
    return { current: reasons.length === 0, reasons };
  }

  /** The argv a start would build for this session today, on the model and effort it is on now. */
  async #plan(id: SessionId, subject: LaunchSubject): Promise<PlannedLaunch | undefined> {
    const { config, state } = subject;
    const resolved = await this.ports.account(config.agent);
    // A family change under the same name is a different account, and its flags would not parse.
    if (resolved === undefined || resolved.account.kind !== config.harness) return undefined;
    const { account, executable } = resolved;
    const wanted = currentLaunchModel(config, state, model => canServeModel(account, model));
    const shape = {
      id,
      account,
      mode: config.mode,
      ...(config.teammate === undefined ? {} : { teammate: config.teammate }),
      ...(config.parent === undefined ? {} : { parent: config.parent }),
    };
    const requested = this.ports.planner.plan({
      ...shape,
      ...(wanted === undefined ? {} : { requestedModel: wanted }),
    });
    // A model the account has since stopped serving falls back to its default, as a start naming none
    // would: refusing would leave a dead pane dead over a choice nobody can make again.
    const outcome = requested.kind === 'planned' ? requested : this.ports.planner.plan(shape);
    if (outcome.kind !== 'planned') return undefined;
    const effort = currentLaunchEffort(config, state);
    return {
      argv: buildLaunchArgv({
        harness: account.kind,
        executable,
        remoteControl: config.remoteControl ? outcome.plan.extraArgs : [],
        transcript: transcriptLaunchArguments(account.kind, config.transcript, subject.command),
        readableFolders: this.ports.readableFolders(id),
        model: outcome.plan.model,
        ...(effort === undefined ? {} : { effort }),
        harnessFlags: config.harnessFlags,
      }),
      model: outcome.plan.model,
      effort,
      executable,
      harness: account.kind,
    };
  }
}
