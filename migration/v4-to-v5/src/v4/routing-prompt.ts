/**
 * v4's rendering of an old routing guide as ONE routing prompt. A LOCAL copy on purpose (v5 has no v4 reader), copied
 * from v4.291.5 `packages/daemon/src/lib/pack/routing.ts` (`legacyUseCases`, `cut`, `legacyPrompt`) and the order of
 * `lib/pack/migrate.ts` (the prompt is rendered FIRST, then the old keys go). Never a redesign: the same text, byte for
 * byte, so a home v4 had not yet folded ends up with the prompt v4 would have written.
 *
 * One difference, and only because the converter reads no model catalogs: v4 put the DEFAULT prompt (rendered from the
 * catalogs in effect) in front of the prose when the guide named no use cases. The converter cannot render that, so a
 * guide with prose and no use cases carries the prose alone (`oldGuidePrompt` says so through `defaultHead`).
 */
import { isRecord } from './documents.ts';

/** v4's `MAX_ROUTING_PROMPT_CHARS` (`protocol/src/lib/pack.ts:115`). */
const V4_MAX_ROUTING_PROMPT_CHARS = 1_200;
/** v4's `LEGACY_CANDIDATES`: how many of a use case's candidates its rendered line names. */
const V4_RENDERED_CANDIDATES = 3;

interface OldUseCase {
  readonly title: string;
  readonly candidates: readonly { readonly model: string; readonly effort?: string; readonly codex: boolean }[];
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function oldUseCases(raw: readonly unknown[] | undefined): readonly OldUseCase[] {
  return (raw ?? []).flatMap(entry => {
    if (!isRecord(entry)) return [];
    const title = text(entry.title) ?? text(entry.id);
    if (title === undefined) return [];
    const candidates = (Array.isArray(entry.candidates) ? entry.candidates : []).flatMap(candidate => {
      if (!isRecord(candidate)) return [];
      const model = text(candidate.model);
      const effort = text(candidate.effort);
      return model === undefined
        ? []
        : [{ model, ...(effort === undefined ? {} : { effort }), codex: candidate.harness === 'codex' }];
    });
    return [{ title, candidates }];
  });
}

/** Text cut to `limit` characters at the last sentence or line end that fits, with "…" after it; whole when it fits. */
function cut(value: string, limit: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= limit) return { text: value, cut: false };
  const head = value.slice(0, Math.max(0, limit - 1));
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('\n'));
  const kept = (end > limit / 2 ? head.slice(0, end + 1) : head).trimEnd();
  return { text: `${kept}…`, cut: true };
}

/** The old guide's keys `oldGuidePrompt` reads (`models` was never part of the prompt). */
export interface OldGuide {
  readonly useCases?: readonly unknown[] | undefined;
  readonly routing?: unknown;
}

/** The old guide as one prompt, whether it was cut to fit, and which of the old keys the text carries. */
export interface RenderedPrompt {
  readonly text: string;
  readonly cut: boolean;
  readonly used: readonly ('useCases' | 'routing' | 'routingPreferences')[];
  /** True when v4 would have put the default prompt in front (no use cases named) and this text does not. */
  readonly defaultHead: boolean;
}

/**
 * The old guide as ONE routing prompt: its use cases first (each title and its first candidates, best first), then its
 * own routing prompt, then the owner's `pack.yaml` routing preferences. `undefined` when the file said nothing a prompt
 * could carry. When the text is longer than a prompt may be, the use cases are kept whole and the prose is cut at a
 * sentence.
 */
export function oldGuidePrompt(file: OldGuide, preferences: string | undefined): RenderedPrompt | undefined {
  const useCases = oldUseCases(file.useCases);
  const lines = useCases.map(useCase => {
    const named = useCase.candidates
      .slice(0, V4_RENDERED_CANDIDATES)
      .map(
        candidate =>
          `${candidate.model}${candidate.codex ? ' (codex)' : ''}${candidate.effort === undefined ? '' : ` at ${candidate.effort}`}`,
      );
    return `- ${useCase.title}: ${named.length === 0 ? 'no model named' : named.join(', then ')}.`;
  });
  const routingProse = isRecord(file.routing) ? text(file.routing.prompt) : undefined;
  const preferenceProse = text(preferences) === undefined ? undefined : `Preferences: ${text(preferences) ?? ''}`;
  const prose = [routingProse, preferenceProse].filter((part): part is string => part !== undefined);
  const used: RenderedPrompt['used'] = [
    ...(lines.length === 0 ? [] : (['useCases'] as const)),
    ...(routingProse === undefined ? [] : (['routing'] as const)),
    ...(preferenceProse === undefined ? [] : (['routingPreferences'] as const)),
  ];
  if (lines.length === 0 && prose.length === 0) return undefined;
  if (lines.length === 0) {
    const tail = cut(prose.join('\n'), V4_MAX_ROUTING_PROMPT_CHARS);
    return { text: tail.text, cut: tail.cut, used, defaultHead: true };
  }
  const head = ["Pick each sub-task's model by the kind of work, best first:", ...lines];
  const structured = cut(head.join('\n'), V4_MAX_ROUTING_PROMPT_CHARS);
  if (prose.length === 0) return { ...structured, used, defaultHead: false };
  const room = V4_MAX_ROUTING_PROMPT_CHARS - (structured.text.length === 0 ? 0 : structured.text.length + 1);
  if (room < 40) return { text: structured.text, cut: true, used: ['useCases'], defaultHead: false };
  const tail = cut(prose.join('\n'), room);
  return {
    text: [structured.text, tail.text].filter(part => part !== '').join('\n'),
    cut: structured.cut || tail.cut,
    used,
    defaultHead: false,
  };
}
