import type { AskSummary } from './index.ts';
import {
  type AgendaId,
  agendaNotificationPath,
  AGENDA_PUSH_TITLE_LENGTH,
  ASK_LINK_PARAMETER,
  isMachineAgendaId,
} from './snapshot/agenda.ts';
import { clipAtWord } from './snapshot/agenda-task.ts';

/** The most a buzz's body says: a lock screen shows a line, not a paragraph. */
export const AGENDA_PUSH_BODY_LENGTH = 120;

/** The text on one line: runs of whitespace become one space. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** What a new paired device's alert says. Access sends it; a ferret's words must never read as it. */
const DEVICE_PAIRED_TITLE = 'A new device was paired';
/** What an approve-on-phone push says. A ferret's words must never read as it. */
const PHONE_APPROVAL_TITLE = 'Approve on your phone';

/** Latin look-alikes an agent could spell the reserved alert title with, folded to the letter they mimic. */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

/** The letters a reader sees, whatever script or accent spells them: `A nеw dévice!` becomes `anewdevice`. */
function letterSkeleton(text: string): string {
  return [...text.normalize('NFKD').toLowerCase()]
    .map(letter => CONFUSABLE_LETTERS[letter] ?? letter)
    .join('')
    .replaceAll(/[^a-z]/gu, '');
}

/**
 * What the reserved alerts say, as letters: a name that reads as "new device" or "paired" anywhere is not a ferret's to
 * put on a lock screen bare. Derived from the alerts' own titles, so the two cannot drift.
 */
const RESERVED_ALERT_SKELETONS = [
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').slice(1, 3).join(' ')),
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').at(-1) ?? ''),
  // A ferret's own push must never read as the daemon's approve-on-phone push, whose number the owner taps.
  letterSkeleton(PHONE_APPROVAL_TITLE),
].filter(skeleton => skeleton !== '');

/**
 * A buzz's title: the ask's own, plain, trimmed to `AGENDA_PUSH_TITLE_LENGTH` at a word boundary.
 *
 * A ferret chooses these words, so one that READS as the daemon's own new-device alert or its approve-on-phone push, in
 * any letters that look like it, is labelled `Ferret “…”`, which no real alert ever opens with. Every other title is
 * the words as written.
 */
export function buzzTitle(title: string): string {
  const name = oneLine(title);
  const letters = letterSkeleton(name);
  if (!RESERVED_ALERT_SKELETONS.some(reserved => letters.includes(reserved)))
    return clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH);
  return `Ferret “${clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH - 9)}”`;
}

/** A buzz's body: one line, clipped at a word. */
export const buzzBody = (text: string): string => clipAtWord(text, AGENDA_PUSH_BODY_LENGTH);

// ─── the buzz an ask makes ───────────────────────────────────────────────────────────────────────────────────────

/** An ask as the buzz reads it: the summary Asks gives, plus the one flag a notice may carry (`--buzz`). */
export type BuzzableAsk = AskSummary & { readonly blocking?: boolean };

/** What a buzz says and where a tap opens: words only, never a secret. */
export interface BuzzWords {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  /** Names the ONE event the buzz is about (never the `tag`, which a later event of the same ferret shares); absent: never skipped as a twin. */
  readonly eventKey?: string;
}

/** The tag an ask's buzz goes out under: its own, so opening the ask can take down exactly that line on every device. */
export const agendaAskBuzzTag = (ferret: string, ask: string): string => `agenda-${ferret}:${ask}`;

/**
 * Where a buzz about an ask opens, RELATIVE TO THE MACHINE'S OWN PAGES. A ferret's ask opens that ferret's chat AT the ask
 * (`/ferrets/<ferret>/chat?ask=A3`); an ask with NO ferret (a machine notice: the machine's own ledger, or no ferret named)
 * has no chat, so it opens the machine's Agenda page AT the ask (`/agenda?ask=A3`). Never `/ferrets//chat`.
 */
export const askBuzzPath = (ferret: string, ask: AgendaId): string =>
  ferret.trim() === '' || isMachineAgendaId(ferret)
    ? `/agenda?${ASK_LINK_PARAMETER}=${encodeURIComponent(ask)}`
    : agendaNotificationPath(ferret, ask);

/** The ledger key of an ask's own buzz: at most one per ask (a notice's `--buzz`, a card's ask). */
export const askBuzzKey = (ferret: string, ask: string): string => `ask:${ferret}:${ask}`;

/** The moments an ask buzzes the phone by itself: a card's ask, and a notice that asked for it. Everything else waits for the stop. */
export type AskBuzzKind = 'card-ask' | 'notice';

/** Which moment an ask's own buzz is, or `undefined` when the ask makes none. */
export function askBuzzKind(ask: BuzzableAsk): AskBuzzKind | undefined {
  if (ask.state !== 'open') return undefined;
  if (ask.source === 'card') return 'card-ask';
  if (ask.kind === 'notice' && ask.blocking === true) return 'notice';
  return undefined;
}

/** What the one buzz for an ask says: its subject as title and body, a tap opens the ask. */
export function askBuzzWords(ask: BuzzableAsk): BuzzWords {
  const ferret = ask.ferret ?? '';
  return {
    tag: agendaAskBuzzTag(ferret, ask.id),
    title: buzzTitle(ask.subject),
    body: buzzBody(ask.subject),
    url: askBuzzPath(ferret, ask.id),
  };
}
