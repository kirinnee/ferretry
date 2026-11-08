/**
 * THE APP HOOKS AGENDA OFFERS (§5.2; `@ferretry/app`'s `useAppHook`, a provider's `shell.hooks`).
 *
 * An ask about a card is Agenda's to draw and Board's to act on: "Done · closes &F12" sits in the ask's own answer
 * row, a notice's cards carry Start and Close, an Edit on a lane proposal opens the lane editor, and `&F12` in an
 * ask's words links to the card. Those writes, reads and pages are Board's, and neither half imports the other: Agenda
 * OFFERS the three hooks below and the plugin that holds the cards PROVIDES them, each over its own client on one
 * daemon. The names and the shapes are the whole agreement; Agenda narrows what it is given before it reads it.
 *
 * FAIL CLOSED. With no provider (Board not installed, not allowed on that daemon, or two plugins providing one name),
 * Agenda draws the ask as it does without one: no Done · closes, Start and Close refused with the reason, Edit only
 * answers, and `&F12` stays prose. The provider's daemon route is the authority on every write; nothing here is.
 *
 * The values are plain data and functions (no framework type: this is a contract).
 */

/** "Done · closes", and a notice's Start and Close: the card writes an ask makes. */
export const AGENDA_CARD_ANSWER_HOOK = 'agenda.card-answer' as const;
/** Where Edit on a lane-proposal ask goes. */
export const AGENDA_LANE_PROPOSAL_HOOK = 'agenda.lane-proposal' as const;
/** Whether `&F12` in an ask's words is a card, and where it opens. */
export const AGENDA_CARD_REFERENCE_HOOK = 'agenda.card-reference' as const;

/** Every app hook Agenda offers, in one list a test can pair against what a provider gives. */
export const AGENDA_APP_HOOKS = [
  AGENDA_CARD_ANSWER_HOOK,
  AGENDA_LANE_PROPOSAL_HOOK,
  AGENDA_CARD_REFERENCE_HOOK,
] as const;
export type AgendaAppHook = (typeof AGENDA_APP_HOOKS)[number];

/** A card write's answer: done, or the refusal in words (`status` 0 when the request got no answer). */
export type AgendaCardWrite<Value = undefined> =
  | ({ readonly ok: true } & (Value extends undefined ? unknown : { readonly value: Value }))
  | { readonly ok: false; readonly status: number; readonly message: string };

/** One card as the provider last read it. The same object until it changes. */
export interface AgendaCardView {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  /** The board answered and has no such card. */
  readonly missing: boolean;
  readonly title?: string | undefined;
  /** Done has nothing left to do: the card is already closed. */
  readonly closed: boolean;
}

/** `agenda.card-answer`: the cards of the daemon the provider was built for, by id (`F12`). */
export interface AgendaCardAnswer {
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps `card` read and live until the returned release is called. */
  readonly watch: (card: string) => () => void;
  readonly card: (card: string) => AgendaCardView;
  /**
   * The board's own Done: moves the card into its board's Done lane with one request, recorded in its history and told
   * to its ferret. Nothing is sent for a card that is already closed (answered done) or that the board has no Done for.
   */
  readonly done: (card: string) => Promise<AgendaCardWrite>;
  /** Starts a ferret on the card (or names the one that holds it); `key` makes a retry of one click the same request. */
  readonly start: (
    card: string,
    key: string,
  ) => Promise<AgendaCardWrite<{ readonly started: boolean; readonly ferret: string }>>;
  /** Drops the card with the reason the board records. */
  readonly drop: (card: string, reason: string) => Promise<AgendaCardWrite>;
}

/** An answer, as far as the lane editor reads it: a multiple choice and the label pressed. */
export interface AgendaChoiceAnswer {
  readonly kind: string;
  readonly response?: { readonly kind: string; readonly choice?: string };
}

/** `agenda.lane-proposal`: the lane editor an answer to an ask opens, or `undefined` when it opens none. */
export interface AgendaLaneProposal {
  readonly editorFor: (
    ask: { readonly sourceRef?: string | null | undefined },
    answer: AgendaChoiceAnswer,
  ) => string | undefined;
}

/** The lane editor `agenda.lane-proposal` opens for an answer. */
export type AgendaLaneEditor = AgendaLaneProposal['editorFor'];

/** `agenda.card-reference`: the proof behind a `&F12` and where it opens. */
export interface AgendaCardReference {
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the proof read and live until the returned release is called. */
  readonly watch: () => () => void;
  /** Whether an id is a card on this daemon, as last read (a new function when that changes). Syntax is not proof. */
  readonly proves: () => (id: string) => boolean;
  /** The card's page. */
  readonly href: (id: string) => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const functions = (value: unknown, names: readonly string[]): boolean =>
  isRecord(value) && names.every(name => typeof value[name] === 'function');

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isAgendaCardAnswer = (value: unknown): value is AgendaCardAnswer =>
  functions(value, ['subscribe', 'watch', 'card', 'done', 'start', 'drop']);
export const isAgendaLaneProposal = (value: unknown): value is AgendaLaneProposal => functions(value, ['editorFor']);
export const isAgendaCardReference = (value: unknown): value is AgendaCardReference =>
  functions(value, ['subscribe', 'watch', 'proves', 'href']);
