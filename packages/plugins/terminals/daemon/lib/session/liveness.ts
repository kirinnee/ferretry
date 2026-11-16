/**
 * The Warden's liveness sample, from one look at a ferret's own pane (today's `lib/session/observer/liveness.ts` and
 * `lib/migrate/background-terminals.ts`, the transcript part left to its owner, Conversation).
 *
 * Pure: no IO, no clock, no globals.
 */
import type { LivenessSample } from '../../../contract/index.ts';
import { type PaneProcess, paneWorkSummary } from './processes/pane-processes.ts';

/**
 * What one look found. Each part is total: what could not be read this time is left undefined and is simply not
 * evidence this time.
 */
export interface LivenessLook {
  /** The visible screen (not the scrollback), masked: the work counters and background-terminal footer live on it. */
  readonly screen?: string | undefined;
  /**
   * Whether a TOOL COMMAND runs under the pane; `undefined` when the tree could not be observed. The harness and the
   * helpers it keeps for the whole session (`fy mcp serve`, MCP and language servers) are not tool commands.
   */
  readonly children?: boolean | undefined;
  /** Which tool command is the youngest running one, so a different command starts a new episode. */
  readonly commandKey?: string | undefined;
  /** A browser the agent launched is still running under the pane. */
  readonly leftoverBrowser?: boolean | undefined;
}

/**
 * Counts the background terminals codex reports in its pane footer. Their children are not under the pane pid and
 * carry no argv, so the process walk cannot see them at all: the count is the only evidence they exist.
 */
export function backgroundTerminalCount(pane: string): number {
  const match = pane.toLowerCase().match(/(\d+)\s+background\s+terminals?\s+running/u);
  return match ? Number(match[1]) : 0;
}

/** The process part of a look: `undefined` when the tree could not be observed, which is no evidence either way. */
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

/** A digest of what the look saw: it keeps whether something changed, never the text. */
export type TextDigest = (text: string) => string;

/**
 * The sample the Warden's liveness fold takes. Only a digest of the screen is kept; the masked screen itself rides
 * along for its work counters. A tool command under the pane OR a background terminal the harness reports counts as
 * a live subprocess: the background terminals' children are not under the pane pid, so the footer is their only
 * evidence.
 */
export function livenessSampleOf(look: LivenessLook, digest: TextDigest): LivenessSample {
  const background = look.screen !== undefined && backgroundTerminalCount(look.screen) > 0;
  return {
    ...(look.screen === undefined ? {} : { pane: look.screen, paneHash: digest(look.screen) }),
    ...(look.children === undefined && !background ? {} : { subprocessAlive: look.children === true || background }),
    ...(look.children === true && look.commandKey !== undefined ? { subprocessKey: look.commandKey } : {}),
    ...(look.children !== undefined && look.leftoverBrowser === true ? { leftoverBrowser: true } : {}),
  };
}
