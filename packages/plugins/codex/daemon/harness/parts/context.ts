/**
 * What every part of the Codex harness shares: the options it was built from and the few helpers more than one part
 * needs (the ferret's home, the settings now, the shared history pool). It holds no member of `Harness`: a member lives
 * in exactly one part, and `index.ts` composes the parts.
 */
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import type { Harness, HarnessRuntimeSwitch, LaunchSpec, RuntimeSwitchPane } from '@ferretry/core-ferrets/contract';
import { LaunchRefusal, poolHomeHistory } from '@ferretry/core-ferrets/contract';
import type { SelectedComponents } from '@ferretry/plugin-runtimes/contract';
import type { CodexCredentialLinks } from '../../lib/index.ts';
import {
  CODEX_HISTORY_ENTRIES,
  CODEX_HOOKS,
  CODEX_POOL_SQLITE,
  CODEX_SETTINGS,
  type HarnessConfig,
  type HooksItem,
  type SettingsItem,
} from '../../../contract/index.ts';
import { CodexRollouts } from '../../adapters/rollouts.ts';
import type { HarnessLocation, HarnessProbe, HarnessUpdateSubsystem } from '../../lib/update/index.ts';

export interface CodexHarnessOptions {
  readonly kernel: Pick<KernelPorts, 'roots' | 'log' | 'clock' | 'redaction' | 'state'> &
    Partial<{
      readonly config: Pick<KernelPorts['config'], 'collection'>;
      /** Runs `codex queue` for `inject`; a composition without it hands nothing (every message is typed). */
      readonly spawn: Pick<KernelPorts['spawn'], 'run'>;
    }>;
  readonly permissionMode?: () => HarnessConfig['permissionMode'];
  /**
   * The settings components the launching runtime's profile selects (`selectedComponents`): only those items reach its
   * home, as v4's profile resolution gave `adaptProfile` only the resolved profile's. No runtime selects none.
   */
  readonly selected: (runtime: string | undefined) => Promise<SelectedComponents>;
  readonly historyDirectory?: () => Promise<string | undefined>;
  /** Whether the owner's own `~/.codex` history is offered to the conversation index (config `hostHistory`, default true). */
  readonly hostHistory?: () => boolean;
  /** The owner's own Codex home (`~/.codex`), which holds `sessions` and `session_index.jsonl`; the conversation index reads it in place. */
  readonly historyHome?: () => Promise<string | undefined>;
  readonly locate: () => Promise<HarnessLocation>;
  readonly probe: HarnessProbe;
  readonly update: HarnessUpdateSubsystem & { settled(): Promise<void> };
  /** Changing a running ferret's model, effort or fast mode (`Harness.runtimeSwitch`); absent: it cannot be switched live. */
  readonly runtimeSwitch?: (pane: RuntimeSwitchPane) => HarnessRuntimeSwitch;
}

export type CodexHarness = Harness & { readonly credentials: CodexCredentialLinks };

/** A ferret id is one plain name before it names a folder (the S45 grammar Claude Code's home uses too). */
export const PLAIN_FERRET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** The helpers shared by the parts; built once per harness by `harnessContext`. */
export interface HarnessContext {
  readonly options: CodexHarnessOptions;
  readonly kernel: CodexHarnessOptions['kernel'];
  readonly locate: CodexHarnessOptions['locate'];
  readonly probe: CodexHarnessOptions['probe'];
  readonly update: CodexHarnessOptions['update'];
  /** The login each ferret's link was made from, as this daemon placed it (empty after a restart; a stop still clears). */
  readonly linked: Map<string, string | undefined>;
  readonly permissionModeNow: () => HarnessConfig['permissionMode'];
  /** The settings items (`config/codex/settings/`) the runtime's profile selects, now: what a home written now would merge. */
  readonly settingsNow: (runtime: string | undefined) => Promise<ReadonlyMap<string, SettingsItem>>;
  /**
   * The hooks items (`config/codex/hooks/`) the runtime's profile selects, now, in the profile's layer order (the order
   * Runtimes merges their handlers into its `hooks.json`, so a reorder is a change): what it would render.
   */
  readonly hooksNow: (runtime: string | undefined) => Promise<readonly (readonly [string, HooksItem])[]>;
  readonly rollouts: CodexRollouts;
  readonly say: (message: string) => void;
  readonly homeRoot: (ferret: FerretId) => RootHandle;
  readonly homeOf: (ferret: FerretId) => FencedPath;
  readonly ensureHome: (spec: LaunchSpec) => Promise<RootHandle>;
  readonly poolHistory: (ferret: FerretId) => Promise<string | undefined>;
}

/** One part of the harness: the members it owns, built from the shared context. */
export type HarnessPart<Members extends keyof CodexHarness> = (context: HarnessContext) => Pick<CodexHarness, Members>;

export function harnessContext(options: CodexHarnessOptions): HarnessContext {
  const { kernel, locate, probe, update } = options;
  const linked = new Map<string, string | undefined>();
  const permissionModeNow = (): HarnessConfig['permissionMode'] => options.permissionMode?.() ?? 'skip';
  const settingsNow = async (runtime: string | undefined): Promise<ReadonlyMap<string, SettingsItem>> => {
    const all =
      (kernel.config?.collection(CODEX_SETTINGS as never) as ReadonlyMap<string, SettingsItem> | undefined) ??
      new Map();
    const { settings } = await options.selected(runtime);
    return new Map([...all].filter(([name]) => settings.has(name)));
  };
  const hooksNow = async (runtime: string | undefined): Promise<readonly (readonly [string, HooksItem])[]> => {
    const all =
      (kernel.config?.collection(CODEX_HOOKS as never) as ReadonlyMap<string, HooksItem> | undefined) ?? new Map();
    const { hooks } = await options.selected(runtime);
    // The selected set keeps the profile's layer order; the collection's own order is not the order they merge in.
    return [...hooks].flatMap(name => {
      const item = all.get(name);
      return item === undefined ? [] : [[name, item] as const];
    });
  };
  const rollouts = new CodexRollouts(kernel, options.historyDirectory ?? (async () => undefined));

  /**
   * The shared history pool for this ferret's home (docs/design/shared-history.md): each history entry becomes a link to
   * the plugin's one pool, an entry that was a real folder is moved in first, and the answer is the pool's `sqlite` folder
   * (Codex's database of conversations, `CODEX_SQLITE_HOME`) when `sessions` is pooled too. Never a reason to refuse a
   * launch when no leaf moved: the original history is used with one sentence. An interrupted merge refuses until retried.
   */
  /** Pooling is a convenience: saying so in the log can never fail a launch. */
  const say = (message: string): void => {
    try {
      kernel.log.warn(message);
    } catch {
      /* a composition without a log says nothing */
    }
  };
  const poolHistory = async (ferret: FerretId): Promise<string | undefined> => {
    const pooled = await poolHomeHistory({ roots: kernel.roots, ferret, entries: CODEX_HISTORY_ENTRIES });
    if (pooled.conflicts.length > 0)
      say(
        `Ferret ${ferret}: ${pooled.conflicts.length} file(s) it already had were kept in the pool's .conflicts folder because the shared pool already held a file of that name.`,
      );
    if (pooled.sentence !== undefined) say(pooled.sentence);
    // The database indexes the rollouts: shared only with the rollouts it indexes.
    if (!pooled.linked.includes('sessions')) return undefined;
    try {
      const pool = kernel.roots.historyPool();
      const sqlite = pool.resolve(CODEX_POOL_SQLITE);
      if (!sqlite.ok) throw new Error('the shared database path could not be placed');
      await pool.makeDirectory(sqlite.value, { mode: 0o700 });
      return sqlite.value;
    } catch {
      throw new LaunchRefusal(
        'The shared Codex history database could not be prepared, so this ferret was not started; start it again to retry.',
      );
    }
  };

  /** The ferret's own home handle: `state/codex/agent-homes/<ferret>` through this plugin's own root. */
  const homeRoot = (ferret: FerretId) => {
    if (!PLAIN_FERRET.test(ferret)) throw new Error('the ferret id must be one plain name');
    return kernel.roots.root('agent-homes', { ferret, subfolder: ferret });
  };
  const homeOf = (ferret: FerretId): FencedPath => {
    const home = homeRoot(ferret).resolve('');
    if (!home.ok) throw new Error(`the ferret's Codex home could not be placed: ${home.error}`);
    return home.value;
  };
  /**
   * The ferret's home, made before anything is written through it or Codex is launched in it (as Claude Code does):
   * refused unless `spec.home` is exactly this plugin's home for the ferret, then created or narrowed to 0700 by the
   * kernel through the checked `agent-homes` folder, refused when a link or a file is at its name (S42).
   */
  const ensureHome = async (spec: LaunchSpec) => {
    const home = homeRoot(spec.ferret);
    if (homeOf(spec.ferret) !== spec.home) throw new Error("the launch home is not this ferret's Codex home");
    const homes = kernel.roots.root('agent-homes');
    const folder = homes.resolve(spec.ferret);
    if (!folder.ok) throw new Error(`the ferret's Codex home could not be placed: ${folder.error}`);
    await homes.ensurePrivateDirectory(folder.value);
    return home;
  };

  return {
    options,
    kernel,
    locate,
    probe,
    update,
    linked,
    permissionModeNow,
    settingsNow,
    hooksNow,
    rollouts,
    say,
    homeRoot,
    homeOf,
    ensureHome,
    poolHistory,
  };
}
