/**
 * PACK MODE'S TWO FILES AS TEXT: `pack.yaml` (the switch, who decides, the limits, the probe, Jev's
 * cap, the owner's routing preferences) and `models-guide.yaml` (the use cases, their candidates, the
 * routing guidance and the `suggested` stamp of an accepted suggestion), read and edited the way Voice
 * cleanup edits `voice.yaml` — only the keys that change are rewritten, so the owner's comments and key
 * order survive (docs/config-files.md).
 *
 * A setting equal to its default is written only where the file already says something about it, so
 * an untouched machine keeps an empty `pack.yaml`. Saving the guide writes EVERY use case, which turns
 * the derived guide into the owner's; removing `useCases` is "Reset to the built-in guide". An editor save
 * always removes `suggested`: the guide is the owner's words now, not the builder's.
 *
 * Pure: text in, text out. `null` means the file does not check and cannot be edited here.
 */

import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import {
  configSchemaModeline,
  DEFAULT_PACK_CONFIG,
  type GuideCandidate,
  GuideRoutingSchema,
  type GuideUseCase,
  ModelsGuideFileSchema,
  type PackConfig,
  type PackFile,
  PackFileSchema,
} from '@ferretry/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** The file's top-level mapping, `{}` for an empty file, `null` for one that does not parse. */
const rawOf = (text: string): Record<string, unknown> | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const value = read.read.value ?? {};
  return isRecord(value) ? value : null;
};

/** What `pack.yaml` says, or `null` when it does not parse or check. */
export function readPackFile(text: string): PackFile | null {
  const raw = rawOf(text);
  if (raw === null) return null;
  const checked = PackFileSchema.safeParse(raw);
  return checked.success ? checked.data : null;
}

/** A change to ask for: any setting, any part of a section. */
export interface PackConfigPatch {
  readonly enabled?: boolean;
  readonly decision?: PackConfig['decision'];
  readonly limits?: Partial<PackConfig['limits']>;
  readonly probe?: Partial<PackConfig['probe']>;
  readonly jev?: Partial<PackConfig['jev']>;
  /** The owner's routing preferences for the guide builder; an empty string removes the key. */
  readonly routingPreferences?: string;
}

const SECTIONS = ['limits', 'probe', 'jev'] as const;

/** `pack.yaml` with the change made, or `null` when the file does not check. */
export function withPackConfig(text: string, patch: PackConfigPatch): string | null {
  const raw = rawOf(text);
  if (raw === null || readPackFile(text) === null) return null;
  let target: Record<string, unknown> = { ...raw };
  const setTop = (key: 'enabled' | 'decision', value: unknown): void => {
    if (value === undefined) return;
    if (key in raw || value !== DEFAULT_PACK_CONFIG[key]) target = { ...target, [key]: value };
  };
  setTop('enabled', patch.enabled);
  setTop('decision', patch.decision);
  for (const section of SECTIONS) {
    const change: Readonly<Record<string, unknown>> | undefined = patch[section];
    if (change === undefined) continue;
    const before = isRecord(raw[section]) ? raw[section] : {};
    const defaults: Readonly<Record<string, unknown>> = DEFAULT_PACK_CONFIG[section];
    let next: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined && (key in before || value !== defaults[key])) next = { ...next, [key]: value };
    }
    target = Object.keys(next).length === 0 ? withoutKey(target, section) : { ...target, [section]: next };
  }
  if (patch.routingPreferences !== undefined) {
    const words = patch.routingPreferences.trim();
    target = words === '' ? withoutKey(target, 'routingPreferences') : { ...target, routingPreferences: words };
  }
  const edited = editConfigText(text, target, raw, configSchemaModeline({ kind: 'pack' }));
  return readPackFile(edited) === null ? null : edited;
}

// ── models-guide.yaml ────────────────────────────────────────────────────────────────────────────

/** A candidate as the file should hold it: trimmed, and an optional field left out when empty. */
const candidateForFile = (candidate: GuideCandidate): GuideCandidate => ({
  provider: candidate.provider.trim(),
  model: candidate.model.trim(),
  ...(candidate.harness === undefined ? {} : { harness: candidate.harness }),
  ...(candidate.effort === undefined || candidate.effort.trim() === '' ? {} : { effort: candidate.effort.trim() }),
  why: candidate.why.trim(),
});

/** A use case as the file should hold it, keywords trimmed and left out when there are none. */
export const useCaseForFile = (useCase: GuideUseCase): GuideUseCase => {
  const keywords = (useCase.keywords ?? []).map(word => word.trim()).filter(word => word !== '');
  return {
    id: useCase.id.trim(),
    title: useCase.title.trim(),
    description: useCase.description.trim(),
    ...(keywords.length === 0 ? {} : { keywords }),
    candidates: useCase.candidates.map(candidateForFile),
  };
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  id: 'id',
  title: 'title',
  description: 'description',
  keywords: 'keywords',
  candidates: 'candidates',
  provider: 'provider',
  model: 'model',
  effort: 'effort',
  why: 'why',
};

/** Where an issue is, in the editor's words: `Use case 2 › candidate 1 › why`. */
const issuePlace = (path: readonly PropertyKey[]): string => {
  const words: string[] = [];
  for (let index = 1; index < path.length; index += 1) {
    const part = path[index];
    const before = path[index - 1];
    if (typeof part === 'number')
      words.push(before === 'candidates' ? `candidate ${part + 1}` : `use case ${part + 1}`);
    else if (typeof part === 'string' && FIELD_WORDS[part] !== undefined && typeof path[index + 1] !== 'number')
      words.push(FIELD_WORDS[part]);
  }
  const place = words.join(' › ');
  return place.charAt(0).toLocaleUpperCase() + place.slice(1);
};

/** What is wrong with a guide before it is written, one sentence per problem; empty when it checks. */
export function guideIssues(useCases: readonly GuideUseCase[]): readonly string[] {
  const checked = ModelsGuideFileSchema.safeParse({ useCases: useCases.map(useCaseForFile) });
  if (checked.success) return [];
  return checked.error.issues.map(issue => {
    const place = issuePlace(issue.path);
    return place === '' ? issue.message : `${place}: ${issue.message}`;
  });
}

/** The routing guidance as the editor holds it: two plain strings, either may still be empty. */
export interface RoutingDraft {
  readonly prompt: string;
  readonly short: string;
}

/** What is wrong with the routing guidance before it is written; empty when it checks, or when both are empty. */
export function routingIssues(routing: RoutingDraft): readonly string[] {
  if (routing.prompt.trim() === '' && routing.short.trim() === '') return [];
  const checked = GuideRoutingSchema.safeParse({ prompt: routing.prompt, short: routing.short });
  if (checked.success) return [];
  return checked.error.issues.map(issue => {
    const part = issue.path[0] === 'short' ? 'The one-line summary' : 'The routing guidance';
    return `${part}: ${issue.message}`;
  });
}

/**
 * What to do with the file's `routing`: leave it (`undefined`), write the owner's (a pair), or remove it so
 * the rendered one is in effect again (`null`).
 */
export type RoutingEdit = RoutingDraft | null | undefined;

/**
 * `models-guide.yaml` with the guide written in full, or with `useCases` removed when `useCases` is
 * `null` (the built-in guide). Either way the file stops claiming a suggestion wrote it: `suggested` is the
 * record of a guide accepted as drafted, and a saved edit makes it the owner's own words. `routing` is left
 * as the file has it unless `routing` says otherwise. `null` when the file does not parse or the result
 * would not check.
 */
export function withModelsGuide(
  text: string,
  useCases: readonly GuideUseCase[] | null,
  routing: RoutingEdit = undefined,
): string | null {
  const raw = rawOf(text);
  if (raw === null) return null;
  const guide = withoutKey(raw, 'suggested');
  const written =
    useCases === null ? withoutKey(guide, 'useCases') : { ...guide, useCases: useCases.map(useCaseForFile) };
  const target =
    routing === undefined
      ? written
      : routing === null
        ? withoutKey(written, 'routing')
        : { ...written, routing: { prompt: routing.prompt.trim(), short: routing.short.trim() } };
  const edited = editConfigText(text, target, raw, configSchemaModeline({ kind: 'modelsGuide' }));
  const back = rawOf(edited);
  return back !== null && ModelsGuideFileSchema.safeParse(back).success ? edited : null;
}
