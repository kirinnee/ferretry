import {
  type AttentionAsk,
  AttentionAskSchema,
  MAX_ATTENTION_ASK_OPTION_LENGTH,
  MAX_ATTENTION_ASK_OPTIONS,
} from '@ferretry/protocol';

/** What the human is asked to DO, keyed by the short names the flag accepts. */
const KINDS = new Map<string, AttentionAsk['kind']>([
  ['permission', 'permission'],
  ['choice', 'multiple-choice'],
  ['multiple-choice', 'multiple-choice'],
  ['review', 'answer-review'],
  ['answer-review', 'answer-review'],
  ['open', 'open-question'],
  ['open-question', 'open-question'],
]);

/** The names `--kind` accepts, for help text and error messages. */
export const ASK_KIND_NAMES = ['permission', 'choice', 'review', 'open'] as const;

/** The flags that shape an ask. */
export interface AskFlags {
  readonly kind?: string;
  readonly option?: readonly string[];
}

/**
 * Build the ask an `attention add` describes.
 *
 * Supplying `--option` without `--kind` implies a choice, because that is the only kind options mean
 * anything for — and a permission or review ask carrying options is a mistake worth naming rather
 * than silently dropping.
 */
export function parseAsk(flags: AskFlags): AttentionAsk {
  const options = (flags.option ?? []).map(option => option.trim()).filter(option => option.length > 0);
  const kind = askKind(flags.kind, options.length > 0);

  if (kind !== 'multiple-choice') {
    if (options.length > 0) {
      throw new Error(`--option only makes sense with --kind choice, not ${kind}`);
    }
    return { kind };
  }

  const parsed = AttentionAskSchema.safeParse({ kind, options: options.map(label => ({ label })) });
  if (!parsed.success) {
    throw new Error(
      `a choice ask needs 2 to ${MAX_ATTENTION_ASK_OPTIONS} distinct --option labels, ` +
        `each one line of at most ${MAX_ATTENTION_ASK_OPTION_LENGTH} characters`,
    );
  }
  return parsed.data;
}

function askKind(raw: string | undefined, hasOptions: boolean): AttentionAsk['kind'] {
  const named = raw?.trim() ?? '';
  if (named === '') return hasOptions ? 'multiple-choice' : 'open-question';
  const kind = KINDS.get(named);
  if (kind === undefined) {
    throw new Error(`unknown --kind "${named}" — use ${ASK_KIND_NAMES.join(', ')}`);
  }
  return kind;
}
