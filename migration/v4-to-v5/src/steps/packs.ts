/**
 * Packs: v4's Pack-mode configuration and state → `@ferretry/plugin-packs` (`config/packs.yaml`, `state/packs/`).
 *
 * | v4                                                 | v5 (`packages/plugins/packs/contract`)                         |
 * | -------------------------------------------------- | -------------------------------------------------------------- |
 * | `config/pack.yaml`                                 | `config/packs.yaml` top level (`PacksFileSchema`), comments kept |
 * | `config/models-guide.yaml` `prompt`, `suggested`   | `config/packs.yaml` `routing` (the same two keys, nested)      |
 * | `state/pack-guide-replaced.json` (whole file text) | `state/packs/replaced.json` (`ReplacedRoutingSchema`: the prompt) |
 * | `state/pack-guide/<id>/run.json`                   | `state/packs/runs/<id>.run.json` (`PackRunFileSchema`)         |
 * | `state/pack-guide/<id>/{rough,idea}.txt`           | `state/packs/runs/<id>.{rough,idea}.txt`, byte for byte        |
 * | `state/pack-guide/<id>/inventory.json`             | `state/packs/runs/<id>.inventory.json` (`PackInventorySchema`) |
 * | session `config.json` `pack`                       | `state/packs/switches.json` (`SwitchesSchema`)                 |
 * | `config/routing.json`, `pack-jev-spend.json`, …    | not carried, each with its reason                              |
 *
 * Format differences: every v5 JSON document has `format: 1` first (`run.json`, `replaced.json`, `switches.json`) except
 * `inventory.json`, which v5 writes and parses bare with the strict `PackInventorySchema`; v4's run FOLDERS become flat
 * `<id>.<file>` names in v5's opaque `runs/*` store; a run's `job.session` is `job.ferret` (the same id: ferret ids are
 * kept); a harness `claude` is `claude-code`; `replaced.json` `text` is the routing PROMPT the accept replaced, where
 * v4 kept the whole `models-guide.yaml` text; a switch gains `at` (v4 kept no time: the session's `updatedAt`, the
 * last time its config changed, so no earlier than the switch). A runtime NAME that is only a v4 `formerNames` alias
 * (a run's `runtime`, a suggestion's `via`) is rewritten to the runtime's current name (M7).
 *
 * Every document is parsed with the v5 contract's schema before it is written; a v4 document v4 itself would not have
 * read (a run that does not parse, a replaced guide that does not) is not carried, as v4 showed none. The report names
 * files, run ids and runtime names, never a prompt or any other value.
 */
import {
  PACK_REPLACED,
  PACK_SWITCHES,
  PackInventorySchema,
  packConfigFromFile,
  PackRunFileSchema,
  PacksFileSchema,
  ReplacedRoutingSchema,
  RoutingPromptSchema,
  SwitchesSchema,
} from '@ferretry/plugin-packs/contract';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type Document, isMap, isScalar, Pair, parseDocument, Scalar, YAMLMap } from 'yaml';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  dropModeline,
  parseV4Yaml,
  rawSecretPaths,
  readV4Yaml,
  type V4ConfigFile,
  v4ConfigFile,
  v4ConfigOverride,
  YAML_OPTIONS,
} from '../v4/config.ts';
import type { V4Paths } from '../v4/layout.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import { oldGuidePrompt, type RenderedPrompt } from '../v4/routing-prompt.ts';
import { configs, directories, json, runtimeIds } from '../v4/ferrets.ts';
import {
  V4_DEFAULT_PACK_CONFIG,
  V4_LEGACY_GUIDE_KEYS,
  V4_MODELS_GUIDE_YAML,
  V4_PACK_JEV_SPEND,
  V4_PACK_REPLACED,
  V4_PACK_RUNS,
  V4_PACK_YAML,
  V4_ROUTING_BACKUP,
  V4_ROUTING_JSON,
  V4_RUN_FILES,
  V4_RUN_ID,
  V4CleanUpRun,
  V4ReplacedGuide,
  V4RoutingCatalog,
  V4SessionPack,
} from '../v4/packs.ts';
import { CONFIG_TARGETS } from '../v5/targets.ts';
import { keyPath } from '../key-path.ts';
import { v5ConfigProblem } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';
import { heldReason, heldRuntimes, type RuntimeHarness } from './preview-hold.ts';

const PACKS_TARGET = CONFIG_TARGETS.PACKS;
const STATE = 'state/packs';
/** `packages/core/kernel/host/state/state-port.ts` `COLLECTION_NAME`: the names v5's `runs/*` store lists. */
const V5_COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;
/** `PACK_RUNS` (`runs/*`): one flat name per file, `<id>.<file>` (`daemon/adapters/run-store.ts`). */
const v5Run = (id: string, file: string): string => join(STATE, 'runs', `${id}.${file}`);

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  { what: "v4's # yaml-language-server modeline", why: 'it points at v4 schema ids; v5 adds its own on the next edit' },
];

interface Plan {
  readonly kept: Map<string, number>;
  readonly dropped: NotCarried[];
  readonly notes: string[];
  /** What to write, in order, once everything is planned and checked. */
  readonly writes: (() => Promise<void>)[];
  /** Preview only: the runtimes held out of the preview (empty otherwise); nothing that names one is carried. */
  readonly held: ReadonlyMap<string, RuntimeHarness>;
  /** Run folders that held a builder's draft.json, and runs v4 still showed as running. */
  drafts: number;
  running: number;
}

const count = (plan: Plan, what: string, n = 1): void => {
  plan.kept.set(what, (plan.kept.get(what) ?? 0) + n);
};

type Resolve = (name: string) => string;

/** The kernel stamps `format` FIRST; a parsed `.extend({format})` schema returns it last, so it is put back in front. */
const formatFirst = <Shape extends { readonly format: number }>(value: Shape): Shape => {
  const { format, ...rest } = value;
  return { format, ...rest } as Shape;
};

/** What a v4 path is, by `lstat` only: absent, a regular file, a folder, or something never followed. */
async function kind(home: string, path: string): Promise<'absent' | 'file' | 'folder' | 'other'> {
  const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new V4InputError(`${relative(home, path)}: cannot be inspected`);
  });
  if (facts === undefined) return 'absent';
  return facts.isFile() ? 'file' : facts.isDirectory() ? 'folder' : 'other';
}

const pairOf = (map: YAMLMap, key: string): Pair | undefined =>
  map.items.find(pair => (isScalar(pair.key) ? pair.key.value : pair.key) === key) as Pair | undefined;

function takeKey(map: YAMLMap, key: string): boolean {
  const index = map.items.findIndex(pair => (isScalar(pair.key) ? pair.key.value : pair.key) === key);
  if (index < 0) return false;
  map.items.splice(index, 1);
  return true;
}

const v4File = (v4: V4Paths, label: string): V4ConfigFile =>
  v4ConfigFile(v4, { kind: label === V4_PACK_YAML ? 'pack' : 'modelsGuide' }, label);

/** `kind` for a config file the run may read as an override (the enforced pass): the override says it all. */
async function configKind(v4: V4Paths, label: string): Promise<'absent' | 'file' | 'folder' | 'other'> {
  const override = v4ConfigOverride(v4, label);
  if (override !== undefined) return override === null ? 'absent' : 'file';
  return await kind(v4.home, join(v4.home, label));
}

function refuseRawSecrets(document: Document, label: string): void {
  const secrets = rawSecretPaths(document.toJS());
  if (secrets.length > 0)
    throw new V4InputError(
      `${label}: the value at ${secrets.join(', ')} looks like a raw secret; store it with \`fy secret set NAME\` and write \${secret:NAME} instead`,
    );
}

// ── packs.yaml ───────────────────────────────────────────────────────────────────────────────────────────────

/** Why an old routing key is not carried as a key: its words are in the prompt, or there was nothing to put there. */
const foldedWhy = (folded: boolean): string =>
  folded
    ? "the old guide's key, which v4 renders into the ONE routing prompt once at boot and this home had not yet: its words are rendered into routing.prompt exactly as v4 would have (see the notes); v5 reads the key itself nowhere"
    : "the old guide's key, which v4 renders into the routing prompt once at boot and this home had not yet; this home's prompt is its own (v4 never overwrote one) or the key said nothing a prompt could carry, so v5 reads it nowhere and its prompt is the file's own, else the one rendered from the model catalogs";

const KEY_FILE = { useCases: V4_MODELS_GUIDE_YAML, routing: V4_MODELS_GUIDE_YAML, routingPreferences: V4_PACK_YAML };

/**
 * v4's one-time routing conversion on one home (v4 `lib/pack/migrate.ts`, in its order): a file with no `prompt` of its
 * own gets the old use cases, routing prose and preferences rendered into ONE prompt, written FIRST in the file, and
 * the old `suggested` goes with the old guide it described. A prompt the file already holds is never overwritten.
 * The old keys themselves are taken out by the caller. Returns what was rendered, `undefined` when nothing was.
 */
function renderOldGuide(
  routing: YAMLMap,
  guideRaw: Record<string, unknown>,
  preferences: string | undefined,
  plan: Plan,
): RenderedPrompt | undefined {
  if (typeof guideRaw.prompt === 'string' || pairOf(routing, 'prompt') !== undefined) return undefined;
  const rendered = oldGuidePrompt(
    { useCases: Array.isArray(guideRaw.useCases) ? guideRaw.useCases : undefined, routing: guideRaw.routing },
    preferences,
  );
  if (rendered === undefined) return undefined;
  const value = new Scalar(rendered.text);
  if (rendered.text.includes('\n')) value.type = Scalar.BLOCK_LITERAL;
  routing.items.unshift(new Pair(new Scalar('prompt'), value));
  if (takeKey(routing, 'suggested'))
    plan.dropped.push({
      what: `${V4_MODELS_GUIDE_YAML} suggested`,
      why: 'it described the old guide, which is rendered into the prompt now (v4 removed it the same way)',
    });
  plan.notes.push(
    `routing prompt: rendered from ${rendered.used.map(key => `${KEY_FILE[key]} ${key}`).join(', ')} into one prompt exactly as v4 does once at boot${rendered.cut ? ' (cut to fit the prompt limit, use cases kept whole)' : ''}${rendered.defaultHead ? '; the model catalogs are not read here, so v4’s default prompt in front of that text is not added and v5 reads this text alone' : ''}`,
  );
  count(plan, 'routing prompt rendered from the old guide');
  return rendered;
}

/** `pack.yaml` (top level) and `models-guide.yaml` (as `routing`) → one `packs.yaml`, comments and key order kept. */
async function planConfig(
  ctx: StepContext,
  plan: Plan,
  resolve: Resolve,
  excluded: readonly string[],
): Promise<boolean> {
  const packKind = await configKind(ctx.v4, V4_PACK_YAML);
  const guideKind = await configKind(ctx.v4, V4_MODELS_GUIDE_YAML);
  if (packKind === 'absent' && guideKind === 'absent') return false;
  let appended = false;
  const document =
    packKind === 'absent' ? parseDocument('{}', YAML_OPTIONS) : await readV4Yaml(v4File(ctx.v4, V4_PACK_YAML));
  if (packKind !== 'absent') {
    refuseRawSecrets(document, V4_PACK_YAML);
    dropModeline(document);
  }
  const map = document.contents as YAMLMap;
  if (packKind === 'absent') map.flow = false;
  const preferencesValue = pairOf(map, 'routingPreferences')?.value;
  const preferences =
    isScalar(preferencesValue) && typeof preferencesValue.value === 'string' ? preferencesValue.value : undefined;
  const hasPreferences = takeKey(map, 'routingPreferences');
  if (pairOf(map, 'routing') !== undefined)
    throw new V4InputError(`${V4_PACK_YAML}: writes routing, which is not a v4 Pack setting`);
  if (packKind !== 'absent') count(plan, 'packs.yaml settings (from pack.yaml)');

  // v4's one-time routing conversion, in v4's order: the old keys are rendered into the ONE prompt first, then taken
  // out. A home with no guide file but old preferences is folded too (v4 wrote the guide file for it).
  let guide: Document | undefined;
  let guideRaw: Record<string, unknown> = {};
  let oldKeys: readonly string[] = [];
  let routing: YAMLMap | undefined;
  if (guideKind !== 'absent') {
    guide = await readV4Yaml(v4File(ctx.v4, V4_MODELS_GUIDE_YAML));
    refuseRawSecrets(guide, V4_MODELS_GUIDE_YAML);
    dropModeline(guide);
    const guideMap = guide.contents as YAMLMap;
    const parsedGuide: unknown = guide.toJS();
    guideRaw = isRecord(parsedGuide) ? parsedGuide : {};
    oldKeys = V4_LEGACY_GUIDE_KEYS.filter(key => key in guideRaw);
    routing = guideMap;
  } else if (hasPreferences) routing = new YAMLMap();
  if (routing !== undefined) {
    const rendered = renderOldGuide(routing, guideRaw, preferences, plan);
    for (const key of oldKeys) takeKey(routing, key);
    if (hasPreferences)
      plan.dropped.push({
        what: `${V4_PACK_YAML} routingPreferences`,
        why: foldedWhy(rendered?.used.includes('routingPreferences') === true),
      });
    if (oldKeys.length > 0)
      plan.dropped.push({
        what: `${V4_MODELS_GUIDE_YAML} ${oldKeys.join(', ')}`,
        why: foldedWhy(rendered !== undefined && rendered.used.some(used => used !== 'routingPreferences')),
      });
    const suggested = pairOf(routing, 'suggested')?.value;
    if (isMap(suggested)) {
      if (takeKey(suggested, 'partial'))
        plan.dropped.push({
          what: `${V4_MODELS_GUIDE_YAML} suggested.partial`,
          why: 'written by the old per-use-case review; v4 read and ignored it, and v5 has no such field',
        });
      const via = pairOf(suggested, 'via')?.value;
      if (isScalar(via) && typeof via.value === 'string') via.value = resolve(via.value);
      if (isScalar(via) && typeof via.value === 'string' && plan.held.has(via.value)) {
        takeKey(routing, 'suggested');
        plan.dropped.push({
          what: `${V4_MODELS_GUIDE_YAML} suggested (routes to the held runtime ${via.value})`,
          why: heldReason(plan.held.get(via.value) ?? 'unknown'),
        });
      }
    }
    appended = appendExcluded(routing, excluded);
    if (appended) count(plan, EXCLUDED_LINE_KEPT);
    if (routing.items.length > 0) {
      const key = new Scalar('routing');
      const comment = [guide?.commentBefore, routing.commentBefore].filter(text => text != null && text !== '');
      if (comment.length > 0) key.commentBefore = comment.join('\n');
      routing.commentBefore = null;
      map.items.push(new Pair(key, routing));
      count(plan, 'routing prompt (from models-guide.yaml)', pairOf(routing, 'prompt') === undefined ? 0 : 1);
    }
  }
  if (map.items.length === 0) return false;
  const text = document.toString({ lineWidth: 0 });
  const problem = v5ConfigProblem(PACKS_TARGET, undefined, text);
  if (problem !== undefined)
    throw new V4InputError(`${V4_PACK_YAML} + ${V4_MODELS_GUIDE_YAML}: v5 refuses it as config/packs.yaml: ${problem}`);
  // v5 must mean exactly what v4 meant: v4's defaults are v5's, so the effective settings are compared whole.
  const parsed = PacksFileSchema.parse(parseDocument(text, YAML_OPTIONS).toJS() ?? {});
  const v4Json = packKind === 'absent' ? {} : (document.toJS() as Record<string, unknown>);
  const v4Effective = {
    enabled: v4Json.enabled ?? V4_DEFAULT_PACK_CONFIG.enabled,
    decision: v4Json.decision ?? V4_DEFAULT_PACK_CONFIG.decision,
    limits: { ...V4_DEFAULT_PACK_CONFIG.limits, ...(v4Json.limits as object | undefined) },
    probe: { ...V4_DEFAULT_PACK_CONFIG.probe, ...(v4Json.probe as object | undefined) },
    jev: { ...V4_DEFAULT_PACK_CONFIG.jev, ...(v4Json.jev as object | undefined) },
  };
  if (JSON.stringify(packConfigFromFile(parsed)) !== JSON.stringify(v4Effective))
    throw new V4InputError(
      `config/packs.yaml would not mean what ${V4_PACK_YAML} meant; nothing was written (a converter defect: report it)`,
    );
  plan.writes.push(async () => await ctx.v5.config(PACKS_TARGET, undefined, text));
  return appended;
}

const EXCLUDED_LINE_KEPT = "routing prompt line naming the runtimes v4's routing.json excluded";
/** The one line added to the routing prompt (lead decision 2026-11-07, option b): names only, never a reason. */
const excludedLine = (names: readonly string[]): string =>
  `Never start a helper on these runtimes (v4's routing catalog excluded them): ${names.join(', ')}.`;

/**
 * Appends {@link excludedLine} to the guide's own `prompt`. With no prompt nothing is added: v5 then renders one from
 * the model catalogs, and a prompt holding only this line would replace that whole rendered prompt.
 */
function appendExcluded(routing: YAMLMap, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const prompt = pairOf(routing, 'prompt')?.value;
  if (!isScalar(prompt) || typeof prompt.value !== 'string' || prompt.value.trim() === '') return false;
  prompt.value = `${prompt.value.trimEnd()}\n\n${excludedLine(excluded)}`;
  prompt.type = Scalar.BLOCK_LITERAL;
  return true;
}

// ── replaced.json ────────────────────────────────────────────────────────────────────────────────────────────

/** The prompt a v4 replaced `models-guide.yaml` held: `null` for no file or no prompt, `undefined` when unreadable. */
function promptOf(text: string): string | null | undefined {
  let value: unknown;
  try {
    value = parseV4Yaml(V4_PACK_REPLACED, text).toJS();
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.prompt === undefined) return null;
  const prompt = RoutingPromptSchema.safeParse(value.prompt);
  return prompt.success ? prompt.data : undefined;
}

async function planReplaced(ctx: StepContext, plan: Plan): Promise<void> {
  const label = V4_PACK_REPLACED;
  let decoded: unknown;
  try {
    decoded = await readV4Json(ctx.v4.home, join(ctx.v4.home, label));
  } catch {
    decoded = null;
  }
  if (decoded === undefined) return;
  const lost = { what: label, why: '' };
  const v4 = V4ReplacedGuide.safeParse(decoded);
  if (!v4.success) {
    plan.dropped.push({ ...lost, why: 'it does not read as a v4 replaced guide, so v4 offered no undo either' });
    return;
  }
  const text = v4.data.text === null ? null : promptOf(v4.data.text);
  if (text === undefined || (text === null && v4.data.source === 'file')) {
    plan.dropped.push({
      ...lost,
      why: 'the file it kept holds no routing prompt v5 can put back (v5 keeps the prompt, not the file), so the one undo is lost',
    });
    return;
  }
  // Parsed whole (with its stamp) by the v5 schema, then written as the kernel lands it: `format` first.
  const { format, ...body } = ReplacedRoutingSchema.parse({
    format: PACK_REPLACED.format,
    savedAt: v4.data.savedAt,
    source: v4.data.source,
    text,
  });
  const target = {
    path: join(STATE, PACK_REPLACED.path),
    format,
    schema: ReplacedRoutingSchema.omit({ format: true }),
  };
  plan.writes.push(async () => await ctx.v5.stamped(target, body));
  count(plan, 'routing undo (replaced.json)');
  if (v4.data.text !== null)
    plan.notes.push(
      `${label}: an undo puts back the prompt only; any other key the replaced models-guide.yaml held (its suggested) is not restored`,
    );
}

// ── runs ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** v4 and v5 name the Claude harness differently in an inventory (`claude` → `claude-code`). */
function inventoryToV5(value: unknown, resolve: Resolve): unknown {
  if (!isRecord(value)) return value;
  const harness = (entry: unknown): unknown =>
    isRecord(entry) && entry.harness === 'claude' ? { ...entry, harness: 'claude-code' } : entry;
  const runtimes = Array.isArray(value.runtimes)
    ? value.runtimes.map(entry => {
        const changed = harness(entry);
        return isRecord(changed) && typeof changed.name === 'string'
          ? { ...changed, name: resolve(changed.name) }
          : changed;
      })
    : value.runtimes;
  const models = Array.isArray(value.models)
    ? value.models.map(entry => {
        const changed = harness(entry);
        if (!isRecord(changed) || !Array.isArray(changed.runtimes)) return changed;
        return {
          ...changed,
          runtimes: changed.runtimes.map(runtime =>
            isRecord(runtime) && typeof runtime.name === 'string'
              ? { ...runtime, name: resolve(runtime.name) }
              : runtime,
          ),
        };
      })
    : value.models;
  return { ...value, runtimes, models };
}

async function regularFile(home: string, path: string, label: string): Promise<Buffer | undefined> {
  const found = await kind(home, path);
  if (found === 'absent') return undefined;
  if (found !== 'file') throw new V4InputError(`${label}: is not a regular file`);
  return await readFile(path).catch(() => {
    throw new V4InputError(`${label}: cannot be read`);
  });
}

async function planRun(ctx: StepContext, plan: Plan, id: string, resolve: Resolve): Promise<void> {
  const folder = join(ctx.v4.home, V4_PACK_RUNS, id);
  const label = `${V4_PACK_RUNS}/${id}`;
  let decoded: unknown;
  try {
    decoded = await readV4Json(ctx.v4.home, join(folder, V4_RUN_FILES.run));
  } catch {
    decoded = null;
  }
  const v4 = V4CleanUpRun.safeParse(decoded);
  if (decoded === undefined || !v4.success || v4.data.job.id !== id) {
    plan.dropped.push({
      what: label,
      why:
        decoded === undefined
          ? 'a run folder with no run.json; v4 listed no run for it'
          : 'its run.json does not read as a v4 run for this folder, so v4 skipped it',
    });
    return;
  }
  if (!V5_COLLECTION_NAME.test(id)) {
    plan.dropped.push({ what: label, why: 'its id is not a name v5’s runs store can list' });
    return;
  }
  const { session, ...job } = v4.data.job;
  const via = isRecord(v4.data.suggestion?.suggested) ? v4.data.suggestion.suggested.via : undefined;
  const heldName = [job.runtime, via]
    .map(name => (typeof name === 'string' ? resolve(name) : undefined))
    .find(name => name !== undefined && plan.held.has(name));
  if (heldName !== undefined) {
    plan.dropped.push({
      what: `${label} (names the held runtime ${heldName})`,
      why: heldReason(plan.held.get(heldName) ?? 'unknown'),
    });
    return;
  }
  const suggestion =
    v4.data.suggestion !== undefined && isRecord(v4.data.suggestion.suggested)
      ? {
          ...v4.data.suggestion,
          suggested: {
            ...v4.data.suggestion.suggested,
            ...(typeof v4.data.suggestion.suggested.via === 'string'
              ? { via: resolve(v4.data.suggestion.suggested.via) }
              : {}),
          },
        }
      : v4.data.suggestion;
  const run = PackRunFileSchema.safeParse({
    format: 1,
    job: { ...job, ferret: session, runtime: resolve(job.runtime) },
    ...(suggestion === undefined ? {} : { suggestion }),
  });
  if (!run.success) {
    plan.dropped.push({
      what: label,
      why: `v5 refuses its run.json at ${run.error.issues.map(issue => keyPath(issue.path)).join(', ')}`,
    });
    return;
  }
  const writes: { file: string; bytes: string | Uint8Array }[] = [
    { file: V4_RUN_FILES.run, bytes: JSON.stringify(formatFirst(run.data)) },
  ];
  for (const file of [V4_RUN_FILES.rough, V4_RUN_FILES.idea]) {
    const bytes = await regularFile(ctx.v4.home, join(folder, file), `${label}/${file}`);
    if (bytes !== undefined) writes.push({ file, bytes });
  }
  const inventoryText = await regularFile(
    ctx.v4.home,
    join(folder, V4_RUN_FILES.inventory),
    `${label}/${V4_RUN_FILES.inventory}`,
  );
  if (inventoryText !== undefined) {
    let inventory: unknown;
    try {
      inventory = JSON.parse(inventoryText.toString('utf8'));
    } catch {
      inventory = undefined;
    }
    const parsed = PackInventorySchema.safeParse(inventoryToV5(inventory, resolve));
    if (parsed.success)
      writes.push({ file: V4_RUN_FILES.inventory, bytes: `${JSON.stringify(parsed.data, null, 2)}\n` });
    else
      plan.dropped.push({
        what: `${label}/${V4_RUN_FILES.inventory}`,
        why: 'v5 cannot read it as an inventory (v5 reads a run with none as having been shown nothing, which only matters to a run still running)',
      });
  }
  const others = (await readdir(folder)).filter(
    name =>
      !([V4_RUN_FILES.run, V4_RUN_FILES.rough, V4_RUN_FILES.idea, V4_RUN_FILES.inventory] as string[]).includes(name),
  );
  if (others.includes(V4_RUN_FILES.draft)) plan.drafts += 1;
  const strays = others.filter(name => name !== V4_RUN_FILES.draft);
  if (strays.length > 0)
    plan.dropped.push({ what: `${label}/${strays.sort().join(', ')}`, why: 'not a file of a v4 run' });
  if (run.data.job.status === 'running') plan.running += 1;
  for (const write of writes) plan.writes.push(async () => await ctx.v5.opaque(v5Run(id, write.file), write.bytes));
  count(plan, 'clean-up runs');
}

async function planRuns(ctx: StepContext, plan: Plan, resolve: Resolve): Promise<void> {
  let ids: string[];
  try {
    ids = await directories(join(ctx.v4.home, V4_PACK_RUNS));
  } catch {
    throw new V4InputError(`${V4_PACK_RUNS}: is not a folder of run folders (a link is never followed)`);
  }
  const files = (await readdir(join(ctx.v4.home, V4_PACK_RUNS)).catch(() => [])).filter(name => !ids.includes(name));
  if (files.length > 0)
    plan.dropped.push({ what: `${V4_PACK_RUNS}/${files.sort().join(', ')}`, why: 'not a v4 run folder' });
  for (const id of ids) {
    if (!V4_RUN_ID.test(id)) {
      plan.dropped.push({ what: `${V4_PACK_RUNS}/${id}`, why: 'not a v4 run id; v4 never listed it' });
      continue;
    }
    await planRun(ctx, plan, id, resolve);
  }
}

// ── switches.json ────────────────────────────────────────────────────────────────────────────────────────────

async function planSwitches(ctx: StepContext, plan: Plan): Promise<void> {
  let records: Awaited<ReturnType<typeof configs>>;
  try {
    records = await configs(ctx.v4.sessions);
  } catch {
    throw new V4InputError('state/sessions: the ferret records cannot be read (the Ferrets step names which)');
  }
  const ferrets: Record<string, { enabled: boolean; at: string }> = {};
  for (const record of records) {
    let session: { readonly pack?: boolean | undefined; readonly updatedAt: string } | undefined;
    try {
      session = await json(join(ctx.v4.sessions, record.id, 'config.json'), V4SessionPack);
    } catch {
      throw new V4InputError(`state/sessions/${record.id}/config.json: its pack switch is not a v4 one`);
    }
    if (session?.pack !== undefined) ferrets[record.id] = { enabled: session.pack, at: session.updatedAt };
  }
  const entries = Object.keys(ferrets).length;
  if (entries === 0) return;
  const document = SwitchesSchema.parse({ format: PACK_SWITCHES.format, ferrets });
  plan.writes.push(
    async () =>
      await ctx.v5.json(
        { path: join(STATE, PACK_SWITCHES.path), format: PACK_SWITCHES.format, schema: SwitchesSchema },
        document,
      ),
  );
  count(plan, 'ferret Pack switches', entries);
  const off = Object.values(ferrets).filter(entry => !entry.enabled).length;
  if (off > 0) count(plan, 'ferrets with Pack mode switched off', off);
}

// ── not carried ──────────────────────────────────────────────────────────────────────────────────────────────

/** What `config/routing.json` says, by runtime NAME (M7): `undefined` when absent, `null` when it does not parse. */
async function readRouting(ctx: StepContext, names: ReadonlyMap<string, string>) {
  let decoded: unknown;
  try {
    decoded = await readV4Json(ctx.v4.home, join(ctx.v4.home, V4_ROUTING_JSON));
  } catch {
    decoded = null;
  }
  if (decoded === undefined) return undefined;
  const parsed = V4RoutingCatalog.safeParse(decoded);
  if (!parsed.success) return null;
  const accounts = parsed.data.accounts ?? [];
  const nameOf = (id: string): string | undefined => names.get(id);
  const unknown = accounts.filter(account => nameOf(account.accountId) === undefined).length;
  const list = (filter: (account: (typeof accounts)[number]) => boolean): string[] =>
    accounts
      .filter(account => filter(account) && nameOf(account.accountId) !== undefined)
      .map(account => nameOf(account.accountId) as string)
      .sort();
  return {
    models: parsed.data.models.length,
    accounts: accounts.length,
    unknown,
    excluded: list(account => account.excludedReason !== undefined),
    preferred: list(account => account.preferredSpend === true),
  };
}
type Routing = Awaited<ReturnType<typeof readRouting>>;

/** `config/routing.json`: no v5 home. Named by runtime NAME (M7), never by value. */
function planRouting(plan: Plan, routing: Routing, appended: boolean): void {
  if (routing === undefined) return;
  if (routing === null) {
    plan.dropped.push({
      what: V4_ROUTING_JSON,
      why: 'it does not read as a v4 routing catalog, so v4 refused to recommend from it; v5 has no routing catalog',
    });
    return;
  }
  const { models, accounts, unknown, excluded, preferred } = routing;
  plan.dropped.push({
    what: `${V4_ROUTING_JSON} (${String(models)} model(s), ${String(accounts)} account(s)${unknown > 0 ? `, ${String(unknown)} naming no v4 runtime` : ''})`,
    why: 'v5 has no routing catalog (§9.2: routing.json is gone): `fy recommend` lists the models usable now and Pack mode picks by the routing prompt (packs.yaml routing.prompt), so the model scores, floors, weights, cost penalties and per-account model options have no v5 field',
  });
  if (excluded.length > 0)
    plan.dropped.push({
      what: `${V4_ROUTING_JSON} excluded runtimes: ${excluded.join(', ')}`,
      why: appended
        ? 'v4’s recommender never suggested them and v5 has no exclusion list, so one line naming them was added to the end of the routing prompt (packs.yaml routing.prompt); to stop them outright, switch each off (`disabled:` in its runtime file)'
        : 'v4’s recommender never suggested them; v5 has no exclusion list, and this home has no routing prompt of its own to add a line to (v5 renders one from the model catalogs), so switch each off (`disabled:` in its runtime file) or write a routing prompt that says so',
    });
  if (preferred.length > 0)
    plan.dropped.push({
      what: `${V4_ROUTING_JSON} preferred-spend runtimes: ${preferred.join(', ')}`,
      why: 'v5 has no spend preference; say it in the routing prompt',
    });
}

async function planLeftovers(ctx: StepContext, plan: Plan): Promise<void> {
  if ((await kind(ctx.v4.home, join(ctx.v4.home, V4_PACK_JEV_SPEND))) !== 'absent')
    plan.dropped.push({
      what: V4_PACK_JEV_SPEND,
      why: "Jev's ranking went with `fy new` to Ferrets in v5, and its daily spend ledger with it; never opened",
    });
  const backups = (await readdir(ctx.v4.state).catch(() => [])).filter(name => V4_ROUTING_BACKUP.test(name));
  if (backups.length > 0)
    plan.dropped.push({
      what: `state/pack-routing-migration-*.json (${String(backups.length)})`,
      why: 'backups of the old guide the one-time routing migration rewrote; §9.2 lists them as gone. Never opened',
    });
}

// ── the step ─────────────────────────────────────────────────────────────────────────────────────────────────

async function buildPlan(ctx: StepContext): Promise<Plan> {
  let ids: Awaited<ReturnType<typeof runtimeIds>>;
  try {
    ids = await runtimeIds(ctx.v4.fleet);
  } catch {
    throw new V4InputError('fleet/ids.json: is not a valid v4 runtime id document');
  }
  const runtimes = Object.entries(ids?.runtimes ?? {});
  const resolve: Resolve = name =>
    ids?.runtimes[name] !== undefined
      ? name
      : (runtimes.find(([, entry]) => entry.formerNames.includes(name))?.[0] ?? name);
  const names = new Map(runtimes.map(([name, entry]) => [entry.id, name]));
  const plan: Plan = {
    kept: new Map(),
    dropped: [],
    notes: [],
    writes: [],
    held: await heldRuntimes(ctx),
    drafts: 0,
    running: 0,
  };
  const routing = await readRouting(ctx, names);
  const appended = await planConfig(ctx, plan, resolve, routing?.excluded ?? []);
  await planReplaced(ctx, plan);
  await planRuns(ctx, plan, resolve);
  if (plan.drafts > 0)
    plan.dropped.push({
      what: `${V4_PACK_RUNS}/*/${V4_RUN_FILES.draft} (${String(plan.drafts)})`,
      why: 'the rewrite a v4 clean-up ferret wrote to a file; v5 takes it from the ferret’s signal done and never reads a draft file. A run already read keeps its checked suggestion in run.json',
    });
  if (plan.running > 0)
    plan.notes.push(
      `${String(plan.running)} clean-up run(s) were still running in v4: v5 settles each as failed once its ferret has finished, because a v4 builder wrote its rewrite to draft.json, which v5 does not read`,
    );
  await planSwitches(ctx, plan);
  planRouting(plan, routing, appended);
  await planLeftovers(ctx, plan);
  return plan;
}

export const packsStep: Step = {
  id: 'packs',
  title: 'Packs (Pack mode settings, the routing prompt, clean-up runs and undo, per-ferret switches)',
  owner: ['plugin-packs'],
  reads: [
    V4_PACK_YAML,
    V4_MODELS_GUIDE_YAML,
    V4_ROUTING_JSON,
    `${V4_PACK_REPLACED}`,
    `${V4_PACK_RUNS}/<id>/{run.json,rough.txt,idea.txt,inventory.json}`,
    'state/sessions/<sid>/config.json (pack)',
    'fleet/ids.json (runtime ids and formerNames)',
    `${V4_PACK_JEV_SPEND}, state/pack-routing-migration-*.json (lstat only)`,
  ],
  sealed: [],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    let plan: Plan;
    try {
      plan = await buildPlan(ctx);
      for (const write of plan.writes) await write();
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'the v4 Pack files could not be converted'),
        kept: [],
        notCarried: this.notCarried,
      };
    }
    const kept: KeptItem[] = [...plan.kept].filter(([, n]) => n > 0).map(([what, n]) => ({ what, count: n }));
    const notes = [...(ctx.dryRun ? ['dry run: nothing written'] : []), ...plan.notes];
    return {
      ...base,
      status: 'converted',
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      kept,
      notCarried: [...this.notCarried, ...plan.dropped],
    };
  },
};
