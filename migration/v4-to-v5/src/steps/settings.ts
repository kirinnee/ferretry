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
 * | `components/settings\|hooks/<n>.yaml`  | waits: v5 holds settings/hooks inline, v4 points at files/flags/env |
 * | `logins/<id>.yaml`                     | `logins/<id>.yaml`                                                  |
 * | `presets/<id>.yaml`, `models/<id>.yaml`| `endpoints/<id>.yaml`, `models/<id>.yaml`                           |
 * | `warden.yaml`                          | `warden.yaml` (`autoMigrate` → `autoMove`, v4's read-time upgrades) |
 * | `limits.yaml`                          | `limits.yaml` (+ `machine.agentControl`)                            |
 * | `account-defaults.yaml`                | `accounts.yaml`                                                     |
 * | `machine.yaml`                         | split: harness-claude-code/-codex, runtimes, limits, conversation,  |
 * |                                        | browsers, agenda, usage; the rest not carried (see below)           |
 * | `voice.yaml`, `pack.yaml`, `models-guide.yaml` | waits: Voice and Packs declare no config file yet           |
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
import { CODEX_CONFIG } from '@ferretry/plugin-codex/contract';
import { CLAUDE_CODE_CONFIG } from '@ferretry/plugin-claude-code/contract';
import { INSTRUCTION_ITEMS_FOLDER, LimitsConfigFile } from '@ferretry/core-ferrets/contract';
import { AccountsConfigSchema } from '@ferretry/plugin-accounts/contract';
import { AGENDA_CONFIG } from '@ferretry/plugin-agenda/contract';
import { BrowsersConfigSchema } from '@ferretry/plugin-browsers/contract';
import { CONVERSATION_CONFIG } from '@ferretry/plugin-conversation/contract';
import { ENDPOINTS_CONFIG, LOGINS_CONFIG, MODELS_CONFIG } from '@ferretry/plugin-logins/contract';
import { MCP_CONFIG } from '@ferretry/plugin-mcp/contract';
import { MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } from '@ferretry/plugin-runtimes/contract';
import { SKILLS_CONFIG } from '@ferretry/plugin-skills/contract';
import { USAGE_CONFIG } from '@ferretry/plugin-usage/contract';
import { WardenFileSchema } from '@ferretry/plugin-warden/contract';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Document, isMap, isScalar, isSeq, type Pair, type YAMLMap } from 'yaml';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  listV4Config,
  rawSecretPaths,
  readV4Yaml,
  V4_SINGLETONS,
  type V4ConfigFile,
  YAML_OPTIONS,
} from '../v4/config.ts';
import { failureNote, V4InputError } from '../v4/documents.ts';
import { runtimeIds } from '../v4/ferrets.ts';
import { configPath, v5ConfigProblem, type V5ConfigTarget } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';

/** v5 files declared in a plugin MANIFEST (not its contract): restated with the file name and the contract's schema. */
const WARDEN_CONFIG: V5ConfigTarget = { shape: 'file', file: 'warden.yaml', schema: WardenFileSchema };
const ACCOUNTS_CONFIG: V5ConfigTarget = { shape: 'file', file: 'accounts.yaml', schema: AccountsConfigSchema };
const BROWSERS_CONFIG: V5ConfigTarget = { shape: 'file', file: 'browsers.yaml', schema: BrowsersConfigSchema };

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
  autoResume:
    'no v5 config schema declares it yet (§9.2 places auto-resume in limits.yaml; LimitsFileSchema has no key)',
  advanced: 'secretsFile, aliases, wrapper commands, usage and path.announce have no v5 config field',
  attentionNudge: 'superseded: the file also wrote agendaNudge, which v4 read instead',
};

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'config/.schema/*.json', why: 'generated editor schemas; v5 writes its own' },
  {
    what: 'state/config-accepted.json',
    why: 'v5 keeps its accepted record in host-private kernel state with no contract to write it; a v4-confirmed loosening (agentPermissions: skip, publicUsageFeed, a raised cap) is held again until the owner confirms it in v5',
  },
  { what: "v4's # yaml-language-server modeline", why: 'it points at v4 schema ids; v5 adds its own on the next edit' },
  { what: 'config/learning.yaml', why: 'read by the Lessons step, not this one' },
  {
    what: 'config/daemon.json, config/routing.json',
    why: 'JSON daemon documents, not YAML config kinds: the Daemon settings step splits their keys (Gate, Connections, the harness files, Agenda) and the Usage step takes the pricing',
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

interface Plan {
  readonly files: Map<string, Planned>;
  readonly instructions: { readonly name: string; readonly source: string; readonly from: string }[];
  readonly waiting: string[];
  readonly dropped: NotCarried[];
  readonly kept: Map<string, number>;
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

const withoutModeline = (comment: string | null | undefined): string | null => {
  if (comment === null || comment === undefined) return null;
  const kept = comment.split('\n').filter(line => !line.includes('yaml-language-server:'));
  return kept.length === 0 || kept.every(line => line.trim() === '') ? null : kept.join('\n');
};

function dropModeline(document: Document): void {
  document.commentBefore = withoutModeline(document.commentBefore);
  const map = contents(document);
  map.commentBefore = withoutModeline(map.commentBefore);
  const first = map.items[0];
  if (first !== undefined && isScalar(first.key)) first.key.commentBefore = withoutModeline(first.key.commentBefore);
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

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
        commentBefore: ` Carried from v4 ${from} by the v4 → v5 converter.`,
      }),
    from: new Set([from]),
  };
  plan.files.set(path, created);
  return created;
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

/** The asset document an instructions component points at, when it is a plain file inside `fleet/assets/`. */
async function instructionsSource(home: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || isAbsolute(value) || value.startsWith('~')) return undefined;
  const assets = join(home, 'fleet', 'assets');
  const path = normalize(join(assets, value));
  const inside = relative(assets, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  // Every folder on the way must be a real folder: a link is never followed out of the asset tree.
  let walked = assets;
  for (const part of inside.split(sep).slice(0, -1)) {
    walked = join(walked, part);
    const facts = await lstat(walked).catch(() => undefined);
    if (facts === undefined || !facts.isDirectory()) return undefined;
  }
  const facts = await lstat(path).catch(() => undefined);
  return facts?.isFile() === true ? path : undefined;
}

async function planFile(ctx: StepContext, plan: Plan, file: V4ConfigFile, resolve: Resolve): Promise<void> {
  const { address, label } = file;
  if (address.kind === 'learning') return;
  if (address.kind === 'voice' || address.kind === 'pack' || address.kind === 'modelsGuide') {
    plan.waiting.push(`${label} (no ${address.kind === 'voice' ? 'Voice' : 'Packs'} config schema yet)`);
    return;
  }
  const document = await readV4Yaml(file);
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
      const file = pairOf(map, 'file')?.value;
      const source = await instructionsSource(ctx.v4.home, isScalar(file) ? file.value : undefined);
      if (source === undefined) plan.waiting.push(`${label} (its document is not a plain file inside fleet/assets/)`);
      else plan.instructions.push({ name: address.name, source, from: label });
      return;
    }
    case 'settings':
    case 'hooks':
      plan.waiting.push(`${label} (v5 holds ${address.componentKind} inline; v4 points at a file, flags or env)`);
      return;
  }
}

async function buildPlan(ctx: StepContext): Promise<Plan & { readonly ignored: readonly string[] }> {
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
  const listing = await listV4Config(ctx.v4.home);
  const plan: Plan = { files: new Map(), instructions: [], waiting: [], dropped: [], kept: new Map() };
  // machine.yaml last: it adds to files other v4 files may also own (limits.yaml).
  const machine = `config/${V4_SINGLETONS.machine}`;
  const ordered = [...listing.files].sort((a, b) => Number(a.label === machine) - Number(b.label === machine));
  for (const file of ordered) await planFile(ctx, plan, file, resolve);
  return { ...plan, ignored: listing.ignored };
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
    'config/{warden,limits,account-defaults,voice,pack,models-guide}.yaml',
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
      plan = await buildPlan(ctx);
      for (const [path, planned] of plan.files) {
        const problem = v5ConfigProblem(planned.target, planned.name, planned.document.toString({ lineWidth: 0 }));
        if (problem !== undefined)
          throw new V4InputError(`${[...planned.from].join(' + ')}: v5 refuses it as ${path}: ${problem}`);
      }
      for (const planned of plan.files.values())
        await ctx.v5.config(planned.target, planned.name, planned.document.toString({ lineWidth: 0 }));
      for (const item of plan.instructions) {
        const bytes = await readFile(item.source).catch(() => {
          throw new V4InputError(`${item.from}: its document cannot be read`);
        });
        await ctx.v5.opaque(join('config', INSTRUCTION_ITEMS_FOLDER, `${item.name}.md`), bytes);
        count(plan, 'instruction documents');
      }
    } catch (error) {
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
