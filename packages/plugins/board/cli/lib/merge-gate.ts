import { type BoardMergeGateResponse, formatCardRef, prUrlParts } from '../../contract/index.ts';

/** `fy card merge-gate` exit codes past 0 (free): the merger reads anything but 0 as "do not merge". */
export const MERGE_GATE_WAITING = 1;
export const MERGE_GATE_UNREADABLE = 2;

export interface MergeGateIo {
  report(message: string): void;
  diagnostic(message: string): void;
}

/** The words for what a PR still waits on, one line per card of its merge unit: `&F20 waits on &F18 (until shipped)`. */
export function mergeGateLines(answer: Pick<BoardMergeGateResponse, 'waits'>): readonly string[] {
  const byCard = new Map<string, string[]>();
  for (const wait of answer.waits) {
    const card = formatCardRef(wait.card);
    byCard.set(card, [...(byCard.get(card) ?? []), `${formatCardRef(wait.on)} (until ${wait.until})`]);
  }
  return [...byCard].map(([card, blockers]) => `${card} waits on ${blockers.join(', ')}`);
}

/**
 * `fy card merge-gate <pr-url>`: whether a PR may merge as far as the board's queue goes. Exit 0 and silence when it
 * may, 1 and the waits when a card it ships waits on another, 2 when the board cannot be read (the daemon is down, a
 * card is unreadable, the URL is not a PR). The merger treats 2 like 1, so it never merges what it could not check.
 */
export async function checkMergeGate(
  read: (pr: string) => Promise<BoardMergeGateResponse>,
  io: MergeGateIo,
  url: string,
): Promise<number> {
  const unreadable = (message: string): number => {
    io.diagnostic(`merge-gate: ${message}; treat it as not mergeable`);
    return MERGE_GATE_UNREADABLE;
  };
  const pr = url.trim();
  if (prUrlParts(pr) === null) return unreadable(`not a GitHub pull request URL: ${url}`);
  let answer: BoardMergeGateResponse;
  try {
    answer = await read(pr);
  } catch (error) {
    return unreadable(`could not read the board: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (answer.unreadable.length > 0) {
    return unreadable(
      `the board has cards it cannot read (${answer.unreadable.map(id => formatCardRef({ id })).join(', ')}), and any of them might link this PR`,
    );
  }
  const lines = mergeGateLines(answer);
  if (lines.length === 0) return 0;
  for (const line of lines) io.report(line);
  return MERGE_GATE_WAITING;
}
