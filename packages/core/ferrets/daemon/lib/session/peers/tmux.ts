/**
 * PEER: today's `daemon/src/lib/tmux/contracts.ts`, `control-protocol.ts`, `pane.ts`, `permission-prompt.ts` and
 * `harness-dialog.ts` — owned by the terminals plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The pane and command-port types and `parsePaneWatch` are copied verbatim; the pane parsers are an interface the
 * host supplies ({@link PaneParsers}).
 */
import type { HarnessDialog } from '../../protocol/session-dialog.ts';
import type { PermissionRequest } from '../../protocol/session-permission.ts';

/** The narrow process seam required by the tmux domain. */
export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Implemented by the process adapter; every command excludes the executable and socket flags. */
export interface TmuxCommandPort {
  /**
   * Run one tmux command.
   *
   * `stdin` exists for `load-buffer -`: a turn brief is longer than any argv limit and would be
   * world-readable through `/proc` if it were passed as an argument. A command whose ARGUMENTS carry a
   * payload — a pane's environment, typed keys — is moved onto stdin by the adapter itself
   * (`script.ts`), so callers keep passing ordinary argv.
   */
  execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult>;
}

export interface PaneMetadata {
  readonly dead: boolean;
  readonly exitCode?: number;
  readonly cursorX?: number;
  readonly cursorY?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface PaneState extends PaneMetadata {
  readonly alive: boolean;
  readonly promptReady: boolean;
  readonly history: string;
  readonly visible: string;
}

export function parsePaneWatch(value: string): { readonly dead: boolean; readonly activityAt: number } | undefined {
  const match = /^([01]) (\d+)$/u.exec(value.trim());
  return match === null ? undefined : { dead: match[1] === '1', activityAt: Number(match[2]) };
}

/**
 * The terminals plugin's pane parsers the session observer reads a frame through (today's free functions in
 * `tmux/pane.ts`, `tmux/permission-prompt.ts` and `tmux/harness-dialog.ts`).
 */
export interface PaneParsers {
  parsePermissionPrompt(pane: string): PermissionRequest | undefined;
  paneActiveWork(pane: string): 'status' | 'spinner' | undefined;
  paneShowsPermissionPrompt(pane: string): boolean;
  paneBlockingPrompt(pane: string): string | undefined;
  /** Whether the pane shows an IDLE composer, whatever the box holds (a draft included): no work, dialog or permission prompt. */
  idlePromptShown(pane: string): boolean;
  parseHarnessDialog(pane: string): HarnessDialog | undefined;
}
