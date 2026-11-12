/**
 * What a runtime's login does to a Claude launch, answered to Ferrets through the hooks it offers (#1587).
 *
 * ONE checked snapshot per launch. A start, a restart, a revive, a move and an adoption all launch through Ferrets' one
 * `launchAttempt`, which is preceded by `start.decide`:
 *
 * - `start.decide` ({@link LaunchGate.decide}) reads the published facts ONCE (one publication read: the manifest and
 *   the login's fixed settings are the same committed generation), refuses a folder whose own Claude settings set a
 *   variable the login leaves to the process environment (naming the file and the key, before anything is written),
 *   and KEEPS the snapshot it checked, keyed by the ferret.
 * - `launch.parts` ({@link LaunchGate.parts}) takes that snapshot and contributes from it: the login's LITERAL
 *   environment as a `pin` part (the Claude harness writes it into its private `--settings` file, which outranks a
 *   folder's own `env`) and the login's compaction trigger as a `compact` part. It reads NOTHING again, so the pins
 *   written are the ones the folder was judged against, and a file that changes or breaks after the decision cannot
 *   turn into a launch without them.
 *
 * FAIL CLOSED. Facts that cannot be read refuse the start of a ferret that names a runtime, because a login nobody could
 * read could be the one a folder blanks. The parts source is REQUIRED (`LaunchPartSource.required`): if it has no checked
 * snapshot for a launch it throws a {@link LaunchPartsRefusal}, and Ferrets refuses the launch with nothing started
 * instead of skipping the source. A runtime that is not published (nothing to protect) and a harness or ferret that
 * names no runtime contribute nothing, deliberately.
 */
import {
  type LaunchPart,
  type LaunchPartSource,
  LaunchPartsRefusal,
  type StartDecideInput,
} from '@ferretry/core-ferrets/contract';
import type { HookDecision } from '@ferretry/kernel/contract';
import {
  assertFolderLeavesLoginAlone,
  FolderSettingsOverrideError,
  FolderSettingsUnreadableError,
  type FolderSettingsVariables,
} from './folder-settings.ts';

/** What the launch gate needs of one published runtime. NAMES and the pinned LITERALS; never a secret's value. */
interface RuntimeLaunchFacts {
  readonly runtime: string;
  readonly kind: 'claude' | 'codex';
  /** The variables that name a secret (the manifest's `secretEnv` keys). */
  readonly secretEnvNames: readonly string[];
  /** The variables that are a bare `$OTHER` reference (the manifest's `referencedEnv`). */
  readonly referencedEnv: readonly string[];
  /** The login's literal environment as published in its `fixed.json`: what a Claude launch pins. */
  readonly pins: Readonly<Record<string, string>>;
  /** Where ferrets on this account compact, in tokens, when the manifest names a number (`auto` is absent). */
  readonly compactAt?: number;
}

export interface RuntimeLaunchFactsSource {
  /**
   * The facts of the published runtime NAMED `runtime` (or with that id), ALL read inside one publication read; nothing
   * when none is published. Rejects when anything it needs is unreadable. A fixed-settings file that is absent is a
   * login that pins nothing: under the publication read, an apply cannot be half-way through removing it.
   */
  facts(runtime: string): Promise<RuntimeLaunchFacts | undefined>;
}

const CLAUDE_CODE = 'claude-code';

/** What a `start.decide` checked and `launch.parts` is to use: the runtime asked for and the facts it was judged on. */
interface CheckedLaunch {
  readonly runtime: string;
  readonly facts: RuntimeLaunchFacts | undefined;
}

export class LaunchGate {
  readonly #checked = new Map<string, CheckedLaunch>();

  constructor(
    private readonly deps: {
      readonly source: RuntimeLaunchFactsSource;
      readonly folderSettings: FolderSettingsVariables;
    },
  ) {}

  /** The `start.decide` answer: a Claude start whose folder would blank the runtime's login is refused. */
  readonly decide = async (input: StartDecideInput): Promise<HookDecision> => {
    // A decision supersedes whatever an earlier one left for this ferret: nothing checked is ever reused across launches.
    this.#checked.delete(input.ferret);
    if (input.harness !== CLAUDE_CODE || input.runtime === undefined) return { allow: true };
    let facts: RuntimeLaunchFacts | undefined;
    try {
      facts = await this.deps.source.facts(input.runtime);
    } catch {
      return {
        allow: false,
        reason: `the published runtimes could not be read, so runtime ${input.runtime} was not started: its folder's Claude settings cannot be checked against its login`,
      };
    }
    if (facts !== undefined) {
      try {
        await assertFolderLeavesLoginAlone({
          account: {
            runtime: facts.runtime,
            kind: facts.kind,
            secretEnvNames: facts.secretEnvNames,
            referencedEnv: facts.referencedEnv,
          },
          cwd: input.folder,
          folderSettings: this.deps.folderSettings,
        });
      } catch (error) {
        if (error instanceof FolderSettingsOverrideError || error instanceof FolderSettingsUnreadableError)
          return { allow: false, reason: error.message };
        throw error;
      }
    }
    this.#checked.set(input.ferret, { runtime: input.runtime, facts });
    return { allow: true };
  };

  /** The `launch.parts` source: the checked login's pinned environment and compaction trigger, from the snapshot. */
  readonly parts: LaunchPartSource = {
    required: true,
    parts: async (spec): Promise<readonly LaunchPart[]> => {
      if (spec.harness !== CLAUDE_CODE || spec.runtime === undefined) return [];
      const checked = this.#checked.get(spec.ferret);
      this.#checked.delete(spec.ferret);
      if (checked === undefined || checked.runtime !== spec.runtime)
        throw new LaunchPartsRefusal(
          `the login settings of runtime ${spec.runtime} were not checked for this launch, so the ferret was not started`,
        );
      const facts = checked.facts;
      if (facts === undefined || facts.kind !== 'claude') return [];
      return [
        ...(Object.keys(facts.pins).length === 0 ? [] : [{ kind: 'pin' as const, env: facts.pins }]),
        ...(facts.compactAt === undefined ? [] : [{ kind: 'compact' as const, at: facts.compactAt }]),
      ];
    },
  };
}
