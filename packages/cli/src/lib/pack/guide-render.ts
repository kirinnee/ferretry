/**
 * Clean up as a person reads it in a terminal (docs/pack-mode.md § Clean up): the inventory the clean-up
 * ferret is shown, and its rewrite as a before/after word diff, then its notes. Pure: values in, text out.
 */
import {
  diffText,
  type PackCleanUpJob,
  type PackCleanUpSuggestion,
  type PackInventory,
  type TextDiffPart,
} from '@ferretry/protocol';

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[39m';

/** One part of the diff: removed as `[-…-]`, added as `{+…+}`, tinted when `color`; whitespace stays outside. */
function partText(part: TextDiffPart, color: boolean): string {
  if (part.kind === 'same') return part.text;
  const inner = part.text.trim();
  if (inner === '') return part.kind === 'removed' ? '' : part.text;
  const lead = part.text.slice(0, part.text.length - part.text.trimStart().length);
  const trail = part.text.slice(part.text.trimEnd().length);
  const [open, close, tint] = part.kind === 'removed' ? (['[-', '-]', RED] as const) : (['{+', '+}', GREEN] as const);
  const marked = `${open}${inner}${close}`;
  return `${lead}${color ? `${tint}${marked}${RESET}` : marked}${trail}`;
}

/** A rewrite against the prompt it was made from, as one running text with the changes marked. */
export function renderTextDiff(before: string, after: string, color: boolean): string {
  return diffText(before, after)
    .map(part => partText(part, color))
    .join('')
    .trimEnd();
}

/** A checked rewrite as a person reviews it: who wrote it, the diff, the notes, and how to accept it. */
export function renderCleanUp(
  job: PackCleanUpJob,
  suggestion: PackCleanUpSuggestion,
  bin: string,
  color: boolean,
): string {
  const by = suggestion.suggested;
  return [
    `Cleaned up by ${by.by} on ${by.via} (${by.at.slice(0, 16).replace('T', ' ')}Z). Removed text is [-like this-], added text is {+like this+}:`,
    '',
    renderTextDiff(suggestion.before, suggestion.after, color),
    ...(suggestion.notes.length === 0
      ? []
      : [
          '',
          `Notes (${String(suggestion.notes.length)}):`,
          ...suggestion.notes.map(n => `  - ${n.kind}: ${n.message}`),
        ]),
    '',
    `Accept with: ${bin} guide accept ${job.id}`,
  ].join('\n');
}

/** The inventory: every runtime with its readiness, quota and models, then every model with where it runs. */
export function renderInventory(inventory: PackInventory): string {
  return [
    `Runtimes (${String(inventory.runtimes.length)}):`,
    ...inventory.runtimes.flatMap(runtime => [
      `  ${runtime.ready ? 'ready ' : 'cannot'} ${runtime.name} (${runtime.harness}${runtime.provider === undefined ? '' : `, ${runtime.provider}`}) · quota ${runtime.quota.summary}${runtime.refusal === undefined ? '' : ` — ${runtime.refusal.message}`}`,
      `      models: ${runtime.models.length === 0 ? '(none)' : runtime.models.join(', ')}`,
    ]),
    '',
    `Models (${String(inventory.models.length)}):`,
    ...inventory.models.flatMap(model => [
      `  ${model.provider}/${model.id}${model.harness === 'codex' ? ' (codex)' : ''} — ${model.label}, ${model.tier}${model.context === undefined ? '' : `, ${String(model.context)} context`}`,
      `      runs on: ${model.runtimes.length === 0 ? 'no runtime here' : model.runtimes.map(r => `${r.name}${r.ready ? '' : ' (cannot start now)'}`).join(', ')}`,
    ]),
  ].join('\n');
}
