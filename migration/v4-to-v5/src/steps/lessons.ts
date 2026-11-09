/**
 * Lessons: v4's learning files → `state/lessons/` and `config/lessons.yaml` (`packages/plugins/lessons/contract`).
 *
 * | v4                                          | v5                                                                     |
 * | ------------------------------------------- | ---------------------------------------------------------------------- |
 * | `state/learning/state.json`                 | `state.json` (`scan.sessionIds` → `ferretIds`, batch `minerSessionId` → `minerFerretId`) |
 * | `state/learning/sessions.json`              | `state.json` `ferrets` (`sessionId` → `ferretId`; lead decision M5)    |
 * | `state/learning/observations.jsonl`         | `observations.jsonl`, line for line (`sessionId` → `ferretId`)         |
 * | `state/learning/proposals.json` (an array)  | `suggested.json` `{proposals}`, every state (v5 keeps rejected ones there too) |
 * | `state/learning/tombstones.json` (an array) | `dismissed.json` `{tombstones}`                                        |
 * | `state/learning/runs/<run>/manifest.json`   | `runs/<run>.json` (`sessions*` → `ferrets*`, `minerSessions` → `minerFerrets`, `perHarness.claude` → `claude-code`) |
 * | `state/learning/runs/<run>/digests.json`    | `digests/<run>.json` `{digests}`, for a run v5 may still ingest (unfinished) |
 * | `state/learning/patches/<name>.md`          | `patches/<name>.json` `{contents}`                                     |
 * | the Global lessons document (the `lessons` instructions component's file, else `fleet/assets/instructions/lessons.md`) | `global.json` `{text}` |
 * | `config/learning.yaml`                      | `config/lessons.yaml` (`maxSessionsPerRun` → `maxFerretsPerRun`, comments kept) |
 *
 * Ferret ids are unchanged, so every `sessionId` becomes the same `ferretId`. A Global lesson's target and applied path
 * named v4's asset file; v5 names that document `Global lessons document` (its `target.path` and `applied.path`), so
 * both, and the `applied` history note that repeated the path, are rewritten. Repo lessons keep their project paths.
 *
 * v4 read these files leniently (`file-store.ts`: a damaged document as empty, one bad record costs that record
 * alone, a bad JSONL line is skipped), so the step carries exactly what v4 read and counts what it dropped, never
 * quoting it. A link or folder in a file's place fails the step by name. Every document is parsed by its v5 schema
 * before it is written; the kernel's `format: 1` stamp is written first on each document and each JSONL line.
 *
 * M7: none of these files holds a runtime uuid. `learning.yaml` `agent` names a runtime; a v4 `formerNames` alias is
 * rewritten to the current name, as the Settings step does.
 */
import {
  DigestsFileSchema,
  DIGESTS_FILE,
  DismissedFileSchema,
  DISMISSED_FILE,
  GLOBAL_FILE,
  GLOBAL_LESSONS_DOCUMENT,
  GlobalDocumentSchema,
  LessonsStateFileSchema,
  OBSERVATIONS_FILE,
  ObservationSchema,
  PATCH_FILE,
  PatchFileSchema,
  RUN_FILE,
  RunManifestSchema,
  STATE_FILE,
  StoredProposalSchema,
  SuggestedFileSchema,
  SUGGESTED_FILE,
  TombstoneSchema,
  StoredFerretLessonsSchema,
} from '@ferretry/plugin-lessons/contract';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { isMap, isScalar, type Pair, type YAMLMap } from 'yaml';
import { z } from 'zod';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import { rawSecretPaths, readV4Yaml, v4ConfigFile, v4ConfigOverride } from '../v4/config.ts';
import type { V4Paths } from '../v4/layout.ts';
import { failureNote, V4InputError } from '../v4/documents.ts';
import { runtimeIds } from '../v4/ferrets.ts';
import {
  V4_GLOBAL_LESSONS_FILE,
  V4_LEARNING_CONFIG,
  V4_LEARNING_KEYS,
  V4_LEARNING_OBSERVATIONS,
  V4_LEARNING_PATCHES,
  V4_LEARNING_PROPOSALS,
  V4_LEARNING_RUNS,
  V4_LEARNING_SESSIONS,
  V4_LEARNING_STATE,
  V4_LEARNING_TOMBSTONES,
  V4_LESSONS_COMPONENT,
  V4_RUN_ID,
  V4LearningState,
  V4Observation,
  V4RunManifest,
  V4SessionDigest,
  V4SessionLearning,
  V4StoredProposal,
  V4Tombstone,
  type V4LearningState as V4LearningStateValue,
  type V4RunManifest as V4RunManifestValue,
  type V4StoredProposal as V4StoredProposalValue,
} from '../v4/lessons.ts';
import { CONFIG_TARGETS } from '../v5/targets.ts';
import { configPath, v5ConfigProblem } from '../v5/write.ts';

const LESSONS_CONFIG = CONFIG_TARGETS.LESSONS;
import { dropModeline } from '../v4/config.ts';
import { instructionsSource } from './settings.ts';
import type { Step, StepContext } from './index.ts';

const V5_DIR = 'state/lessons';
export const V5_LESSONS_STATE = join(V5_DIR, STATE_FILE.path);
export const V5_LESSONS_OBSERVATIONS = join(V5_DIR, OBSERVATIONS_FILE.path);
export const V5_LESSONS_SUGGESTED = join(V5_DIR, SUGGESTED_FILE.path);
export const V5_LESSONS_DISMISSED = join(V5_DIR, DISMISSED_FILE.path);
export const V5_LESSONS_GLOBAL = join(V5_DIR, GLOBAL_FILE.path);
export const v5LessonsRun = (run: string): string => join(V5_DIR, 'runs', `${run}.json`);
export const v5LessonsDigests = (run: string): string => join(V5_DIR, 'digests', `${run}.json`);
export const v5LessonsPatch = (name: string): string => join(V5_DIR, 'patches', `${name}.json`);

/**
 * The kernel's collection-item name rule (`kernel/host/state/state-port.ts` `COLLECTION_NAME`, host-private, so it is
 * restated): a run or patch whose name breaks it could not be listed or read by v5.
 */
const V5_ITEM_NAME = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;
/** The kernel's per-record bound (`kernel/host/state/jsonl-scan.ts` `MAX_JSONL_RECORD_BYTES`). */
const V5_MAX_JSONL_LINE_BYTES = 1 << 20;

/** One `observations.jsonl` line as written: the kernel's stamp first, then v5's `ObservationSchema`. */
export const V5ObservationLineSchema = z.object({ format: z.literal(1) }).extend(ObservationSchema.shape);

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  {
    what: `${V4_LEARNING_RUNS}/<run>/observations.json (a miner's raw output)`,
    why: 'v5 reads a miner’s output only from that miner ferret’s own folder; what v4 ingested is already in observations.jsonl and suggested.json, and a run left unfinished is marked failed when v5 collects it',
  },
  {
    what: `${V4_LEARNING_RUNS}/<run>/digests.json of a finished run`,
    why: 'v5 reads a run’s digests only to ingest an unfinished run; a finished run’s manifest is carried',
  },
  {
    what: 'a damaged learning document, record or line',
    why: 'v4 read it as empty or skipped it (and its next save deleted it), so it is not carried; counted, never quoted',
  },
  {
    what: `a ${V4_LEARNING_RUNS} entry whose name is not a path-safe run id, or any other file in a run folder`,
    why: 'v4 never read it (runPath refused the name; only manifest.json, digests.json and observations.json are read)',
  },
  {
    what: `a ${V4_LEARNING_PATCHES} file that is not <name>.md with a name v5 can store`,
    why: 'v4 wrote only <slug>-<time>.md; anything else is not one of its patches',
  },
  { what: `${V4_LEARNING_CONFIG}'s # yaml-language-server modeline`, why: 'it points at a v4 schema id' },
];

type Lenient<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'read'; readonly value: T };

/** A v4 file's text, or `undefined` when absent. A link, folder or unreadable file fails the step by its name. */
async function v4Text(home: string, path: string): Promise<string | undefined> {
  const facts = await lstat(join(home, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new V4InputError(`${path}: cannot be inspected`);
  });
  if (facts === undefined) return undefined;
  if (!facts.isFile()) throw new V4InputError(`${path}: is not a regular file`);
  try {
    return await readFile(join(home, path), 'utf8');
  } catch {
    throw new V4InputError(`${path}: cannot be read`);
  }
}

/** Whether a v4 config file exists as this run reads it: an override (the enforced pass) says so, else the disk does. */
async function configPresent(v4: V4Paths, label: string): Promise<boolean> {
  const override = v4ConfigOverride(v4, label);
  return override !== undefined ? override !== null : (await v4Text(v4.home, label)) !== undefined;
}

/** A v4 learning document as `decodeJson` read it: absent, unparsable (`damaged`), or the parsed value. */
async function v4Json(home: string, path: string): Promise<Lenient<unknown>> {
  const text = await v4Text(home, path);
  if (text === undefined) return { kind: 'absent' };
  try {
    return { kind: 'read', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'damaged' };
  }
}

/** `decodeEach`: a non-array is no records; each record that fails its schema costs that record alone. */
function each<T>(value: unknown, schema: z.ZodType<T, unknown>): { readonly records: T[]; readonly dropped: number } {
  if (!Array.isArray(value)) return { records: [], dropped: 0 };
  const records: T[] = [];
  let dropped = 0;
  for (const entry of value) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) records.push(parsed.data);
    else dropped++;
  }
  return { records, dropped };
}

/** The first schema issue's path, for an error that names where a value is wrong without quoting it. */
const where = (error: z.ZodError): string => error.issues[0]?.path.join('.') || '(top)';

function stateToV5(state: V4LearningStateValue): Record<string, unknown> {
  const { scan, ...rest } = state;
  if (scan === undefined) return rest;
  const { sessionIds, batches, ...scanRest } = scan;
  return {
    ...rest,
    scan: {
      ...scanRest,
      ferretIds: sessionIds,
      batches: batches.map(batch => ({
        ...(batch.minerSessionId === undefined ? {} : { minerFerretId: batch.minerSessionId }),
        ferretIds: batch.sessionIds,
      })),
    },
  };
}

/** A Global lesson names v5's Global lessons document instead of v4's asset file; a repo lesson is unchanged. */
export function proposalToV5(proposal: V4StoredProposalValue): Record<string, unknown> {
  if (proposal.target.kind !== 'global-instructions') return proposal;
  const before = proposal.applied?.path;
  return {
    ...proposal,
    target: { ...proposal.target, path: GLOBAL_LESSONS_DOCUMENT },
    ...(proposal.applied === undefined ? {} : { applied: { ...proposal.applied, path: GLOBAL_LESSONS_DOCUMENT } }),
    history: proposal.history.map(entry =>
      before !== undefined && entry.event === 'applied' && entry.note === before
        ? { ...entry, note: GLOBAL_LESSONS_DOCUMENT }
        : entry,
    ),
  };
}

function manifestToV5(manifest: V4RunManifestValue): Record<string, unknown> {
  const { sessionsScanned, sessionsWithSignal, minerSessions, perHarness, ...rest } = manifest;
  return {
    ...rest,
    ferretsScanned: sessionsScanned,
    ferretsWithSignal: sessionsWithSignal,
    minerFerrets: minerSessions,
    perHarness: { 'claude-code': perHarness.claude, codex: perHarness.codex },
  };
}

interface Tally {
  readonly kept: KeptItem[];
  readonly notes: string[];
}

const keep = (tally: Tally, what: string, count: number): void => {
  tally.kept.push({ what, count });
};
const dropped = (tally: Tally, file: string, count: number, what: string): void => {
  if (count > 0) tally.notes.push(`${file}: ${String(count)} damaged ${what} not carried (v4 skipped them too)`);
};

async function convertState(ctx: StepContext, tally: Tally): Promise<void> {
  const home = ctx.v4.home;
  const state = await v4Json(home, V4_LEARNING_STATE);
  const sessions = await v4Json(home, V4_LEARNING_SESSIONS);
  if (state.kind === 'absent' && sessions.kind === 'absent') return;
  let body: Record<string, unknown> = {};
  if (state.kind === 'read') {
    const parsed = V4LearningState.safeParse(state.value);
    if (parsed.success) body = stateToV5(parsed.data);
    else tally.notes.push(`${V4_LEARNING_STATE} is damaged: v4 read it as no watermark and no scan`);
  } else if (state.kind === 'damaged')
    tally.notes.push(`${V4_LEARNING_STATE} is damaged: v4 read it as no watermark and no scan`);
  const switches = each(sessions.kind === 'read' ? sessions.value : undefined, V4SessionLearning);
  if (sessions.kind === 'damaged' || (sessions.kind === 'read' && !Array.isArray(sessions.value)))
    tally.notes.push(`${V4_LEARNING_SESSIONS} is damaged: v4 read it as no per-ferret switches`);
  dropped(tally, V4_LEARNING_SESSIONS, switches.dropped, 'switch record(s)');
  const ferrets = switches.records.map(({ sessionId, ...rest }) => ({ ferretId: sessionId, ...rest }));
  for (const [index, record] of ferrets.entries()) {
    const parsed = StoredFerretLessonsSchema.safeParse(record);
    if (!parsed.success)
      throw new V4InputError(`${V4_LEARNING_SESSIONS}: entry ${String(index)} has no v5 form (${where(parsed.error)})`);
  }
  const document = LessonsStateFileSchema.safeParse({ ...body, ferrets });
  if (!document.success) throw new V4InputError(`${V4_LEARNING_STATE}: has no v5 form at ${where(document.error)}`);
  await ctx.v5.stamped(
    { path: V5_LESSONS_STATE, format: STATE_FILE.format, schema: LessonsStateFileSchema },
    document.data,
  );
  keep(tally, 'learning state (watermark, newest scan)', state.kind === 'read' ? 1 : 0);
  keep(tally, 'per-ferret lesson switches', ferrets.length);
}

async function convertObservations(ctx: StepContext, tally: Tally): Promise<void> {
  const text = await v4Text(ctx.v4.home, V4_LEARNING_OBSERVATIONS);
  if (text === undefined) return;
  const lines: z.infer<typeof V5ObservationLineSchema>[] = [];
  let skipped = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    const value = raw.trim();
    if (value.length === 0) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      skipped++;
      continue;
    }
    const parsed = V4Observation.safeParse(decoded);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const { sessionId, ...rest } = parsed.data;
    const line = V5ObservationLineSchema.safeParse({ format: 1, ...rest, ferretId: sessionId });
    if (!line.success) throw new V4InputError(`${V4_LEARNING_OBSERVATIONS}: line ${String(index + 1)} has no v5 form`);
    if (Buffer.byteLength(JSON.stringify(line.data), 'utf8') > V5_MAX_JSONL_LINE_BYTES)
      throw new V4InputError(`${V4_LEARNING_OBSERVATIONS}: line ${String(index + 1)} is longer than a v5 line may be`);
    lines.push(line.data);
  }
  dropped(tally, V4_LEARNING_OBSERVATIONS, skipped, 'evidence line(s)');
  if (lines.length > 0)
    await ctx.v5.jsonl(
      { path: V5_LESSONS_OBSERVATIONS, format: OBSERVATIONS_FILE.format, schema: V5ObservationLineSchema },
      lines,
    );
  keep(tally, 'evidence observations', lines.length);
}

async function convertBoard(ctx: StepContext, tally: Tally): Promise<void> {
  const home = ctx.v4.home;
  const proposals = await v4Json(home, V4_LEARNING_PROPOSALS);
  if (proposals.kind !== 'absent') {
    if (proposals.kind === 'damaged' || !Array.isArray(proposals.value))
      tally.notes.push(`${V4_LEARNING_PROPOSALS} is damaged: v4 read it as no lessons`);
    const read = each(proposals.kind === 'read' ? proposals.value : undefined, V4StoredProposal);
    dropped(tally, V4_LEARNING_PROPOSALS, read.dropped, 'lesson(s)');
    const v5 = read.records.map(proposal => {
      const parsed = StoredProposalSchema.safeParse(proposalToV5(proposal));
      if (!parsed.success)
        throw new V4InputError(
          `${V4_LEARNING_PROPOSALS}: lesson ${proposal.id} has no v5 form (${where(parsed.error)})`,
        );
      return parsed.data;
    });
    await ctx.v5.stamped(
      { path: V5_LESSONS_SUGGESTED, format: SUGGESTED_FILE.format, schema: SuggestedFileSchema },
      { proposals: v5 },
    );
    for (const state of ['pending', 'accepted', 'applied', 'rejected'] as const)
      keep(tally, `${state} lessons`, v5.filter(proposal => proposal.state === state).length);
  }
  const tombstones = await v4Json(home, V4_LEARNING_TOMBSTONES);
  if (tombstones.kind !== 'absent') {
    if (tombstones.kind === 'damaged' || !Array.isArray(tombstones.value))
      tally.notes.push(`${V4_LEARNING_TOMBSTONES} is damaged: v4 read it as no dismissed lessons`);
    const read = each(tombstones.kind === 'read' ? tombstones.value : undefined, V4Tombstone);
    dropped(tally, V4_LEARNING_TOMBSTONES, read.dropped, 'dismissed lesson(s)');
    const v5 = read.records.map((tombstone, index) => {
      const parsed = TombstoneSchema.safeParse(tombstone);
      if (!parsed.success) throw new V4InputError(`${V4_LEARNING_TOMBSTONES}: entry ${String(index)} has no v5 form`);
      return parsed.data;
    });
    await ctx.v5.stamped(
      { path: V5_LESSONS_DISMISSED, format: DISMISSED_FILE.format, schema: DismissedFileSchema },
      { tombstones: v5 },
    );
    keep(tally, 'dismissed lessons (never suggested again)', v5.length);
  }
}

/** The names in a v4 folder, or none when it is absent. A link or file in its place fails by name. */
async function folder(home: string, path: string): Promise<string[]> {
  const facts = await lstat(join(home, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new V4InputError(`${path}: cannot be inspected`);
  });
  if (facts === undefined) return [];
  if (!facts.isDirectory()) throw new V4InputError(`${path}: is not a folder`);
  return (await readdir(join(home, path))).sort();
}

async function convertRuns(ctx: StepContext, tally: Tally): Promise<void> {
  const home = ctx.v4.home;
  let runs = 0;
  let digests = 0;
  let ignored = 0;
  let damaged = 0;
  let rawOutputs = 0;
  for (const run of await folder(home, V4_LEARNING_RUNS)) {
    const at = `${V4_LEARNING_RUNS}/${run}`;
    const facts = await lstat(join(home, at));
    if (!facts.isDirectory() || !V4_RUN_ID.test(run) || !V5_ITEM_NAME.test(run)) {
      ignored++;
      continue;
    }
    const files = await folder(home, at);
    ignored += files.filter(name => !['manifest.json', 'digests.json', 'observations.json'].includes(name)).length;
    if (files.includes('observations.json')) rawOutputs++;
    const read = await v4Json(home, `${at}/manifest.json`);
    const v4 = read.kind === 'read' ? V4RunManifest.safeParse(read.value) : undefined;
    if (v4 === undefined || !v4.success) {
      // v4 read a missing or damaged manifest as no run (`readRunManifest` → undefined).
      if (read.kind !== 'absent') damaged++;
      continue;
    }
    const manifest = RunManifestSchema.safeParse(manifestToV5(v4.data));
    if (!manifest.success)
      throw new V4InputError(`${at}/manifest.json: run ${run} has no v5 form (${where(manifest.error)})`);
    await ctx.v5.stamped(
      { path: v5LessonsRun(run), format: RUN_FILE.format, schema: RunManifestSchema },
      manifest.data,
    );
    runs++;
    if (manifest.data.finishedAt !== undefined) continue;
    const digest = await v4Json(home, `${at}/digests.json`);
    if (digest.kind === 'absent') continue;
    const records = digest.kind === 'read' ? each(digest.value, V4SessionDigest) : undefined;
    if (
      records === undefined ||
      !Array.isArray(digest.kind === 'read' ? digest.value : undefined) ||
      records.dropped > 0
    ) {
      // v4's miner cast the file unchecked; one it could not have used is not carried, and the run cannot ingest.
      damaged++;
      continue;
    }
    const document = DigestsFileSchema.safeParse({
      digests: records.records.map(({ sessionId, ...rest }) => ({ ferretId: sessionId, ...rest })),
    });
    if (!document.success)
      throw new V4InputError(`${at}/digests.json: run ${run} has no v5 form (${where(document.error)})`);
    await ctx.v5.stamped(
      { path: v5LessonsDigests(run), format: DIGESTS_FILE.format, schema: DigestsFileSchema },
      document.data,
    );
    digests++;
  }
  keep(tally, 'scan run manifests', runs);
  keep(tally, 'digests of unfinished runs', digests);
  if (damaged > 0) tally.notes.push(`${String(damaged)} damaged run manifest(s) or digest file(s) not carried`);
  if (ignored > 0) tally.notes.push(`${String(ignored)} file(s) under ${V4_LEARNING_RUNS} v4 never read, left behind`);
  if (rawOutputs > 0) tally.notes.push(`${String(rawOutputs)} raw miner output file(s) not carried`);
}

async function convertPatches(ctx: StepContext, tally: Tally): Promise<void> {
  const home = ctx.v4.home;
  let patches = 0;
  let ignored = 0;
  for (const entry of await folder(home, V4_LEARNING_PATCHES)) {
    const name = entry.endsWith('.md') ? entry.slice(0, -'.md'.length) : undefined;
    const facts = await lstat(join(home, V4_LEARNING_PATCHES, entry));
    if (name === undefined || !facts.isFile() || !V5_ITEM_NAME.test(name)) {
      ignored++;
      continue;
    }
    const contents = (await v4Text(home, `${V4_LEARNING_PATCHES}/${entry}`)) ?? '';
    await ctx.v5.stamped(
      { path: v5LessonsPatch(name), format: PATCH_FILE.format, schema: PatchFileSchema },
      { contents },
    );
    patches++;
  }
  keep(tally, 'lesson patches', patches);
  if (ignored > 0)
    tally.notes.push(`${String(ignored)} file(s) under ${V4_LEARNING_PATCHES} that are not patches left behind`);
}

const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);

/** The document v4's `FleetGlobalLessons.locate` reads: the component's `file`, else `instructions/lessons.md`. */
async function globalSource(ctx: StepContext): Promise<string | undefined> {
  const home = ctx.v4.home;
  let file: unknown = V4_GLOBAL_LESSONS_FILE;
  if (await configPresent(ctx.v4, V4_LESSONS_COMPONENT)) {
    const document = await readV4Yaml(
      v4ConfigFile(ctx.v4, { kind: 'component', componentKind: 'instructions', name: 'lessons' }, V4_LESSONS_COMPONENT),
    );
    const pair = (document.contents as YAMLMap).items.find(item => keyOf(item) === 'file');
    file = isScalar(pair?.value) ? pair.value.value : undefined;
  }
  const source = await instructionsSource(home, file);
  if (source !== undefined) return source;
  // Not found as a plain file inside the assets: absent is no document (v4 read it as empty); anything else is refused.
  const assets = join(home, 'fleet', 'assets');
  if (typeof file === 'string' && !isAbsolute(file) && !file.startsWith('~')) {
    const inside = relative(assets, normalize(join(assets, file)));
    if (inside !== '' && !inside.startsWith(`..${sep}`) && inside !== '..') {
      const missing = await lstat(join(assets, inside)).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      if (missing) return undefined;
    }
  }
  throw new V4InputError(
    `${V4_LESSONS_COMPONENT}: the Global lessons document it names is not a plain file inside fleet/assets/; copy it to fleet/assets/${V4_GLOBAL_LESSONS_FILE}, point the component's file at ${V4_GLOBAL_LESSONS_FILE} and run the conversion again`,
  );
}

async function convertGlobal(ctx: StepContext, tally: Tally): Promise<void> {
  const source = await globalSource(ctx);
  if (source === undefined) return;
  const label = relative(ctx.v4.home, source);
  let text: string;
  try {
    text = await readFile(source, 'utf8');
  } catch {
    throw new V4InputError(`${label}: cannot be read`);
  }
  await ctx.v5.stamped({ path: V5_LESSONS_GLOBAL, format: GLOBAL_FILE.format, schema: GlobalDocumentSchema }, { text });
  keep(tally, 'Global lessons document', 1);
  keep(tally, 'Global lesson rules', text.split('\n').filter(line => line.startsWith('- ')).length);
}

async function convertConfig(ctx: StepContext, tally: Tally): Promise<void> {
  if (!(await configPresent(ctx.v4, V4_LEARNING_CONFIG))) return;
  const document = await readV4Yaml(v4ConfigFile(ctx.v4, { kind: 'learning' }, V4_LEARNING_CONFIG));
  const secrets = rawSecretPaths(document.toJS());
  if (secrets.length > 0)
    throw new V4InputError(`${V4_LEARNING_CONFIG}: the value at ${secrets.join(', ')} looks like a raw secret`);
  dropModeline(document);
  const map = document.contents as YAMLMap;
  if (!isMap(map)) throw new V4InputError(`${V4_LEARNING_CONFIG}: is not a YAML mapping`);
  for (const pair of map.items) {
    const key = keyOf(pair);
    if (typeof key !== 'string' || !(V4_LEARNING_KEYS as readonly string[]).includes(key))
      throw new V4InputError(`${V4_LEARNING_CONFIG}: ${String(key)} is not a v4 learning setting`);
  }
  const limit = map.items.find(pair => keyOf(pair) === 'maxSessionsPerRun');
  if (limit !== undefined) {
    if (isScalar(limit.key)) limit.key.value = 'maxFerretsPerRun';
    else limit.key = 'maxFerretsPerRun';
  }
  const agent = map.items.find(pair => keyOf(pair) === 'agent')?.value;
  if (isScalar(agent) && typeof agent.value === 'string') {
    let ids: Awaited<ReturnType<typeof runtimeIds>>;
    try {
      ids = await runtimeIds(ctx.v4.fleet);
    } catch {
      throw new V4InputError('fleet/ids.json: is not a valid v4 runtime id document');
    }
    const name = agent.value;
    if (ids?.runtimes[name] === undefined) {
      const current = Object.entries(ids?.runtimes ?? {}).find(([, entry]) => entry.formerNames.includes(name))?.[0];
      if (current !== undefined) agent.value = current;
    }
  }
  const text = document.toString({ lineWidth: 0 });
  const problem = v5ConfigProblem(LESSONS_CONFIG, undefined, text);
  if (problem !== undefined)
    throw new V4InputError(`${V4_LEARNING_CONFIG}: v5 refuses it as ${configPath(LESSONS_CONFIG)}: ${problem}`);
  await ctx.v5.config(LESSONS_CONFIG, undefined, text);
  keep(tally, 'lessons.yaml settings', map.items.length);
}

export const lessonsStep: Step = {
  id: 'lessons',
  title: 'Lessons (suggested and dismissed lessons, evidence, scan runs, per-ferret switch, Global lessons)',
  owner: ['plugin-lessons'],
  reads: [
    V4_LEARNING_STATE,
    V4_LEARNING_SESSIONS,
    V4_LEARNING_OBSERVATIONS,
    V4_LEARNING_PROPOSALS,
    V4_LEARNING_TOMBSTONES,
    `${V4_LEARNING_RUNS}/<run>/{manifest,digests}.json`,
    `${V4_LEARNING_PATCHES}/*.md`,
    `${V4_LESSONS_COMPONENT} (file) and the Global lessons document it names (default fleet/assets/${V4_GLOBAL_LESSONS_FILE})`,
    V4_LEARNING_CONFIG,
    'fleet/ids.json (formerNames)',
  ],
  sealed: [],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    const tally: Tally = { kept: [], notes: ctx.dryRun ? ['dry run: nothing written'] : [] };
    try {
      await convertState(ctx, tally);
      await convertObservations(ctx, tally);
      await convertBoard(ctx, tally);
      await convertRuns(ctx, tally);
      await convertPatches(ctx, tally);
      await convertGlobal(ctx, tally);
      await convertConfig(ctx, tally);
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the learning files'), kept: [] };
    }
    return {
      ...base,
      status: 'converted',
      ...(tally.notes.length > 0 ? { note: tally.notes.join('; ') } : {}),
      kept: tally.kept,
    };
  },
};
