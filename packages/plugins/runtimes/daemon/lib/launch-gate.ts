/**
 * What a runtime's login does to a Claude launch, answered to Ferrets through the hooks it offers: its compaction
 * trigger. It does NOT touch the login's environment: a project's `.claude` env wins over a login's, as it did in v4
 * before 4.291.9 (owner ruling, !A500), so nothing here pins a variable, reads a folder's settings or refuses a start
 * over one (docs/secrets.md).
 *
 * ONE checked snapshot per launch. A start, a restart, a revive, a move and an adoption all launch through Ferrets' one
 * `launchAttempt`, which is preceded by `start.decide`:
 *
 * - `start.decide` ({@link LaunchGate.decide}) judges a START's own compaction trigger against the model's window, reads
 *   the published facts ONCE (one publication read) and KEEPS the snapshot it read, keyed by the ferret.
 * - `launch.parts` ({@link LaunchGate.parts}) takes that snapshot and contributes from it: the login's compaction
 *   trigger as a `compact` part. It reads NOTHING again.
 *
 * FAIL CLOSED. Facts that cannot be read refuse the start of a Claude ferret that names a runtime. The parts source is
 * REQUIRED (`LaunchPartSource.required`): if it has no checked snapshot for a launch it throws a
 * {@link LaunchPartsRefusal}, and Ferrets refuses the launch with nothing started instead of skipping the source. A
 * runtime that is not published and a harness or ferret that names no runtime contribute nothing, deliberately.
 */
import {
  checkCompactAt,
  type LaunchPart,
  type LaunchPartSource,
  LaunchPartsRefusal,
  type StartDecideInput,
} from '@ferretry/core-ferrets/contract';
import type { HookDecision } from '@ferretry/kernel/contract';
import { FleetManifestUnreadableError } from './manifest-reading.ts';
import { launchContextWindow, type ModelWindows, resolveLaunchCompactAt } from './launch-compact-at.ts';

/** What the launch gate needs of one published runtime. */
interface RuntimeLaunchFacts {
  readonly kind: 'claude' | 'codex';
  /** Where ferrets on this account compact, in tokens, when the manifest names a number (`auto` is absent). */
  readonly compactAt?: number;
  /** The account's default model and the context window its catalog declares per model: what caps a trigger. */
  readonly windows: ModelWindows;
}

export interface RuntimeLaunchFactsSource {
  /**
   * The facts of the published runtime NAMED `runtime` (or with that id), all read inside one publication read; nothing
   * when none is published. Rejects when anything it needs is unreadable.
   */
  facts(runtime: string): Promise<RuntimeLaunchFacts | undefined>;
}

const CLAUDE_CODE = 'claude-code';

/** No window is declared anywhere: the launch falls back to v4's default for a model that states none. */
const NO_WINDOWS: ModelWindows = { models: [] };

/** What a `start.decide` checked and `launch.parts` is to use: the runtime asked for and the facts it read. */
interface CheckedLaunch {
  readonly runtime: string;
  readonly facts: RuntimeLaunchFacts | undefined;
}

export class LaunchGate {
  readonly #checked = new Map<string, CheckedLaunch>();

  constructor(private readonly deps: { readonly source: RuntimeLaunchFactsSource }) {}

  /** The `start.decide` answer: a start whose own compaction trigger its model cannot honour is refused. */
  readonly decide = async (input: StartDecideInput): Promise<HookDecision> => {
    // A decision supersedes whatever an earlier one left for this ferret: nothing checked is ever reused across launches.
    this.#checked.delete(input.ferret);
    // A START's own compaction trigger is judged against the window of the model it names, for EVERY harness (v4's
    // `checkCompactAt` on the plan's window, before anything was written). A relaunch carries none here (the later launch
    // falls back to Auto). A runtime that is not named, or not published, has no declared window: an EXPLICIT value is then
    // judged against the conservative 200k window v4 used for a model that states none (a `[1m]` selector still states 1M).
    const explicitCompactAt = input.by === 'resume' ? undefined : input.compactAt;
    if (input.runtime === undefined) {
      const refusal =
        explicitCompactAt === undefined
          ? undefined
          : checkCompactAt(explicitCompactAt, launchContextWindow(input.model, NO_WINDOWS));
      return refusal === undefined ? { allow: true } : { allow: false, reason: refusal };
    }
    if (input.harness !== CLAUDE_CODE && explicitCompactAt === undefined) return { allow: true };
    let facts: RuntimeLaunchFacts | undefined;
    try {
      facts = await this.deps.source.facts(input.runtime);
    } catch (error) {
      // A manifest the daemon is rebuilding is a moment's refusal, not a broken start: say so, so the person tries again.
      if (error instanceof FleetManifestUnreadableError)
        return {
          allow: false,
          reason: `runtime ${input.runtime} was not started: ${error.message}`,
        };
      return {
        allow: false,
        reason: `the published runtimes could not be read, so runtime ${input.runtime} was not started: its compaction trigger cannot be checked against its model`,
      };
    }
    if (explicitCompactAt !== undefined) {
      const refusal = checkCompactAt(explicitCompactAt, launchContextWindow(input.model, facts?.windows ?? NO_WINDOWS));
      if (refusal !== undefined) return { allow: false, reason: refusal };
    }
    if (input.harness !== CLAUDE_CODE) return { allow: true };
    this.#checked.set(input.ferret, { runtime: input.runtime, facts });
    return { allow: true };
  };

  /** The `launch.parts` source: the checked login's compaction trigger, from the snapshot. */
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
      // v4's `resolveCompactAt`: the ferret's own value over the login's default, and nothing the model cannot honour.
      const at = resolveLaunchCompactAt({
        own: spec.compactAt,
        accountDefault: facts.compactAt,
        window: launchContextWindow(spec.model, facts.windows),
      });
      return at === undefined ? [] : [{ kind: 'compact' as const, at }];
    },
  };
}
