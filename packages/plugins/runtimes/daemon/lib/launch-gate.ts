/**
 * What a runtime's login does to a Claude launch, answered to Ferrets through the hooks it offers (#1587).
 *
 * Two answers, both read from the SAME published facts ({@link RuntimeLaunchFactsSource}) so they cannot disagree:
 *
 * - `start.decide` ({@link launchStartDecision}): a start, a restart, a revive, a move and an adoption all launch
 *   through Ferrets' one `launchAttempt`, which asks `start.decide` first. A folder whose own Claude settings set a
 *   variable the login leaves to the process environment is refused there, naming the file and the key, before
 *   anything is written (the refusal itself is {@link assertFolderLeavesLoginAlone}).
 * - `launch.parts` ({@link launchPinParts}): the login's LITERAL environment, as a `pin` part the Claude harness writes
 *   into its private `--settings` file, which outranks a folder's own `env`.
 *
 * FAIL CLOSED where it can refuse: published facts that cannot be read refuse the start of a ferret that names a
 * runtime, because a login nobody could read could be the one a folder blanks. A `launch.parts` source cannot refuse
 * (Ferrets drops a failing source), which is why the decision above reads first and fails the start.
 */
import type { LaunchPart, LaunchPartSource, StartDecideInput } from '@ferretry/core-ferrets/contract';
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
}

export interface RuntimeLaunchFactsSource {
  /** The facts of the published runtime NAMED `runtime` (or with that id); nothing when none is published. Rejects when unreadable. */
  facts(runtime: string): Promise<RuntimeLaunchFacts | undefined>;
}

const CLAUDE_CODE = 'claude-code';

/** The `start.decide` answer: a Claude start whose folder would blank the runtime's login is refused. */
export function launchStartDecision(deps: {
  readonly source: RuntimeLaunchFactsSource;
  readonly folderSettings: FolderSettingsVariables;
}): (input: StartDecideInput) => Promise<HookDecision> {
  return async input => {
    if (input.harness !== CLAUDE_CODE || input.runtime === undefined) return { allow: true };
    let facts: RuntimeLaunchFacts | undefined;
    try {
      facts = await deps.source.facts(input.runtime);
    } catch {
      return {
        allow: false,
        reason: `the published runtimes could not be read, so runtime ${input.runtime} was not started: its folder's Claude settings cannot be checked against its login`,
      };
    }
    if (facts === undefined) return { allow: true };
    try {
      await assertFolderLeavesLoginAlone({
        account: {
          runtime: facts.runtime,
          kind: facts.kind,
          secretEnvNames: facts.secretEnvNames,
          referencedEnv: facts.referencedEnv,
        },
        cwd: input.folder,
        folderSettings: deps.folderSettings,
      });
    } catch (error) {
      if (error instanceof FolderSettingsOverrideError || error instanceof FolderSettingsUnreadableError)
        return { allow: false, reason: error.message };
      throw error;
    }
    return { allow: true };
  };
}

/** The `launch.parts` source: the login's literal environment, pinned for a Claude launch. */
export function launchPinParts(source: RuntimeLaunchFactsSource): LaunchPartSource {
  return {
    parts: async (spec): Promise<readonly LaunchPart[]> => {
      if (spec.harness !== CLAUDE_CODE || spec.runtime === undefined) return [];
      const facts = await source.facts(spec.runtime);
      if (facts === undefined || facts.kind !== 'claude' || Object.keys(facts.pins).length === 0) return [];
      return [{ kind: 'pin', env: facts.pins }];
    },
  };
}
