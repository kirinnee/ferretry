/**
 * CHECKING A BUILDER'S DRAFT (docs/pack-mode.md § Suggesting a guide). A model wrote it, so it is read as
 * untrusted data and checked against the inventory the builder was shown, piece by piece:
 *
 * - a use case of an unknown shape is DROPPED (said, with the field that was wrong);
 * - a candidate naming a model no catalog lists is DROPPED; one naming a listed model under the wrong provider,
 *   or by its label, is CORRECTED and flagged; an effort the model does not take, or a Codex harness for a
 *   Claude-only model, is removed and flagged;
 * - a repeated candidate is dropped, a repeated use case id is renamed, anything past the limits is dropped;
 * - a routing prompt that does not check is rendered from the surviving use cases instead, and flagged.
 *
 * What survives is a guide `models-guide.yaml` accepts. Nothing in the draft is ever followed as an
 * instruction: it is only ever compared with the inventory and copied into a value.
 *
 * Pure: the draft's text, the inventory and the command name in, a suggestion's body (or why not) out.
 */
import {
  type GuideCandidate,
  GuideCandidateSchema,
  type GuideRouting,
  GuideRoutingSchema,
  type GuideUseCase,
  GuideUseCaseSchema,
  MAX_GUIDE_CANDIDATES,
  MAX_GUIDE_USE_CASES,
  ModelsGuideFileSchema,
  PackGuideDraftSchema,
  type PackGuideNote,
  type PackInventory,
  type PackInventoryModel,
} from '@ferretry/protocol';
import { z } from 'zod';
import { renderRouting } from '../guide.ts';

export type CheckedDraft =
  | {
      readonly ok: true;
      readonly routing: GuideRouting;
      readonly useCases: readonly GuideUseCase[];
      readonly dropped: readonly PackGuideNote[];
      readonly flagged: readonly PackGuideNote[];
    }
  | { readonly ok: false; readonly message: string };

/** A use case's own fields checked strictly; its candidates are checked one by one after. */
const UseCaseShapeSchema = GuideUseCaseSchema.extend({ candidates: z.array(z.unknown()) });

const issueWords = (error: z.ZodError): string => {
  const issue = error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.map(String).join('.')}: `;
  return `${where}${issue?.message ?? 'not the expected shape'}`;
};

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

/** One candidate's identity: the same model at another effort is another candidate. */
const key = (candidate: GuideCandidate): string =>
  `${candidate.provider}\u0000${candidate.model}\u0000${candidate.harness ?? ''}\u0000${candidate.effort ?? ''}`;

/** The models the inventory lists, looked up the ways a model may have named one. */
class Catalog {
  constructor(private readonly models: readonly PackInventoryModel[]) {}

  exact(provider: string, id: string): readonly PackInventoryModel[] {
    return this.models.filter(model => model.provider === provider && model.id === id);
  }

  byId(id: string): readonly PackInventoryModel[] {
    return this.models.filter(model => model.id === id);
  }

  byLabel(label: string): readonly PackInventoryModel[] {
    const wanted = label.trim().toLowerCase();
    return this.models.filter(model => model.label.toLowerCase() === wanted);
  }
}

/** One candidate made to name a listed model, or the reason it cannot. */
function fixCandidate(
  candidate: GuideCandidate,
  catalog: Catalog,
  note: (message: string) => PackGuideNote,
  flagged: PackGuideNote[],
): GuideCandidate | { readonly drop: string } {
  let rows = catalog.exact(candidate.provider, candidate.model);
  let fixed: GuideCandidate = candidate;
  if (rows.length === 0) {
    const found = catalog.byId(candidate.model);
    const labelled = found.length > 0 ? found : catalog.byLabel(candidate.model);
    const first = labelled[0];
    if (first === undefined) return { drop: `${candidate.provider} ${candidate.model} is not in any catalog` };
    fixed = { ...candidate, provider: first.provider, model: first.id };
    rows = catalog.exact(first.provider, first.id);
    flagged.push(note(`named as ${candidate.provider} ${candidate.model}; it is ${first.provider} ${first.id}`));
  }
  const harnesses = new Set(rows.map(row => row.harness));
  if (fixed.harness === 'codex' && !harnesses.has('codex')) {
    const { harness: _harness, ...rest } = fixed;
    fixed = rest;
    flagged.push(note('it is not listed for Codex, so it runs on Claude Code'));
  } else if (fixed.harness === undefined && !harnesses.has('claude')) fixed = { ...fixed, harness: 'codex' };
  const row = rows.find(entry => entry.harness === (fixed.harness ?? 'claude'));
  if (fixed.effort !== undefined && row !== undefined && !row.efforts.includes(fixed.effort)) {
    const { effort, ...rest } = fixed;
    fixed = rest;
    flagged.push(
      note(
        row.efforts.length === 0
          ? `it takes no effort setting, so "${effort}" was removed`
          : `it does not take effort "${effort}" (it takes ${row.efforts.join(', ')}), so it runs at its default`,
      ),
    );
  }
  return fixed;
}

/** A use case's checked candidates, best first, each listed once and within the limit. */
function checkCandidates(
  useCase: string,
  raw: readonly unknown[],
  catalog: Catalog,
  dropped: PackGuideNote[],
  flagged: PackGuideNote[],
): readonly GuideCandidate[] {
  const seen = new Set<string>();
  const kept: GuideCandidate[] = [];
  for (const entry of raw) {
    const parsed = GuideCandidateSchema.safeParse(entry);
    if (!parsed.success) {
      dropped.push({ useCase, message: `a candidate was not the expected shape (${issueWords(parsed.error)})` });
      continue;
    }
    const note = (message: string): PackGuideNote => ({
      useCase,
      provider: parsed.data.provider,
      model: parsed.data.model,
      message,
    });
    const fixed = fixCandidate(parsed.data, catalog, note, flagged);
    if ('drop' in fixed) {
      dropped.push(note(fixed.drop));
      continue;
    }
    if (seen.has(key(fixed))) continue;
    seen.add(key(fixed));
    if (kept.length === MAX_GUIDE_CANDIDATES) {
      dropped.push(note(`past the ${String(MAX_GUIDE_CANDIDATES)} candidates a use case may list`));
      continue;
    }
    kept.push(fixed);
  }
  return kept;
}

/** An id not yet taken: the one asked for, else it with a number after it. */
function freeId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${id.slice(0, 36)}-${String(suffix)}`;
    if (!taken.has(next)) return next;
  }
}

/** Checks a draft file's text against the inventory; `bin` names the command a rendered routing prompt cites. */
export function checkDraft(text: string, inventory: PackInventory, bin: string): CheckedDraft {
  const parsed = PackGuideDraftSchema.safeParse(parseJson(text));
  if (!parsed.success)
    return { ok: false, message: 'the builder did not write a guide: its file is not a JSON object with "useCases"' };
  const catalog = new Catalog(inventory.models);
  const dropped: PackGuideNote[] = [];
  const flagged: PackGuideNote[] = [];
  const taken = new Set<string>();
  const useCases: GuideUseCase[] = [];
  for (const [index, entry] of parsed.data.useCases.entries()) {
    const shape = UseCaseShapeSchema.safeParse(entry);
    if (!shape.success) {
      dropped.push({
        message: `use case ${String(index + 1)} was not the expected shape (${issueWords(shape.error)})`,
      });
      continue;
    }
    if (useCases.length === MAX_GUIDE_USE_CASES) {
      dropped.push({
        useCase: shape.data.id,
        message: `past the ${String(MAX_GUIDE_USE_CASES)} use cases a guide may hold`,
      });
      continue;
    }
    const id = freeId(shape.data.id, taken);
    if (id !== shape.data.id) flagged.push({ useCase: id, message: `its id ${shape.data.id} was used twice` });
    taken.add(id);
    const candidates = checkCandidates(id, shape.data.candidates, catalog, dropped, flagged);
    useCases.push({ ...shape.data, id, candidates: [...candidates] });
  }
  if (useCases.length === 0) return { ok: false, message: 'the draft named no use case that could be kept' };
  const routing = GuideRoutingSchema.safeParse(parsed.data.routing);
  const labels = new Map(inventory.models.map(model => [`${model.provider}\u0000${model.id}`, model.label]));
  const fallback = (): GuideRouting =>
    renderRouting(useCases, candidate => labels.get(`${candidate.provider}\u0000${candidate.model}`), bin);
  if (!routing.success)
    flagged.push({
      message: `its routing guidance did not check (${issueWords(routing.error)}), so it was rendered from the use cases`,
    });
  const checked = { useCases, routing: routing.success ? routing.data : fallback() };
  // The pieces each checked; the whole must be a file the configuration accepts too.
  const whole = ModelsGuideFileSchema.safeParse(checked);
  if (!whole.success)
    return { ok: false, message: `the draft does not make a valid guide (${issueWords(whole.error)})` };
  return { ok: true, ...checked, dropped, flagged };
}
