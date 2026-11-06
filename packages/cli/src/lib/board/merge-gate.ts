import { type BoardTaskView, formatTaskRef, MAX_BOARD_PAGE, prUrlParts } from '@ferretry/protocol';
import type { IBoardGateway } from './ports';

/** `fy task merge-gate` exit codes past 0 (free): the merger reads anything but 0 as "do not merge". */
export const MERGE_GATE_WAITING = 1;
export const MERGE_GATE_UNREADABLE = 2;

/** How many board pages one gate reads before it gives up and fails closed. */
const MAX_PAGES = 40;

/** One card linking the PR that still waits on another. */
export interface MergeGateWait {
  readonly card: BoardTaskView;
  readonly blockers: readonly string[];
}

/**
 * The open cards linking this PR that still wait on another card (docs/design/clash-queue.md § The merge gate). Empty
 * when the PR may merge: no card links it, or every card linking it waits on nothing.
 */
export function mergeGateWaits(
  pr: { readonly repo: string; readonly number: number },
  cards: readonly BoardTaskView[],
) {
  const repo = pr.repo.toLowerCase();
  return cards.flatMap((card): MergeGateWait[] => {
    const links = card.links.prs.some(link => link.repo.toLowerCase() === repo && link.number === pr.number);
    if (!links || card.blockedBy.length === 0) return [];
    const blockers = card.blockedBy.map(ref => {
      const until = card.dependsOn.find(dependency => dependency.task.id === ref.id)?.until ?? 'shipped';
      return `${formatTaskRef(ref)} (until ${until})`;
    });
    return [{ card, blockers }];
  });
}

/** The words for one waiting card: `&F20 waits on &F18 (until shipped)`. */
const mergeGateLine = (wait: MergeGateWait): string =>
  `${formatTaskRef(wait.card)} waits on ${wait.blockers.join(', ')}`;

interface MergeGateIo {
  report(message: string): void;
  diagnostic(message: string): void;
  setExitCode(code: number): void;
}

export interface MergeGateDependencies {
  readonly gateway: Pick<IBoardGateway, 'board'>;
  readonly io: MergeGateIo;
}

/**
 * `fy task merge-gate <pr-url>`: whether a PR may merge as far as the board's queue goes. Exit 0 and silence when it
 * may, 1 and the waits when its card is queued behind another, 2 when the board cannot be read or the URL is not a PR
 * — the merger treats 2 like 1, so it never merges what it could not check.
 */
export class MergeGateController {
  constructor(private readonly deps: MergeGateDependencies) {}

  async check(url: string): Promise<void> {
    const pr = prUrlParts(url.trim());
    if (pr === null) return this.unreadable(`not a GitHub pull request URL: ${url}`);
    let cards: readonly BoardTaskView[];
    try {
      cards = await this.openCards();
    } catch (error) {
      return this.unreadable(`could not read the board: ${error instanceof Error ? error.message : String(error)}`);
    }
    const waits = mergeGateWaits(pr, cards);
    if (waits.length === 0) return;
    for (const wait of waits) this.deps.io.report(mergeGateLine(wait));
    this.deps.io.setExitCode(MERGE_GATE_WAITING);
  }

  /** Every open card on every board, public and private, page by page. */
  private async openCards(): Promise<readonly BoardTaskView[]> {
    const cards: BoardTaskView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.deps.gateway.board({
        state: 'open',
        visibility: 'all',
        limit: MAX_BOARD_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cards.push(...response.cards);
      if (response.nextCursor === null) return cards;
      cursor = response.nextCursor;
    }
    throw new Error(`the board is longer than ${String(MAX_PAGES)} pages`);
  }

  private unreadable(message: string): void {
    this.deps.io.diagnostic(`merge-gate: ${message}; treat it as not mergeable`);
    this.deps.io.setExitCode(MERGE_GATE_UNREADABLE);
  }
}
