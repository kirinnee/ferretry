import { definePort } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { CardId } from './refs.ts';
import type {
  BoardQuery,
  BoardSwitch,
  Card,
  CardActionRequest,
  CardCreateRequest,
  CardView,
  Progress,
} from './wire.ts';
import type { LaneSet } from './lanes.ts';

export interface BoardRefusal {
  readonly code: 'invalid' | 'not-found' | 'forbidden' | 'board-off' | 'owner-only' | 'refused';
  readonly message: string;
}

/** One page of cards and where the next one starts: `nextCursor` is `null` on the last page. */
export interface CardPage {
  readonly cards: readonly CardView[];
  readonly nextCursor: string | null;
}

/** Every open orphaned card and the lanes of every board, read from ONE snapshot of the board. */
export interface OrphanedCards {
  readonly cards: readonly CardView[];
  readonly laneSets: readonly LaneSet[];
}

/** A ferret's focus card with the lanes of its board (`null` when that board has no lane set), as `GET /v1/board/cards/:id` answers. */
export interface FocusCard {
  readonly card: CardView;
  readonly laneSet: LaneSet | null;
}

/**
 * What the app and other plugins read and write through Board. There is NO `answer` here and no way for a card to ask
 * (#1552): a card is read-only status; the agenda asks, and answering an ask moves its linked cards.
 */
export interface BoardApi {
  card(id: CardId): Promise<CardView | undefined>;
  cards(query: BoardQuery): Promise<readonly CardView[]>;
  /**
   * The same read as {@link cards} with the cursor of the next page, so a caller can read past one page (up to
   * `MAX_BOARD_PAGE` cards): pass `nextCursor` back as the query's `cursor` until it is `null`.
   */
  cardsPage(query: BoardQuery): Promise<CardPage>;
  /**
   * The lane set of every project that has a card, so a consumer can name a lane (`laneName`) from a card's
   * `projectId` and `laneId`. A project with no lane set is not listed.
   */
  laneSets(): Promise<readonly LaneSet[]>;
  /**
   * Every open card Board calls orphaned (no ferret on it is alive), in board order, with the lanes of every board:
   * ONE read of the store and ONE derivation of activity, so a card that is picked up or becomes orphaned while the
   * caller works cannot make it skip or repeat another (paging with `cardsPage` can). Not limited to a page.
   */
  orphanedCards(): Promise<OrphanedCards>;
  /**
   * The card a ferret works on (its focus) with the lanes of its board, or `undefined` when it has none, the card is
   * not on this machine, or it is gone. A daemon-side read of the ferret's own card, answered whatever the card's
   * visibility (as the Warden's resume brief did); it is no route and no caller reads another person's board
   * through it.
   */
  focusOf(ferret: FerretId): Promise<FocusCard | undefined>;
  create(by: FerretId | 'owner', request: CardCreateRequest): Promise<Result<Card, BoardRefusal>>;
  act(by: FerretId | 'owner', id: CardId, request: CardActionRequest): Promise<Result<Card, BoardRefusal>>;
  /** `fy card progress`: replaces the parts named, keeps the rest. */
  progress(by: FerretId, id: CardId, parts: Partial<Progress>): Promise<Result<Card, BoardRefusal>>;
  /** The cards a ferret holds, for its sitrep line (one line per card, from its progress). */
  heldBy(ferret: FerretId): Promise<readonly CardView[]>;
  switchOf(project: string): Promise<BoardSwitch>;
}
export const BoardPort = definePort<BoardApi>('board');
