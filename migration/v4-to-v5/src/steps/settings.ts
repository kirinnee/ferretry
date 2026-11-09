/**
 * Settings: v4's `config/*.yaml` → each v5 plugin's own config file (§9.2). The full per-key table is
 * `docs/migration/v4-formats.md` § "Settings mapping"; the short form:
 *
 * | v4                                     | v5                                                                  |
 * | -------------------------------------- | ------------------------------------------------------------------- |
 * | `runtimes/<n>.yaml`                    | `runtimes/<n>.yaml` (`credential` → `login`)                        |
 * | `profiles/<n>.yaml`                    | `profiles/<n>.yaml`                                                 |
 * | `components/modelSets/<n>.yaml`        | `model-sets/<n>.yaml`                                               |
 * | `components/mcp/<n>.yaml`              | `mcp/<n>.yaml`                                                      |
 * | `components/skills/<n>.yaml`           | `skills/<n>.yaml`                                                   |
 * | `components/instructions/<n>.yaml`     | `instructions/<n>.md` (the document it points at, inside the assets) |
 * | `components/settings\|hooks/<n>.yaml`  | `{claude-code,codex}/{settings,hooks}/<n>.yaml` inline (file, env, -c, --disallowedTools); else NOT CARRIED, see `planHarnessComponent` |
 * | `logins/<id>.yaml`                     | `logins/<id>.yaml`                                                  |
 * | `presets/<id>.yaml`, `models/<id>.yaml`| `endpoints/<id>.yaml`, `models/<id>.yaml`                           |
 * | `warden.yaml`                          | `warden.yaml` (`autoMigrate` → `autoMove`, v4's read-time upgrades) |
 * | `limits.yaml`                          | `limits.yaml` (+ `machine.agentControl`)                            |
 * | `account-defaults.yaml`                | `accounts.yaml`                                                     |
 * | `machine.yaml`                         | split: harness-claude-code/-codex, runtimes (+ autoResume), limits, |
 * |                                        | conversation, browsers, agenda, usage; the rest not carried (below) |
 * | `voice.yaml`                           | `voice.yaml` (Voice's `VOICE_CONFIG`)                               |
 * | `pack.yaml`, `models-guide.yaml`       | the Packs step's (`packs.yaml`)                                     |
 * | `learning.yaml`                        | the Lessons step's                                                  |
 *
 * M7: v4's config names runtimes by NAME already; a name that is only a v4 `formerNames` alias in `fleet/ids.json`
 * (`machine.defaultRuntime`, `warden.accounts[].agent`) is rewritten to the runtime's current name.
 *
 * Each file is edited as a `yaml` Document, so the owner's comments and key order are kept; v4's
 * `# yaml-language-server` modeline is dropped (v5 adds its own on the next edit, pointing at its own schemas). Every
 * file is read back as the v5 kernel reads it and parsed with the declared schema BEFORE anything is written. A value
 * that looks like a raw secret fails the step naming the file and key; `${secret:NAME}` references are kept verbatim.
 */
import { INSTRUCTION_ITEMS_FOLDER } from '@ferretry/core-ferrets/contract';
import { lstat, readFile } from 'node:fs/promises';
import { componentFileSource, instructionsSource, MAX_COMPONENT_BYTES } from './component-files.ts';
import { carryFlags, type FlagOutcome } from './component-flags.ts';
import { join } from 'node:path';
import { Document, isMap, isScalar, isSeq, Pair, type YAMLMap } from 'yaml';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  dropModeline,
  listV4Config,
  rawSecretPaths,
  readV4Yaml,
  V4_SINGLETONS,
  type V4ConfigFile,
  YAML_OPTIONS,
} from '../v4/config.ts';
import { failureNote, V4InputError } from '../v4/documents.ts';
import { CODEX_HELD_SENTENCE, PREVIEW_CODEX_RUNTIMES, PREVIEW_SETTINGS_ITEM } from '../v5/preview-env.ts';
import { runtimeIds } from '../v4/ferrets.ts';
import { CONFIG_TARGETS } from '../v5/targets.ts';
import { configPath, v5ConfigProblem, type V5ConfigTarget } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';
import { takeLoginKeys, v4VaultNames } from './login-keys.ts';

/** Every v5 file this step writes, with its owning plugin, from the one registry of targets. */
const {
  WARDEN: WARDEN_CONFIG,
  ACCOUNTS: ACCOUNTS_CONFIG,
  BROWSERS: BROWSERS_CONFIG,
  TERMINALS: TERMINALS_CONFIG,
  CODEX: CODEX_CONFIG,
  CODEX_SETTINGS,
  CODEX_HOOKS,
  CLAUDE_CODE: CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_SETTINGS,
  CLAUDE_CODE_HOOKS,
  LIMITS: LimitsConfigFile,
  AGENDA: AGENDA_CONFIG,
  CONVERSATION: CONVERSATION_CONFIG,
  ENDPOINTS: ENDPOINTS_CONFIG,
  LOGINS: LOGINS_CONFIG,
  MODELS: MODELS_CONFIG,
  MCP: MCP_CONFIG,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES: RUNTIMES_CONFIG,
  SKILLS: SKILLS_CONFIG,
  USAGE: USAGE_CONFIG,
  VOICE: VOICE_CONFIG,
} = CONFIG_TARGETS;

/** v4's `LEGACY_TRIAGE_LAYERS` and `DEFAULT_WARDEN_JEV_ACTS` (`packages/protocol/src/lib/warden.ts`). */
const LEGACY_TRIAGE_LAYERS: Readonly<Record<string, { jev: boolean; llm: boolean }>> = {
  rules: { jev: false, llm: false },
  llm: { jev: false, llm: true },
  jev: { jev: true, llm: true },
};
const V4_DEFAULT_JEV_ACTS = { nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 } as const;

/** Every top-level key of v4's strict `MachineFileSchema` (`MACHINE_SHAPE` + `advanced`). */
const V4_MACHINE_KEYS = new Set([
  'agentPermissions',
  'defaultRuntime',
  'agentControl',
  'conversations',
  'browserMode',
  'browserProxy',
  'browserPorts',
  'browserFirewallFailure',
  'autoResume',
  'attentionNudge',
  'agendaNudge',
  'agendaMode',
  'timeZone',
  'publicUsageFeed',
  'advanced',
]);

/** `machine.yaml` keys v5 declares no field for, and why (shown in the report only when the file wrote one). */
const MACHINE_NOT_CARRIED: Readonly<Record<string, string>> = {
  browserPorts: 'v5 browsers.yaml declares only mode and proxy; the browser picks its loopback ports',
  browserFirewallFailure: 'v5 browsers.yaml declares no firewall-failure switch',
  advanced: 'secretsFile, aliases, wrapper commands, usage and path.announce have no v5 config field',
  attentionNudge: 'superseded: the file also wrote agendaNudge, which v4 read instead',
};

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'config/.schema/*.json', why: 'generated editor schemas; v5 writes its own' },
  { what: "v4's # yaml-language-server modeline", why: 'it points at v4 schema ids; v5 adds its own on the next edit' },
  { what: 'config/learning.yaml', why: 'read by the Lessons step, not this one' },
  { what: 'config/pack.yaml, config/models-guide.yaml', why: 'read by the Packs step, not this one' },
  {
    what: 'config/daemon.json, config/routing.json',
    why: 'JSON daemon documents, not YAML config kinds: the Daemon settings step splits daemon.json (Gate, Connections, the harness files, Agenda), the Usage step takes the pricing and the Packs step reads routing.json',
  },
  {
    what: 'instructions component harness and clonedFrom* fields',
    why: 'a v5 instruction item is a plain markdown file with no fields',
  },
  {
    what: 'config/layout.yaml, config/layouts/, config/themes/',
    why: 'no v4 source: v4 kept no layout or theme on disk; v5 starts on its built-in layout',
  },
  {
    what: 'fleet/ids.json formerNames',
    why: 'no v5 config schema declares runtime aliases; references are rewritten to the current name instead (M7)',
  },
];

interface Planned {
  readonly target: V5ConfigTarget;
  readonly name: string | undefined;
  readonly document: Document;
  readonly from: Set<string>;
}

/** A settings or hooks component the converter cannot carry in full (rule 2 of the lead's ruling). */
interface Uncarried {
  readonly label: string;
  /** The profile layer that names it: `settings/<name>` or `hooks/<name>`. */
  readonly layer: string;
  readonly reasons: string[];
  /** Flag names only, never a value. */
  readonly flags: string[];
  /** Nothing in it for v5 to carry and nothing lost: its layer is always removed, never pending. */
  readonly empty: boolean;
}

interface Plan {
  readonly files: Map<string, Planned>;
  readonly instructions: { readonly name: string; readonly source: string; readonly from: string }[];
  readonly waiting: string[];
  readonly dropped: NotCarried[];
  readonly kept: Map<string, number>;
  readonly uncarried: Uncarried[];
}

// ── yaml Document helpers ────────────────────────────────────────────────────────────────────────────────────────

const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);
const pairOf = (map: YAMLMap, key: string): Pair | undefined => map.items.find(pair => keyOf(pair) === key);

function take(map: YAMLMap, key: string): Pair | undefined {
  const index = map.items.findIndex(pair => keyOf(pair) === key);
  if (index < 0) return undefined;
  const [pair] = map.items.splice(index, 1);
  return pair;
}

function rename(map: YAMLMap, from: string, to: string, label: string): void {
  const pair = pairOf(map, from);
  if (pair === undefined) return;
  if (pairOf(map, to) !== undefined) throw new V4InputError(`${label}: writes both ${from} and ${to}`);
  if (isScalar(pair.key)) pair.key.value = to;
  else pair.key = to;
}

/** v5 names a harness by its plugin id (`HarnessKeySchema`): v4 `claude` is `claude-code`; the `claude:` half key stays. */
const HARNESS_FIELD = new Set(['login', 'preset', 'runtime', 'mcp', 'skills']);
function harnessToV5(map: YAMLMap): void {
  const value = pairOf(map, 'harness')?.value;
  if (isScalar(value) && value.value === 'claude') value.value = 'claude-code';
}

function withKey(pair: Pair, key: string): Pair {
  const copy = pair.clone();
  if (isScalar(copy.key)) copy.key.value = key;
  else copy.key = key;
  return copy;
}

const childMap = (map: YAMLMap, key: string): YAMLMap | undefined => {
  const value = pairOf(map, key)?.value;
  return isMap(value) ? value : undefined;
};

const contents = (document: Document): YAMLMap => document.contents as YAMLMap;

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `from` of a file the preview itself creates (its header says so instead of "Carried from v4"). */
export const PREVIEW_AUTHOR = 'the preview';

/** Writes `key: value` into a planned file (made if absent), replacing whatever v4 said for that key. */
function forceFlag(plan: Plan, target: V5ConfigTarget, key: string, value: boolean): void {
  const planned = place(plan, target, undefined, PREVIEW_AUTHOR);
  if (!isMap(planned.document.contents)) planned.document.contents = planned.document.createNode({}) as YAMLMap;
  const map = contents(planned.document);
  take(map, key);
  map.items.push(new Pair(key, value));
}

function place(plan: Plan, target: V5ConfigTarget, name: string | undefined, from: string, document?: Document) {
  const path = configPath(target, name);
  const existing = plan.files.get(path);
  if (existing !== undefined) {
    if (document !== undefined) throw new V4InputError(`${from}: two v4 files map to ${path}`);
    existing.from.add(from);
    return existing;
  }
  const created: Planned = {
    target,
    name,
    document:
      document ??
      Object.assign(new Document({}, YAML_OPTIONS), {
        commentBefore:
          from === PREVIEW_AUTHOR
            ? ' Written by the 5.0 preview (not carried from v4).'
            : ` Carried from v4 ${from} by the v4 → v5 converter.`,
      }),
    from: new Set([from]),
  };
  plan.files.set(path, created);
  return created;
}

/** v4's Global lessons instructions component, which v5 replaces with lessons for every ferret. */
const LESSONS_COMPONENT = 'lessons';
const LESSONS_LAYER = `instructions/${LESSONS_COMPONENT}`;
const LESSONS_STRIPPED = 'profiles that no longer layer instructions/lessons (v5 gives lessons to every ferret)';
const LESSONS_WHY =
  'v5 gives the Global lessons document (state/lessons/global.json, from the Lessons step) to EVERY ferret, where v4 gave it only to ferrets on a profile with this layer; carrying it too would give the rules twice (lead decision 2026-11-07). It is dropped and removed from every profile';

/** Removes the `instructions/lessons` layer from a profile's `contents`; says whether it was there. */
function withoutLessonsLayer(map: YAMLMap): boolean {
  return withoutLayer(map, LESSONS_LAYER);
}

const count = (plan: Plan, what: string): void => {
  plan.kept.set(what, (plan.kept.get(what) ?? 0) + 1);
};

type Resolve = (runtime: string) => string;

/** v4's read-time upgrades of `warden.yaml` (`migrateLegacyWardenSettings`), then v5's renames. */
function wardenToV5(document: Document, label: string, resolve: Resolve): void {
  const map = contents(document);
  const triage = take(map, 'triage');
  if (triage !== undefined) {
    const value = isScalar(triage.value) ? triage.value.value : undefined;
    const layers = typeof value === 'string' ? LEGACY_TRIAGE_LAYERS[value] : undefined;
    if (layers === undefined) throw new V4InputError(`${label}: triage is not one of rules, llm, jev`);
    const stated = childMap(map, 'layers');
    const merged = { ...layers, ...((stated?.toJSON() as object | undefined) ?? {}) };
    const existing = pairOf(map, 'layers');
    if (existing === undefined) map.items.push(document.createPair('layers', merged));
    else existing.value = document.createNode(merged);
  }
  const acts = childMap(map, 'mayActAlone');
  if (acts !== undefined) {
    const resume = pairOf(acts, 'resume');
    if (resume !== undefined && pairOf(acts, 'restart') === undefined) acts.items.push(withKey(resume, 'restart'));
    if (pairOf(acts, 'stop') !== undefined && pairOf(acts, 'closeLeftovers') === undefined)
      acts.items.push(document.createPair('closeLeftovers', true));
    if (pairOf(map, 'jevActs') === undefined && pairOf(map, 'guard') !== undefined)
      map.items.push(document.createPair('jevActs', { ...V4_DEFAULT_JEV_ACTS }));
  }
  rename(map, 'autoMigrate', 'autoMove', label);
  const outage = childMap(map, 'providerOutage');
  if (outage !== undefined) rename(outage, 'minDistinctSessions', 'minDistinctFerrets', label);
  const accounts = pairOf(map, 'accounts')?.value;
  if (isSeq(accounts))
    for (const account of accounts.items) {
      const agent = isMap(account) ? pairOf(account, 'agent')?.value : undefined;
      if (isScalar(agent) && typeof agent.value === 'string') agent.value = resolve(agent.value);
    }
}

/** `machine.yaml` split key by key over the v5 files that own each setting. */
function splitMachine(plan: Plan, file: V4ConfigFile, document: Document, resolve: Resolve): void {
  const map = contents(document);
  const from = file.label;
  const into = (target: V5ConfigTarget, pair: Pair, key: string): void => {
    contents(place(plan, target, undefined, from).document).items.push(withKey(pair, key));
    count(plan, 'machine.yaml settings split out');
  };
  for (const pair of map.items) {
    const key = keyOf(pair);
    if (typeof key !== 'string' || !V4_MACHINE_KEYS.has(key))
      throw new V4InputError(`${from}: ${String(key)} is not a v4 machine setting`);
  }
  const get = (key: string): Pair | undefined => pairOf(map, key);
  const permissions = get('agentPermissions');
  if (permissions !== undefined) {
    into(CLAUDE_CODE_CONFIG, permissions, 'permissionMode');
    into(CODEX_CONFIG, permissions, 'permissionMode');
  }
  const runtime = get('defaultRuntime');
  if (runtime !== undefined) {
    const copy = withKey(runtime, 'defaultRuntime');
    if (isScalar(copy.value) && typeof copy.value.value === 'string') copy.value.value = resolve(copy.value.value);
    contents(place(plan, RUNTIMES_CONFIG, undefined, from).document).items.push(copy);
    count(plan, 'machine.yaml settings split out');
  }
  const autoResume = get('autoResume');
  if (autoResume !== undefined) into(RUNTIMES_CONFIG, autoResume, 'autoResume');
  const control = get('agentControl');
  if (control !== undefined) into(LimitsConfigFile, control, 'agentControl');
  const conversations = get('conversations');
  if (conversations !== undefined) {
    const inner = isMap(conversations.value) ? conversations.value : undefined;
    const listComputer = inner === undefined ? undefined : pairOf(inner, 'listComputer');
    if (inner === undefined || inner.items.some(pair => keyOf(pair) !== 'listComputer'))
      throw new V4InputError(`${from}: conversations is not v4's { listComputer } setting`);
    if (listComputer !== undefined) into(CONVERSATION_CONFIG, listComputer, 'keepInSync');
  }
  const mode = get('browserMode');
  if (mode !== undefined) into(BROWSERS_CONFIG, mode, 'mode');
  const proxy = get('browserProxy');
  if (proxy !== undefined) into(BROWSERS_CONFIG, proxy, 'proxy');
  const nudge = get('agendaNudge') ?? get('attentionNudge');
  if (nudge !== undefined) into(AGENDA_CONFIG, nudge, 'agendaNudge');
  const agendaMode = get('agendaMode');
  if (agendaMode !== undefined) into(AGENDA_CONFIG, agendaMode, 'agendaMode');
  const zone = get('timeZone');
  if (zone !== undefined) into(USAGE_CONFIG, zone, 'timeZone');
  const feed = get('publicUsageFeed');
  if (feed !== undefined) into(USAGE_CONFIG, feed, 'publicFeed');
  for (const [key, why] of Object.entries(MACHINE_NOT_CARRIED)) {
    if (get(key) === undefined) continue;
    if (key === 'attentionNudge' && get('agendaNudge') === undefined) continue;
    plan.dropped.push({ what: `${from} ${key}`, why });
  }
}

async function planFile(ctx: StepContext, plan: Plan, file: V4ConfigFile, resolve: Resolve): Promise<void> {
  const { address, label } = file;
  if (address.kind === 'learning' || address.kind === 'pack' || address.kind === 'modelsGuide') return;
  const document = await readV4Yaml(file);
  if (address.kind === 'component' && (address.componentKind === 'settings' || address.componentKind === 'hooks')) {
    await planHarnessComponent(ctx, plan, file, document, address.componentKind, address.name);
    return;
  }
  // A plain key in a login's env is parked for the vault and written here as a reference; any other secret-shaped value
  // (and a key when no hold exists) still fails the step below, so nothing is ever left plain.
  if (address.kind === 'login' && ctx.loginKeys !== undefined) takeLoginKeys(document, address.name, ctx.loginKeys);
  const secrets = rawSecretPaths(document.toJS());
  if (secrets.length > 0)
    throw new V4InputError(
      `${label}: the value at ${secrets.join(', ')} looks like a raw secret; store it with \`fy secret set NAME\` and write \${secret:NAME} instead`,
    );
  dropModeline(document);
  const map = contents(document);
  if (HARNESS_FIELD.has(address.kind === 'component' ? address.componentKind : address.kind)) harnessToV5(map);
  switch (address.kind) {
    case 'machine':
      splitMachine(plan, file, document, resolve);
      return;
    case 'warden':
      wardenToV5(document, label, resolve);
      place(plan, WARDEN_CONFIG, undefined, label, document);
      count(plan, 'warden.yaml');
      return;
    case 'limits':
      place(plan, LimitsConfigFile, undefined, label, document);
      count(plan, 'limits.yaml');
      return;
    case 'voice':
      place(plan, VOICE_CONFIG, undefined, label, document);
      count(plan, 'voice.yaml');
      return;
    case 'accountDefaults':
      place(plan, ACCOUNTS_CONFIG, undefined, label, document);
      count(plan, 'accounts.yaml');
      return;
    case 'login':
      place(plan, LOGINS_CONFIG, address.name, label, document);
      count(plan, 'logins');
      return;
    case 'preset':
      place(plan, ENDPOINTS_CONFIG, address.name, label, document);
      count(plan, 'endpoints (v4 presets)');
      return;
    case 'models':
      place(plan, MODELS_CONFIG, address.name, label, document);
      count(plan, 'model catalogs');
      return;
    case 'runtime':
      rename(map, 'credential', 'login', label);
      place(plan, RUNTIME_ITEMS, address.name, label, document);
      count(plan, 'runtimes');
      return;
    case 'profile':
      if (withoutLessonsLayer(map)) count(plan, LESSONS_STRIPPED);
      place(plan, PROFILE_ITEMS, address.name, label, document);
      count(plan, 'profiles');
      return;
    case 'component':
      break;
  }
  switch (address.componentKind) {
    case 'mcp':
      place(plan, MCP_CONFIG, address.name, label, document);
      count(plan, 'MCP servers');
      return;
    case 'skills':
      place(plan, SKILLS_CONFIG, address.name, label, document);
      count(plan, 'skills items');
      return;
    case 'modelSets':
      place(plan, MODEL_SET_ITEMS, address.name, label, document);
      count(plan, 'model sets');
      return;
    case 'instructions': {
      // v5 gives the Global lessons document to every ferret (the Lessons step carries it as global.json): this
      // component would give it twice (lead decision 2026-11-07), so it is dropped and every profile stops layering it.
      if (address.name === LESSONS_COMPONENT) {
        plan.dropped.push({ what: label, why: LESSONS_WHY });
        return;
      }
      const file = pairOf(map, 'file')?.value;
      const source = await instructionsSource(ctx.v4.home, isScalar(file) ? file.value : undefined);
      if (source === undefined) plan.waiting.push(`${label} (its document is not a plain file inside fleet/assets/)`);
      else plan.instructions.push({ name: address.name, source, from: label });
      return;
    }
    case 'settings':
    case 'hooks':
      return; // handled above (planHarnessComponent)
  }
}

const V5_HARNESS = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex' } as const;
const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A v4 settings or hooks component. v5 holds these INLINE in the item (`settings:` / `hooks:`), where v4 pointed at a
 * file, flags or env. `env` is data in the YAML itself and is written inline; a `file` that is a plain file under
 * `fleet/assets/` (v4's rule exactly, `component-files.ts`) is read from the snapshot and inlined; any other file is
 * NEVER opened. Codex `-c` and Claude `--disallowedTools` flags are
 * carried as settings keys; any other thing the converter cannot carry in full (another flag, an outside file, a hooks
 * directory, a secret-shaped or `${secret:...}` value, an oversize file, a v5 refusal) makes the component NOT CARRIED:
 * it is named with its flags (names only) and every profile that layers it, and `settleUncarried` decides what happens
 * to those layers (pending by default, stripped with `--drop-uncarried`).
 */
async function planHarnessComponent(
  ctx: StepContext,
  plan: Plan,
  file: V4ConfigFile,
  document: Document,
  kind: 'settings' | 'hooks',
  name: string,
): Promise<void> {
  const { label } = file;
  const v4 = document.toJS() as Record<string, unknown>;
  const entry: Uncarried = { label, layer: `${kind}/${name}`, reasons: [], flags: [], empty: false };
  const harnessName = typeof v4.harness === 'string' ? V5_HARNESS[v4.harness as keyof typeof V5_HARNESS] : undefined;
  if (harnessName === undefined) {
    entry.reasons.push(`it names no harness v5 holds ${kind} for`);
    plan.uncarried.push(entry);
    return;
  }
  const target =
    kind === 'settings'
      ? harnessName === 'codex'
        ? CODEX_SETTINGS
        : CLAUDE_CODE_SETTINGS
      : harnessName === 'codex'
        ? CODEX_HOOKS
        : CLAUDE_CODE_HOOKS;

  // The file form: only a plain, single-name file under fleet/assets/ of the v4 home snapshot is read (component-files.ts), up to the size cap.
  let fromFile: Record<string, unknown> | undefined;
  if (typeof v4.file === 'string') {
    const found = await componentFileSource(ctx, v4.file);
    if (!('source' in found))
      entry.reasons.push(
        found.refused === 'outside the v4 home'
          ? 'v4 read this file from outside its home; the preview carries only files under fleet/assets; copy it there to carry it'
          : found.refused === 'outside fleet/assets (inside the v4 home)'
            ? 'its file is inside the v4 home but outside fleet/assets, so v4 would not have read it either; copy it into fleet/assets/ and point file: at it'
            : found.refused === 'a hard link'
              ? 'its file is a hard link (v4 refused it), so it was never read; make it a plain file in fleet/assets/'
              : 'its file is not a plain file in fleet/assets/, so it was never read; copy it into fleet/assets/ and point file: at it',
      );
    else if (((await lstat(found.source).catch(() => undefined))?.size ?? 0) > MAX_COMPONENT_BYTES)
      entry.reasons.push(`its file is over ${MAX_COMPONENT_BYTES / 1024 / 1024} MiB, so it was not read`);
    else {
      try {
        const text = await readFile(found.source, 'utf8');
        const parsed: unknown =
          harnessName === 'codex' && kind === 'settings' ? Bun.TOML.parse(text) : JSON.parse(text);
        if (isRecordValue(parsed)) fromFile = parsed;
        else throw new Error('not a table');
      } catch {
        entry.reasons.push(`its file could not be read as ${kind}`);
      }
    }
  }
  if (typeof v4.directory === 'string') entry.reasons.push('a folder of hook scripts has no inline v5 form');

  // Launch flags: `-c` and `--disallowedTools` have a v5 form; the rest are named by name and hold the component.
  const flags: FlagOutcome = carryFlags(harnessName, Array.isArray(v4.flags) ? v4.flags : []);
  if (flags.superseded.length > 0)
    plan.dropped.push({
      what: `${label} flags (superseded)`,
      why: `${flags.superseded.join(', ')}: v4's own fixed layer discarded these (it decides the permission, sandbox and approval settings), so they never reached a v4 ferret; nothing is lost`,
    });
  const noForm = [...flags.uncarried];
  if (kind === 'hooks') {
    noForm.push(...flags.deny.map(() => '--disallowedTools'), ...flags.config.map(([key]) => `-c ${key}`));
  }
  if (noForm.length > 0) {
    entry.flags.push(...new Set(noForm));
    entry.reasons.push(`v5 ${kind} items hold no launch flags, and these have no inline form`);
  }

  let body: Record<string, unknown> = {};
  if (kind === 'hooks') {
    if (fromFile !== undefined) {
      const events = isRecordValue(fromFile.hooks) ? fromFile.hooks : fromFile;
      body = { hooks: events };
    }
  } else {
    const settings: Record<string, unknown> = { ...fromFile };
    if (isRecordValue(v4.env) && Object.keys(v4.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(v4.env)) {
        if (typeof value === 'string' && /\$\{secret:[^}]*\}/u.test(value))
          entry.reasons.push(
            `env ${key} is a \${secret:...} reference, which v5 resolves only in the launch environment and never inside a settings document`,
          );
        else if (typeof value === 'string') env[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
        else entry.reasons.push(`env ${key} is not text, a number or a boolean`);
      }
      if (Object.keys(env).length > 0) {
        if (harnessName === 'codex') {
          const policy = isRecordValue(settings.shell_environment_policy) ? settings.shell_environment_policy : {};
          const set = isRecordValue(policy.set) ? policy.set : {};
          settings.shell_environment_policy = { ...policy, set: { ...set, ...env } };
          plan.dropped.push({
            what: `${label} env (Codex)`,
            why: 'carried as shell_environment_policy.set, which reaches the shell commands Codex runs, NOT the Codex process itself: a variable that governed Codex own traffic (a proxy, a CA bundle) no longer does',
          });
        } else settings.env = { ...(isRecordValue(settings.env) ? settings.env : {}), ...env };
      }
    }
    if (harnessName === 'claude-code' && flags.deny.length > 0) {
      const permissions = isRecordValue(settings.permissions) ? settings.permissions : {};
      const before = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
      settings.permissions = { ...permissions, deny: [...new Set([...before, ...flags.deny])] };
    }
    if (harnessName === 'codex')
      for (const [key, value] of flags.config) {
        const parts = key.split('.');
        let node = settings;
        for (const part of parts.slice(0, -1)) {
          const next = node[part];
          node[part] = isRecordValue(next) ? { ...next } : {};
          node = node[part] as Record<string, unknown>;
        }
        node[parts[parts.length - 1] as string] = value;
      }
    if (Object.keys(settings).length > 0) body = { settings };
  }

  if (Object.keys(body).length > 0) {
    const secrets = [...rawSecretPaths(body), ...credentialShaped(body)];
    if (secrets.length > 0)
      entry.reasons.push(
        `the value at ${secrets.join(', ')} looks like a credential, so it was held; store it with \`fy secret set NAME\` and write \${secret:NAME}`,
      );
  }
  if (entry.reasons.length === 0 && Object.keys(body).length > 0) {
    const item = new Document(
      { ...(typeof v4.description === 'string' ? { description: v4.description } : {}), ...body },
      YAML_OPTIONS,
    );
    item.commentBefore = ` Carried from v4 ${label} by the v4 → v5 converter.`;
    const problem = v5ConfigProblem(target, name, item.toString({ lineWidth: 0 }));
    if (problem === undefined) {
      place(plan, target, name, label, item);
      count(plan, kind === 'settings' ? 'settings items' : 'hooks items');
      return;
    }
    entry.reasons.push(`v5 refuses it as ${kind} (${problem})`);
  }
  if (entry.reasons.length === 0) plan.uncarried.push({ ...entry, empty: true });
  else plan.uncarried.push(entry);
}

/** The key paths of a value that looks like an Authorization header: a header-named key, or `Bearer|Basic|token <16+>`. */
function credentialShaped(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: readonly string[]): void => {
    if (typeof node === 'string') {
      if (/^(Bearer|Basic|token)\s+\S{16,}/iu.test(node)) found.push(path.join('.'));
      return;
    }
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, [...path, String(index)]));
    else if (isRecordValue(node))
      for (const [key, item] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if ((lower === 'authorization' || lower.includes('header')) && item !== undefined && item !== null)
          found.push([...path, key].join('.'));
        else visit(item, [...path, key]);
      }
  };
  visit(value, []);
  return found;
}

const withoutLayer = (map: YAMLMap, layer: string): boolean => {
  const layers = pairOf(map, 'contents')?.value;
  if (!isSeq(layers)) return false;
  const before = layers.items.length;
  layers.items = layers.items.filter(item => !(isScalar(item) && item.value === layer));
  return layers.items.length !== before;
};

/**
 * Settles every not-carried component against the profiles that layer it (called last, after the preview's own holds).
 * Default: a carried profile that layers one makes the step `pending` (no home.json), so a ferret is never started
 * quietly less restricted and no layer dangles. With `--drop-uncarried` (the person running it chose it) the layer is
 * removed from each such profile, each profile named, and the report says the ferrets may be less restricted than in v4.
 */
function settleUncarried(plan: Plan, drop: boolean): void {
  for (const item of plan.uncarried) {
    const profiles: string[] = [];
    for (const file of plan.files.values()) {
      if (file.target !== PROFILE_ITEMS || file.name === undefined || !isMap(file.document.contents)) continue;
      const layers = pairOf(file.document.contents, 'contents')?.value;
      if (isSeq(layers) && layers.items.some(layer => isScalar(layer) && layer.value === item.layer))
        profiles.push(file.name);
    }
    const flagPart = item.flags.length === 0 ? '' : `; flags not carried (names only): ${[...item.flags].join(', ')}`;
    const used =
      profiles.length === 0 ? 'no carried profile layers it' : `layered by profile(s): ${profiles.join(', ')}`;
    const strip = (): void => {
      for (const file of plan.files.values())
        if (file.target === PROFILE_ITEMS && profiles.includes(file.name ?? '') && isMap(file.document.contents))
          withoutLayer(file.document.contents, item.layer);
    };
    if (item.empty) {
      strip();
      plan.dropped.push({
        what: item.label,
        why: `it holds nothing v5 can carry and nothing is lost; its layer ${item.layer} was removed from ${profiles.length === 0 ? 'no profile' : `profile(s): ${profiles.join(', ')}`}`,
      });
      continue;
    }
    const base = `NOT CARRIED: ${item.reasons.join('; ')}${flagPart}; ${used}; this may have restricted what the agent could do`;
    if (profiles.length === 0) {
      plan.dropped.push({ what: item.label, why: `${base}.` });
    } else if (drop) {
      strip();
      plan.dropped.push({
        what: item.label,
        why: `${base}. You passed --drop-uncarried: its layer ${item.layer} was REMOVED from profile(s) ${profiles.join(', ')}, so the ferrets on them may now be LESS restricted than in v4.`,
      });
    } else {
      plan.dropped.push({ what: item.label, why: `${base}.` });
      plan.waiting.push(
        `${item.label} (not carried, ${used}; fix it in v4 by copying its file into fleet/assets/ (and pointing file: at it) or removing the flag or the component, or re-run with --drop-uncarried, which removes the layer and may leave the ferrets less restricted than in v4)`,
      );
    }
  }
}

/** `codexRuntimes` is {@link PREVIEW_CODEX_RUNTIMES}; a test injects the switch on to see the Codex settings item. */
export async function buildPlan(
  ctx: StepContext,
  codexRuntimes: boolean = PREVIEW_CODEX_RUNTIMES,
): Promise<Plan & { readonly ignored: readonly string[] }> {
  let ids: Awaited<ReturnType<typeof runtimeIds>>;
  try {
    ids = await runtimeIds(ctx.v4.fleet);
  } catch {
    throw new V4InputError('fleet/ids.json: is not a valid v4 runtime id document');
  }
  const resolve: Resolve = name =>
    ids?.runtimes[name] !== undefined
      ? name
      : (Object.entries(ids?.runtimes ?? {}).find(([, entry]) => entry.formerNames.includes(name))?.[0] ?? name);
  const listing = await listV4Config(ctx.v4.home, ctx.v4.configOverrides);
  const plan: Plan = {
    files: new Map(),
    instructions: [],
    waiting: [],
    dropped: [],
    kept: new Map(),
    uncarried: [],
  };
  // machine.yaml last: it adds to files other v4 files may also own (limits.yaml).
  const machine = `config/${V4_SINGLETONS.machine}`;
  const ordered = [...listing.files].sort((a, b) => Number(a.label === machine) - Number(b.label === machine));
  for (const file of ordered) await planFile(ctx, plan, file, resolve);
  if (ctx.preview === true) {
    // The preview never resumes a ferret by itself, whatever v4's machine.yaml said (or did not say). `limits.yaml` is
    // written off too, but NOTHING relies on it: 5.0 does not read that file for launches (Ferrets offers no
    // `effectiveLimits`), so what keeps the preview off v4's systemd slices is its daemon having no reachable user
    // systemd manager (preview/driver.ts `wrapperText`, checked by `preview.sh start`).
    forceFlag(plan, RUNTIMES_CONFIG, 'autoResume', false);
    forceFlag(plan, LimitsConfigFile, 'enabled', false);
    if (ctx.previewShellEnv !== undefined) {
      // Login shells re-prepend the nix profile (v4's `fy`): every preview ferret's shell environment carries the guard.
      // 5.0's runtime and profile files are strict and hold no `env` (RuntimeFileSchema, ProfileFileSchema), so the only
      // places a converted home can carry an environment are the two harnesses' settings items: Claude Code's
      // `settings.env`, and Codex's own `shell_environment_policy.set` (Codex adds those variables to every command it
      // runs). PATH is not written: a settings environment is literal and cannot say "this first, then yours".
      const describe =
        'The 5.0 preview: keeps login shells on the preview fy (written by the preview, not carried from v4)';
      place(
        plan,
        CLAUDE_CODE_SETTINGS,
        PREVIEW_SETTINGS_ITEM,
        PREVIEW_AUTHOR,
        new Document({ description: describe, settings: { env: { ...ctx.previewShellEnv } } }, YAML_OPTIONS),
      );
      count(plan, 'preview shell environment (settings item)');
      // Terminals the daemon opens (the owner's web terminal and a ferret's) are not a harness child: they get only the
      // kernel's {PATH, HOME}, so the same environment is Terminals' own `environment`, passed to every terminal.
      place(
        plan,
        TERMINALS_CONFIG,
        undefined,
        PREVIEW_AUTHOR,
        new Document({ environment: { ...ctx.previewShellEnv } }, YAML_OPTIONS),
      );
      count(plan, 'preview terminal environment (terminals.yaml)');
      // What Codex ferrets will need once 5.0 applies Codex settings items; written only with the switch on.
      if (codexRuntimes) {
        place(
          plan,
          CODEX_SETTINGS,
          PREVIEW_SETTINGS_ITEM,
          PREVIEW_AUTHOR,
          new Document(
            { description: describe, settings: { shell_environment_policy: { set: { ...ctx.previewShellEnv } } } },
            YAML_OPTIONS,
          ),
        );
        count(plan, 'preview shell environment (settings item)');
      }
    }
    if (!codexRuntimes) holdCodexRuntimes(plan);
  }
  settleUncarried(plan, ctx.dropUncarried === true);
  return { ...plan, ignored: listing.ignored };
}

const uncount = (plan: Plan, what: string): void => {
  const left = (plan.kept.get(what) ?? 0) - 1;
  if (left > 0) plan.kept.set(what, left);
  else plan.kept.delete(what);
};

const scalarOf = (map: YAMLMap, key: string): string | undefined => {
  const value = pairOf(map, key)?.value;
  return isScalar(value) && typeof value.value === 'string' ? value.value : undefined;
};

/**
 * Preview only: leaves out every runtime that is not provably a Claude Code one, and every profile that only such
 * runtimes use. Only a runtime whose own file says `harness: claude` is kept: the preview leaves every v4 login out and
 * the owner adds logins fresh, so a runtime that does not say can become a Codex one the day its login is added.
 * Each held runtime is listed by NAME.
 */
function holdCodexRuntimes(plan: Plan): void {
  const planned = [...plan.files.entries()];
  const held = new Set<string>();
  const profilesOf = new Map<string, { held: number; kept: number }>();
  for (const [path, file] of planned) {
    if (file.target !== RUNTIME_ITEMS || file.name === undefined || !isMap(file.document.contents)) continue;
    const map = file.document.contents;
    const harness = scalarOf(map, 'harness');
    const profile = scalarOf(map, 'profile');
    const isHeld = harness !== 'claude-code';
    if (profile !== undefined) {
      const tally = profilesOf.get(profile) ?? { held: 0, kept: 0 };
      if (isHeld) tally.held++;
      else tally.kept++;
      profilesOf.set(profile, tally);
    }
    if (!isHeld) continue;
    held.add(file.name);
    plan.files.delete(path);
    uncount(plan, 'runtimes');
    plan.dropped.push({
      what: `runtime ${file.name}${harness === undefined ? ' (its file does not say which harness; the preview has no logins to tell)' : ' (Codex)'}`,
      why: CODEX_HELD_SENTENCE,
    });
  }
  for (const [path, file] of planned) {
    if (file.target !== PROFILE_ITEMS || file.name === undefined) continue;
    const tally = profilesOf.get(file.name);
    if (tally === undefined || tally.kept > 0 || tally.held === 0) continue;
    plan.files.delete(path);
    uncount(plan, 'profiles');
    plan.dropped.push({ what: `profile ${file.name} (used only by held runtimes)`, why: CODEX_HELD_SENTENCE });
  }
  for (const [, file] of planned) {
    if (file.target !== RUNTIMES_CONFIG || !isMap(file.document.contents)) continue;
    const chosen = scalarOf(file.document.contents, 'defaultRuntime');
    if (chosen === undefined || !held.has(chosen)) continue;
    take(file.document.contents, 'defaultRuntime');
    plan.dropped.push({ what: `defaultRuntime ${chosen}`, why: CODEX_HELD_SENTENCE });
  }
}

export const settingsStep: Step = {
  id: 'settings',
  title: 'Settings, runtimes, profiles, components and login files',
  owner: [
    'plugin-runtimes',
    'plugin-logins',
    'plugin-mcp',
    'plugin-skills',
    'plugin-claude-code',
    'plugin-codex',
    'plugin-warden',
    'plugin-agenda',
    'plugin-conversation',
    'plugin-browsers',
    'plugin-accounts',
    'plugin-usage',
    'core-ferrets',
  ],
  reads: [
    'config/machine.yaml',
    'config/{warden,limits,account-defaults,voice}.yaml',
    'config/{logins,runtimes,profiles,presets,models}/*.yaml',
    'config/components/<kind>/*.yaml',
    'fleet/assets/** (the documents instructions components point at)',
    'fleet/ids.json (formerNames)',
  ],
  sealed: [],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    let plan: Awaited<ReturnType<typeof buildPlan>>;
    try {
      ctx.loginKeys?.reserve(await v4VaultNames(join(ctx.v4.state, 'secrets.json')));
      plan = await buildPlan(ctx);
      for (const [path, planned] of plan.files) {
        const problem = v5ConfigProblem(planned.target, planned.name, planned.document.toString({ lineWidth: 0 }));
        if (problem !== undefined)
          throw new V4InputError(`${[...planned.from].join(' + ')}: v5 refuses it as ${path}: ${problem}`);
      }
      for (const planned of plan.files.values())
        await ctx.v5.config(planned.target, planned.name, planned.document.toString({ lineWidth: 0 }), [
          ...planned.from,
        ]);
      for (const item of plan.instructions) {
        const bytes = await readFile(item.source).catch(() => {
          throw new V4InputError(`${item.from}: its document cannot be read`);
        });
        await ctx.v5.opaque(join('config', INSTRUCTION_ITEMS_FOLDER, `${item.name}.md`), bytes);
        count(plan, 'instruction documents');
      }
    } catch (error) {
      // Nothing was finished, so no key is sealed for a file that was never written.
      ctx.loginKeys?.clear();
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'a v4 config file could not be converted'),
        kept: [],
        notCarried: this.notCarried,
      };
    }
    const kept: KeptItem[] = [...plan.kept].map(([what, n]) => ({ what, count: n }));
    const notCarried = [
      ...this.notCarried,
      ...plan.dropped,
      ...plan.ignored.map(path => ({ what: path, why: 'not a v4 config file (v4 never read it); left behind' })),
    ];
    return plan.waiting.length === 0
      ? { ...base, status: 'converted', kept, notCarried }
      : { ...base, status: 'pending', note: `waits for: ${plan.waiting.join('; ')}`, kept, notCarried };
  },
};
