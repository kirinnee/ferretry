import {
  type AgendaAsk,
  AgendaAskSchema,
  type AgendaKind,
  askForKind,
  kindOfAsk,
  MAX_AGENDA_ASK_OPTION_LENGTH,
  MAX_AGENDA_CARD_ANSWERS,
} from '@ferretry/protocol';

/**
 * The kinds a card is raised as, keyed by the names `--kind` accepts — the older spellings included. A to-do is
 * `todo`, because "task" means a board card (`fy task`, `--task <card>`); `task` is still read, and stays the
 * wire value so a released daemon's strict add schema keeps accepting it.
 */
const KINDS = new Map<string, AgendaKind>([
  ['todo', 'task'],
  ['task', 'task'],
  ['yesno', 'yesno'],
  ['permission', 'permission'],
  ['choice', 'choice'],
  ['multiple-choice', 'choice'],
  ['review', 'review'],
  ['answer-review', 'review'],
  ['info', 'info'],
  ['reply', 'reply'],
  ['open', 'reply'],
  ['open-question', 'reply'],
]);

/** The names `--kind` is documented with, for help text and error messages. */
export const ASK_KIND_NAMES = ['todo', 'yesno', 'permission', 'choice', 'review', 'info', 'reply'] as const;

/** Why a card cannot offer more than three answers, and what to do instead. */
export const TOO_MANY_ANSWERS = `a card offers at most ${MAX_AGENDA_CARD_ANSWERS} answers (swipe left, up, right). Split this into several items, or use --kind reply and let the owner answer in words.`;

/** The flags that shape an ask. */
export interface AskFlags {
  readonly kind?: string;
  readonly option?: readonly string[];
  /** Forces a to-do ask: the human does something, nothing to choose. */
  readonly task?: boolean;
}

/** The kind a card is raised as and the ask that kind carries (`info` carries none). */
export interface CardAsk {
  readonly kind: AgendaKind;
  readonly ask: AgendaAsk | undefined;
}

/** The kind `--kind` names, or nothing when it is absent or blank. */
export function parseKind(raw: string | undefined): AgendaKind | undefined {
  const named = raw?.trim() ?? '';
  if (named === '') return undefined;
  const kind = KINDS.get(named);
  if (kind === undefined) throw new Error(`unknown --kind "${named}" — use ${ASK_KIND_NAMES.join(', ')}`);
  return kind;
}

/**
 * Build the kind and the ask an `agenda add` describes.
 *
 * Supplying `--option` without `--kind` implies a choice, because that is the only kind options mean
 * anything for — and any other kind carrying options is a mistake worth naming rather than silently
 * dropping. Exactly Yes and No is a `yesno`; a `yesno` brings its own two options, so it refuses any.
 * A card offers at most three answers, so a choice takes two or three options.
 */
export function parseAsk(flags: AskFlags): CardAsk {
  const options = (flags.option ?? []).map(option => option.trim()).filter(option => option.length > 0);
  const named = parseKind(flags.kind);
  const kind = named ?? (options.length > 0 ? 'choice' : 'reply');

  if (kind === 'yesno' && options.length > 0) {
    throw new Error('--kind yesno brings its own Yes and No: drop --option (or use --kind choice for other options)');
  }
  if (kind !== 'choice') {
    if (options.length > 0) throw new Error(`--option only makes sense with --kind choice, not ${kind}`);
    return { kind, ask: askForKind(kind) };
  }

  if (options.length > MAX_AGENDA_CARD_ANSWERS) throw new Error(TOO_MANY_ANSWERS);
  const parsed = AgendaAskSchema.safeParse(
    askForKind(
      'choice',
      options.map(label => ({ label })),
    ),
  );
  if (!parsed.success) {
    throw new Error(
      `a choice card needs 2 to ${MAX_AGENDA_CARD_ANSWERS} distinct --option labels, ` +
        `each one line of at most ${MAX_AGENDA_ASK_OPTION_LENGTH} characters`,
    );
  }
  return { kind: named ?? kindOfAsk(parsed.data), ask: parsed.data };
}
