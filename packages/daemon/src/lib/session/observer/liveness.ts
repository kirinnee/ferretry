import { backgroundTerminalCount } from '../../migrate/background-terminals.ts';
import type { LivenessSample } from '../../warden/liveness.ts';
import { type PaneProcess, paneWorkSummary } from '../../warden/pane-processes.ts';

/** How many transcript lines the liveness digest covers: enough that a new line always changes it. */
export const LIVENESS_TAIL_LINES = 20;

/**
 * What one liveness look found. Each part is total: what could not be read this time is left undefined
 * and is simply not evidence this time.
 */
export interface LivenessLook {
  /** The screen (not the scrollback): the work counters and background-terminal footer live on it. */
  readonly screen?: string | undefined;
  /** The last {@link LIVENESS_TAIL_LINES} lines of the transcript, as an operator reads them. */
  readonly transcript?: string | undefined;
  /**
   * Whether a TOOL COMMAND runs under the pane; `undefined` when the tree could not be observed. The
   * harness and the helpers it keeps for the whole session (`fy mcp serve`, MCP and language servers) are
   * not tool commands — see {@link lookAtPaneProcesses}.
   */
  readonly children?: boolean | undefined;
  /** Which tool command is the oldest running one, so a different command starts a new episode. */
  readonly commandKey?: string | undefined;
  /** A browser the agent launched is still running under the pane. */
  readonly leftoverBrowser?: boolean | undefined;
}

/**
 * The process part of a look, from the pane's observed process tree: `undefined` when it could not be
 * observed, which is no evidence either way.
 */
export function lookAtPaneProcesses(
  processes: readonly PaneProcess[] | undefined,
): Pick<LivenessLook, 'children' | 'commandKey' | 'leftoverBrowser'> {
  if (processes === undefined) return {};
  const work = paneWorkSummary(processes);
  return {
    children: work.toolCommand,
    ...(work.commandKey === undefined ? {} : { commandKey: work.commandKey }),
    ...(work.leftoverBrowser ? { leftoverBrowser: true } : {}),
  };
}

/**
 * A digest of what the liveness look saw: it keeps whether something changed, never the text. A port, because
 * `src/lib` may not reach a platform capability; the composition root hands in SHA-256.
 */
export type TextDigest = (text: string) => string;

/**
 * The sample the Warden's liveness fold takes, from one look. Only digests of the screen and the
 * transcript are kept; the screen itself rides along for its work counters and is then dropped.
 *
 * A tool command under the pane OR a background terminal the harness reports counts as a live
 * subprocess: the background terminals' children are not under the pane pid, so the footer is their
 * only evidence.
 */
export function livenessSampleOf(look: LivenessLook, digest: TextDigest): LivenessSample {
  const background = look.screen !== undefined && backgroundTerminalCount(look.screen) > 0;
  return {
    ...(look.screen === undefined ? {} : { pane: look.screen, paneHash: digest(look.screen) }),
    ...(look.transcript === undefined ? {} : { transcriptHash: digest(look.transcript) }),
    ...(look.children === undefined && !background ? {} : { subprocessAlive: look.children === true || background }),
    ...(look.children === true && look.commandKey !== undefined ? { subprocessKey: look.commandKey } : {}),
    ...(look.children !== undefined && look.leftoverBrowser === true ? { leftoverBrowser: true } : {}),
  };
}
