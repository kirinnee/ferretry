import { type BoardMergeGateResponse, formatTaskRef, prUrlParts } from '@ferretry/protocol';

/** `fy task merge-gate` exit codes past 0 (free): the merger reads anything but 0 as "do not merge". */
export const MERGE_GATE_WAITING = 1;
export const MERGE_GATE_UNREADABLE = 2;

/** The daemon's answer for one PR, decided from one read of the board (docs/design/clash-queue.md § The merge gate). */
export interface IMergeGateGateway {
  mergeGate(pr: string): Promise<BoardMergeGateResponse>;
}

interface MergeGateIo {
  report(message: string): void;
  diagnostic(message: string): void;
  setExitCode(code: number): void;
}

export interface MergeGateDependencies {
  readonly gateway: IMergeGateGateway;
  readonly io: MergeGateIo;
}

/** The words for what a PR still waits on, one line per card of its merge unit: `&F20 waits on &F18 (until shipped)`. */
export function mergeGateLines(answer: Pick<BoardMergeGateResponse, 'waits'>): readonly string[] {
  const byCard = new Map<string, string[]>();
  for (const wait of answer.waits) {
    const card = formatTaskRef(wait.task);
    byCard.set(card, [...(byCard.get(card) ?? []), `${formatTaskRef(wait.on)} (until ${wait.until})`]);
  }
  return [...byCard].map(([card, blockers]) => `${card} waits on ${blockers.join(', ')}`);
}

/**
 * `fy task merge-gate <pr-url>`: whether a PR may merge as far as the board's queue goes. Exit 0 and silence when it
 * may, 1 and the waits when a card it ships waits on another, 2 when the board cannot be read (the daemon is down or
 * predates the gate, a card is unreadable, the URL is not a PR) — the merger treats 2 like 1, so it never merges what
 * it could not check.
 */
export class MergeGateController {
  constructor(private readonly deps: MergeGateDependencies) {}

  async check(url: string): Promise<void> {
    const pr = url.trim();
    if (prUrlParts(pr) === null) return this.unreadable(`not a GitHub pull request URL: ${url}`);
    let answer: BoardMergeGateResponse;
    try {
      answer = await this.deps.gateway.mergeGate(pr);
    } catch (error) {
      return this.unreadable(`could not read the board: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answer.unreadable.length > 0) {
      return this.unreadable(
        `the board has cards it cannot read (${answer.unreadable.map(id => formatTaskRef({ id })).join(', ')}), and any of them might link this PR`,
      );
    }
    const lines = mergeGateLines(answer);
    if (lines.length === 0) return;
    for (const line of lines) this.deps.io.report(line);
    this.deps.io.setExitCode(MERGE_GATE_WAITING);
  }

  private unreadable(message: string): void {
    this.deps.io.diagnostic(`merge-gate: ${message}; treat it as not mergeable`);
    this.deps.io.setExitCode(MERGE_GATE_UNREADABLE);
  }
}
