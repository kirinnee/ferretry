/**
 * CHECKING A CLEAN-UP'S REWRITE (docs/pack-mode.md § Clean up). A model wrote it, so it is read as untrusted
 * data and made into something the routing prompt may hold:
 *
 * - the prompt is trimmed, a double quote becomes a single one and a backslash is deleted; one longer than a
 *   prompt may be is cut at a sentence and the cut is NOTED; an empty one fails the run;
 * - the ferret's own notes are kept as `suggestion`s, each cut to length, at most {@link MAX_CLEAN_UP_NOTES};
 * - then the daemon adds its OWN notes from the rewrite's words, checked against the inventory the ferret was
 *   shown — a model-like word no catalog lists (`unknown_model`), and a listed model no runtime here runs
 *   (`absent_model`) — with the same recognition the editor highlights with.
 *
 * Nothing in the rewrite is ever followed as an instruction: it is only compared and copied into a value.
 *
 * Pure: the rewrite's text and the inventory in, the prompt and its notes (or why not) out.
 */
import {
  MAX_CLEAN_UP_NOTE_CHARS,
  MAX_CLEAN_UP_NOTES,
  MAX_ROUTING_PROMPT_CHARS,
  mentionedModels,
  modelMentions,
  modelVocabulary,
  PackCleanUpDraftSchema,
  type PackCleanUpNote,
  type PackFleetModel,
  type PackInventory,
} from '@ferretry/protocol';
import { cut } from '../routing.ts';

export type CheckedRewrite =
  | { readonly ok: true; readonly prompt: string; readonly notes: readonly PackCleanUpNote[] }
  | { readonly ok: false; readonly message: string };

/** The JSON object in a draft file: the whole text, or the one inside a fenced block a model wrapped it in. */
function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1];
  for (const candidate of [text, fenced]) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next reading
    }
  }
  return undefined;
}

/** The inventory's models as the highlighter's vocabulary: each with the runtimes here that run it. */
const vocabularyOf = (inventory: PackInventory): readonly PackFleetModel[] =>
  inventory.models.map(model => ({
    provider: model.provider,
    providerLabel: model.provider,
    harness: model.harness,
    id: model.id,
    label: model.label,
    tier: model.tier,
    efforts: model.efforts,
    runtimes: model.runtimes.map(runtime => runtime.name),
  }));

/** The daemon's own notes on a prompt's words: what it names that is unknown, or runs nowhere here. */
export function modelNotes(prompt: string, inventory: PackInventory): readonly PackCleanUpNote[] {
  return mentionedModels(modelMentions(prompt, modelVocabulary(vocabularyOf(inventory)))).flatMap(
    (segment): readonly PackCleanUpNote[] => {
      if (segment.kind === 'unknown')
        return [
          {
            kind: 'unknown_model',
            model: segment.text.slice(0, 128),
            message: `${segment.text} is not a model any catalog here lists, so an automatic start cannot use it.`,
          },
        ];
      if (segment.kind === 'absent' && segment.model !== undefined)
        return [
          {
            kind: 'absent_model',
            model: segment.model.id,
            message: `${segment.model.id} is listed by ${segment.model.provider}, but no runtime here runs it; add a login for it or name another.`,
          },
        ];
      return [];
    },
  );
}

/** Checks a rewrite file's text against the inventory the ferret was shown. */
export function checkRewrite(text: string, inventory: PackInventory): CheckedRewrite {
  const parsed = PackCleanUpDraftSchema.safeParse(parseJson(text));
  if (!parsed.success)
    return { ok: false, message: 'the clean-up did not write a prompt: its file is not a JSON object with "prompt"' };
  const clean = parsed.data.prompt.replaceAll('"', "'").replaceAll('\\', '').replaceAll(/\r\n?/gu, '\n').trim();
  if (clean === '') return { ok: false, message: 'the clean-up wrote an empty prompt' };
  const fitted = cut(clean, MAX_ROUTING_PROMPT_CHARS);
  const own = (parsed.data.notes ?? [])
    .flatMap(note => (typeof note === 'string' && note.trim() !== '' ? [note.trim()] : []))
    .slice(0, MAX_CLEAN_UP_NOTES)
    .map((note): PackCleanUpNote => ({ kind: 'suggestion', message: cut(note, MAX_CLEAN_UP_NOTE_CHARS).text }));
  const notes: PackCleanUpNote[] = [
    ...(fitted.cut
      ? [
          {
            kind: 'cut' as const,
            message: `The rewrite was ${String(clean.length)} characters, so it was cut to the ${String(MAX_ROUTING_PROMPT_CHARS)} a routing prompt may hold.`,
          },
        ]
      : []),
    ...modelNotes(fitted.text, inventory),
    ...own,
  ];
  return { ok: true, prompt: fitted.text, notes };
}
