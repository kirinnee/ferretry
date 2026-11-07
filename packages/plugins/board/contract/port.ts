import { definePort } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretId } from './core.ts';
import type {
  BoardQuery,
  BoardSwitch,
  Card,
  CardActionRequest,
  CardCreateRequest,
  CardId,
  CardView,
  Progress,
} from './wire.ts';

export interface BoardRefusal {
  readonly code: 'invalid' | 'not-found' | 'forbidden' | 'board-off' | 'owner-only' | 'refused';
  readonly message: string;
}

/**
 * What the app and other plugins read and write through Board. There is NO `answer` here and no way for a card to ask
 * (#1552): a card is read-only status; the agenda asks, and answering an ask moves its linked cards.
 */
export interface BoardApi {
  card(id: CardId): Promise<CardView | undefined>;
  cards(query: BoardQuery): Promise<readonly CardView[]>;
  create(by: FerretId | 'owner', request: CardCreateRequest): Promise<Result<Card, BoardRefusal>>;
  act(by: FerretId | 'owner', id: CardId, request: CardActionRequest): Promise<Result<Card, BoardRefusal>>;
  /** `fy card progress`: replaces the parts named, keeps the rest. */
  progress(by: FerretId, id: CardId, parts: Partial<Progress>): Promise<Result<Card, BoardRefusal>>;
  /** The cards a ferret holds, for its sitrep line (one line per card, from its progress). */
  heldBy(ferret: FerretId): Promise<readonly CardView[]>;
  switchOf(project: string): Promise<BoardSwitch>;
}
export const BoardPort = definePort<BoardApi>('board');
