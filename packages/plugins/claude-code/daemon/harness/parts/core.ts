import type { Harness } from '@ferretry/core-ferrets/contract';
import type {
  FencedPath,
  FerretId,
  Clock,
  ConfigPort,
  Redaction,
  RootHandle,
  RootsPort,
  SpawnPort,
  StatePort,
} from '@ferretry/kernel/contract';
import type { SelectedComponents } from '@ferretry/plugin-runtimes/contract';
import type { PaneDirectory } from '../../adapters/tmux-pane.ts';
import type { DialogAnswerService } from '../../lib/dialog/service.ts';
import { isConversationId } from '../../lib/harness/claude-path.ts';
import type { PermissionAnswerService } from '../../lib/permission/service.ts';
import type { LocationSource, Probe } from '../../lib/update/ports.ts';
import type { HarnessUpdateSubsystem } from '../../lib/update/service.ts';

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
  /**
   * The settings and hooks components the launching runtime's profile selects (`selectedComponents`): only those items
   * reach its home, as v4's profile resolution gave `adaptProfile` only the resolved profile's. No runtime selects none.
   */
  readonly selected: (runtime: string | undefined) => Promise<SelectedComponents>;
  /** A fresh conversation id: Claude takes `--session-id`, so the daemon assigns it. */
  readonly newConversationId: () => string;
  /** The user's documented Claude history home; only its projects subtree is read. */
  readonly historyHome: () => Promise<string>;
  /** The `fy` the Ferretry tools server runs as when a ferret gets the channel (default `fy`, found on the ferret's PATH). */
  readonly fyCommand?: string;
  /**
   * Where a link really leads (its fully resolved path), or `undefined` when it leads nowhere. The kernel's roots refuse to
   * follow a link, so this is the one question about a home's `projects` link they cannot answer. Default: `readlink -f` through the spawn port.
   */
  readonly resolveLink?: (path: string) => Promise<string | undefined>;
  /** Says one plain sentence in the daemon log (a pooling that was skipped, a file kept aside); absent: nothing is said. */
  readonly warn?: (message: string) => void;
}

/**
 * What every part of the Claude harness is built from: the plugin's wiring and the one piece of state the harness holds
 * (the message ids already typed into a pane). A part reads it; nothing else is shared between parts but the helpers a
 * part exports for another to import.
 */
export interface ClaudeCore {
  readonly deps: ClaudeHarnessDeps;
  readonly delivered: Set<string>;
}

export const TMUX_TIMEOUT_MS = 5_000;
export const FIRST_RECORDS_BYTES = 16 * 1024;

/** The ferret's home handle, through this plugin's own `agent-homes` root. */
export function claudeHome(core: ClaudeCore, ferret: FerretId): RootHandle {
  if (!isConversationId(ferret)) throw new Error('the ferret id must be one plain name');
  return core.deps.roots.root('agent-homes', { ferret, subfolder: ferret });
}

export function fenced(resolved: ReturnType<RootHandle['resolve']>): FencedPath {
  if (!resolved.ok) throw new Error(`the home refused a file: ${String(resolved.error)}`);
  return resolved.value;
}

/** One part's share of `Harness`: the members it serves, every one of them present. */
export type Serves<K extends keyof Harness> = Required<Pick<Harness, K>>;
