/**
 * The models-guide generator as a person reads it in a terminal (docs/pack-mode.md § Suggesting a guide):
 * the inventory the builder is shown, and a builder's draft as a diff against the guide in effect — the
 * routing guidance before and after, then every use case added, changed, removed or left the same, then what
 * the check dropped or changed. Pure: values in, text out.
 */
import {
  diffGuide,
  type GuideCandidate,
  type GuideRouting,
  type GuideUseCaseDiff,
  type PackGuideJob,
  type PackGuideSuggestion,
  type PackInventory,
  routingChanged,
} from '@ferretry/protocol';

const candidateLine = (candidate: GuideCandidate, index: number): string => {
  const harness = candidate.harness === undefined ? '' : ` (${candidate.harness})`;
  const effort = candidate.effort === undefined ? '' : ` @${candidate.effort}`;
  return `      ${String(index + 1)}. ${candidate.provider}/${candidate.model}${harness}${effort} — ${candidate.why}`;
};

const MARK: Readonly<Record<GuideUseCaseDiff['status'], string>> = {
  added: '+ added  ',
  changed: '~ changed',
  removed: '- removed',
  same: '= same   ',
};

/** One use case's row of the diff. */
function diffRow(row: GuideUseCaseDiff): readonly string[] {
  const useCase = row.after ?? row.before;
  const head = `  ${MARK[row.status]} ${row.id} — ${useCase?.title ?? ''}`;
  if (row.status === 'same' || row.status === 'removed') return [head];
  return [head, ...row.changes.map(change => `      ${change}`), ...(row.after?.candidates ?? []).map(candidateLine)];
}

const indented = (text: string, prefix: string): readonly string[] => text.split('\n').map(line => `${prefix}${line}`);

/** The routing guidance before and after, or that it is unchanged. */
function routingLines(before: GuideRouting | undefined, after: GuideRouting): readonly string[] {
  if (!routingChanged(before, after)) return ['Routing guidance: unchanged.'];
  return [
    'Routing guidance:',
    ...(before === undefined ? ['  (none before)'] : indented(before.prompt, '  - ')),
    ...indented(after.prompt, '  + '),
    `  short line: ${after.short}`,
  ];
}

/** A draft as a diff against the guide in effect, with what the check took out or changed. */
export function renderSuggestion(job: PackGuideJob, suggestion: PackGuideSuggestion, bin: string): string {
  const diff = diffGuide(suggestion.current.useCases, suggestion.useCases);
  const notes = (title: string, list: PackGuideSuggestion['dropped']): readonly string[] =>
    list.length === 0
      ? []
      : [
          '',
          `${title} (${String(list.length)}):`,
          ...list.map(note => `  - ${note.useCase === undefined ? '' : `${note.useCase}: `}${note.message}`),
        ];
  return [
    `Suggested by ${suggestion.suggested.by} on ${suggestion.suggested.via} (${suggestion.suggested.at.slice(0, 16).replace('T', ' ')}Z), against ${suggestion.current.source === 'file' ? 'your guide' : 'the built-in guide'}.`,
    '',
    ...routingLines(
      suggestion.current.routing === undefined
        ? undefined
        : { prompt: suggestion.current.routing.prompt, short: suggestion.current.routing.short },
      suggestion.routing,
    ),
    '',
    'Use cases:',
    ...diff.flatMap(diffRow),
    ...notes('Dropped', suggestion.dropped),
    ...notes('Changed by the check', suggestion.flagged),
    '',
    `Accept it all: ${bin} guide accept ${job.id}`,
    `Accept some:   ${bin} guide accept ${job.id} --only <id,id> [--keep-routing]`,
  ].join('\n');
}

/** The inventory: every runtime with its readiness and quota, then every model with its headroom. */
export function renderInventory(inventory: PackInventory): string {
  return [
    `Runtimes (${String(inventory.runtimes.length)}):`,
    ...inventory.runtimes.map(
      runtime =>
        `  ${runtime.ready ? 'ready  ' : 'cannot '} ${runtime.name} (${runtime.harness}${runtime.provider === undefined ? '' : `, ${runtime.provider}`}) · quota ${runtime.quota.summary}${runtime.refusal === undefined ? '' : ` — ${runtime.refusal.message}`}`,
    ),
    '',
    `Models (${String(inventory.models.length)}):`,
    ...inventory.models.flatMap(model => [
      `  ${model.provider}/${model.id}${model.harness === 'codex' ? ' (codex)' : ''} — ${model.label}, ${model.tier}${model.retires === undefined ? '' : `, retires ${model.retires}`}`,
      `      ${model.describedBy === 'owner' ? 'yours' : 'catalog'}: ${model.description}`,
      `      ${model.headroom.summary}`,
    ]),
    ...(inventory.preferences === undefined
      ? []
      : ['', 'Your routing preferences:', ...indented(inventory.preferences, '  ')]),
  ].join('\n');
}
