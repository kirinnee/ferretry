/**
 * "Default runtime for new agents" across a Clone (docs/design/account-model.md §4.7).
 *
 * The default must name an agent runtime on the machine it is set on, and a copy changes which runtimes
 * a machine has: Replace removes the target's own, so a default that named one of them would dangle and
 * the target could no longer read its configuration. The copy therefore decides the default instead of
 * leaving it to chance — and says which, so the Preview can show it as a choice the owner can change.
 *
 * ONE OWNER, TWO READERS. The app's Preview and the target's planner both read {@link suggestCloneDefault}
 * and {@link cloneAgentRuntimes}, so the runtime the screen proposes is the one the copy would pick.
 *
 * Pure and total: the bundle is the source machine's data, so every field is read as `unknown`.
 */
import type { FleetCloneBundle } from './fleet-setup.ts';

/** The runtime a first run gives the first Claude Code it imports; the one name tried before any other. */
export const CLONE_FALLBACK_RUNTIME = 'claude-default';

/** An agent runtime the copy brings, under the name the SOURCE gave it. */
export interface CloneAgentRuntime {
  readonly name: string;
  readonly harness: 'claude' | 'codex';
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The agent runtimes in a bundle, by the source's name, sorted. Only an agent runtime can be the default.
 * A runtime's harness is its own `harness`, else the one its login drives.
 */
export function cloneAgentRuntimes(bundle: FleetCloneBundle): readonly CloneAgentRuntime[] {
  const harnesses = new Map(bundle.credentials.map(credential => [credential.id, credential.harness]));
  return Object.entries(bundle.runtimes)
    .flatMap(([name, value]): CloneAgentRuntime[] => {
      const runtime = recordOf(value);
      if (runtime.agent !== true) return [];
      const own = runtime.harness === 'claude' || runtime.harness === 'codex' ? runtime.harness : undefined;
      const login = typeof runtime.credential === 'string' ? harnesses.get(runtime.credential) : undefined;
      const harness = own ?? login;
      return harness === undefined ? [] : [{ name, harness }];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface CloneDefaultSuggestion {
  /** The agent runtimes the copy brings. */
  readonly candidates: readonly CloneAgentRuntime[];
  /** The source machine's own default, when the person is copying it along. */
  readonly carried?: string | null | undefined;
  /** The family of the default this copy removes, so the replacement runs the same CLI where it can. */
  readonly droppedHarness?: 'claude' | 'codex' | undefined;
}

/**
 * The runtime new agents should start on after a copy, by the source's name, or `undefined` when the copy
 * brings no agent runtime. In order: the source's own default when it is copied; `claude-default`; a
 * runtime of the same family as the default being replaced; the first by name.
 */
export function suggestCloneDefault({
  candidates,
  carried,
  droppedHarness,
}: CloneDefaultSuggestion): string | undefined {
  const named = (name: string | null | undefined): string | undefined =>
    name === undefined || name === null ? undefined : candidates.find(candidate => candidate.name === name)?.name;
  return (
    named(carried) ??
    named(CLONE_FALLBACK_RUNTIME) ??
    candidates.find(candidate => candidate.harness === droppedHarness)?.name ??
    candidates[0]?.name
  );
}
