/**
 * Daemon settings: v4's JSON daemon document → the v5 config files that own each key (§9.2: `daemon.json` is gone in
 * v5, split by owner; `routing.json` is the Packs step's). The full per-key table is `docs/migration/v4-formats.md` §5a; the
 * short form:
 *
 * | v4                                                   | v5                                                                |
 * | ---------------------------------------------------- | ----------------------------------------------------------------- |
 * | `daemon.json` `grants`                               | `gate.yaml` `grants`: all eight capabilities, both axes, EXPLICIT |
 * | `state/security.json` `settings`                     | `gate.yaml` `security`, explicit (v4's default or strictest)      |
| `daemon.json` `catalogs.memberUnlockDays`            | `gate.yaml` `security.memberUnlockDays` (v4's effective value)    |
 * | `daemon.json` `carriers` bind, else `host` + `port`  | `connections.yaml` `direct`                                       |
 * | `daemon.json` `carriers` relays, else `relay`        | `connections.yaml` `relay` (the same ordered list, up to four)    |
 * | `daemon.json` `carriers` tunnel                      | `connections.yaml` `tunnel`                                       |
 * | `daemon.json` `webrtc`                               | `connections.yaml` `webrtc`                                       |
 * | `daemon.json` `harness.paths.claude` / `.codex`      | `harness-claude-code.yaml` / `harness-codex.yaml` `binary`        |
 * | `daemon.json` `harness.searchPaths`                  | both harness files' `searchPaths`                                 |
 * | `daemon.json` `agenda` (else `attention`) deadline   | `agenda.yaml` `deadlineWarnHours`                                 |
 * | `daemon.json` `analyticsPricing*`                    | the Usage step's (`state/usage/pricing.json`)                     |
 * | everything else                                      | not carried, each with its reason                                 |
 *
 * SECURITY: the result never allows more than v4 enforced. Every grant axis is written with v4's EFFECTIVE value
 * (`configure` only where `use` is on, v4's rule), so no v5 default is ever relied on; the parsed v5 file is then
 * compared axis by axis and setting by setting with what v4 enforced, and any widening fails the step. A capability
 * v5 cannot name fails the step by name. A carrier the owner switched off stays `enabled: false`. A restriction v5
 * has no field for yet (the catalog link store turned off or the owner's own) leaves the step `pending` rather than
 * being dropped. Nothing here is a credential (v4's grants doc keeps the password verifier out of daemon.json, and
 * 4.291.5 retired the operator password): `secretEnvironment` and `usage.url` are not carried and never echoed, and
 * every value written passes the raw-secret rule. The report names keys, never values.
 *
 * Two of these files are also written by the Settings step (the harness files' `permissionMode`, `agenda.yaml`'s
 * nudge and mode); this step runs after it and adds its keys to the text Settings wrote ({@link V5Writer.written}). A
 * key both would write fails the step.
 */
import { CODEX_CONFIG } from '@ferretry/plugin-codex/contract';
import { CLAUDE_CODE_CONFIG } from '@ferretry/plugin-claude-code/contract';
import { AGENDA_CONFIG } from '@ferretry/plugin-agenda/contract';
import { ConnectionsConfigSchema } from '@ferretry/plugin-connections/contract';
import {
  CAPABILITY_NAMES,
  GateConfigFile,
  GateConfigSchema,
  SECURITY_SETTING_FIELDS,
  widensSecurity,
} from '@ferretry/core-gate/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, parseDocument } from 'yaml';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import { rawSecretPaths, YAML_OPTIONS } from '../v4/config.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import {
  V4_DAEMON_JSON,
  V4_DAMAGED_SECURITY,
  V4_DEFAULT_SECURITY,
  V4_HOSTED_APP_ORIGIN,
  V4_LOOPBACK,
  V4_MEMBER_UNLOCK_DAYS_DEFAULT,
  V4_OPERATOR_PASSWORD,
  V4_SECURITY_JSON,
  v4AgendaWindow,
  V4DaemonDocument,
  v4EffectiveGrants,
  type V4Grant,
  type V4RelayEntry,
  V4SecurityDocument,
  type V4SecuritySettings,
} from '../v4/daemon.ts';
import { configPath, v5ConfigProblem, type V5ConfigTarget } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';

/** Declared in Connections' MANIFEST: restated with its file name and the contract's schema. */
export const CONNECTIONS_CONFIG: V5ConfigTarget = {
  shape: 'file',
  file: 'connections.yaml',
  schema: ConnectionsConfigSchema,
};
const GATE_CONFIG = GateConfigFile as V5ConfigTarget;

/** `daemon.json` keys v5 declares no field for, and why (listed only when the document wrote them). */
const KEY_NOT_CARRIED: Readonly<Record<string, string>> = {
  publicUrl: 'v5 Connections publishes the carriers of connections.yaml; it has no advertised-address override',
  secretsFile: 'v5 declares no daemon secrets-file path; the Vault keeps its own store (state/vault)',
  healthIntervalSeconds: 'v5 declares no health-check interval',
  transcriptReconcileSeconds: 'v5 declares no transcript reconcile interval',
  sessionWorkers: 'v5 declares no session-worker pool setting',
  usage: 'v5 usage.yaml declares no external usage collector (usage.url); its value is not read or shown here',
  delivery: 'v5 conversation.yaml declares only keepInSync; the queue and batching windows are not settings',
  housekeeping: 'v5 declares no housekeeping-worker switch',
  projectRoots: 'v5 declares no project roots; projects are the ones registered in state/projects',
  terminals: 'v5 terminals.yaml declares only terminal counts; a new terminal runs the account’s own login shell',
  fleet: 'retired in v4 (fleet.prepareDefaults): v4 read it as nothing',
  accountModel: 'retired in v4: v4 read it as nothing',
  secretEnvironment:
    'the v5 Vault declares no environment-recipe config yet (a declared GAP); a recipe only ever added a reference the caller had already asked for, so its absence narrows. The owner re-adds the recipes in v5; their text is not read or shown here',
};

const AGENDA_NOT_CARRIED =
  'v5 declares no reply-window setting (the settle, wait, composer and receipt windows are the Asks engine’s own)';
const RESURFACE_NOT_CARRIED =
  'v5 Asks declares asks.yaml only in its manifest, not its contract, so this tool cannot check a value against it; the owner sets it again in v5';

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  {
    what: 'config/daemon.json as a file',
    why: 'v5 has no daemon document (§9.2); each key goes to its owner or is listed here',
  },
  {
    what: 'state/config-accepted.json (for gate.yaml and connections.yaml)',
    why: 'v5 keeps the accepted record in host-private kernel state; until the kernel exports it (lead decision 2026-11-07: carry it), a v4 grant or carrier that v5 reads as a loosening against its defaults is held until the owner confirms it in v5 (it is never applied wider)',
  },
];

interface Planned {
  readonly target: V5ConfigTarget;
  readonly label: string;
  readonly entries: Map<string, unknown>;
  readonly fresh: string;
}

interface Plan {
  readonly files: Map<string, Planned>;
  readonly kept: Map<string, number>;
  readonly dropped: NotCarried[];
  readonly waiting: string[];
  readonly notes: string[];
  /** What v4 enforced, for the after-parse check. */
  grants?: Record<string, V4Grant>;
  security?: V4SecuritySettings;
  carriers?: { relay: boolean; tunnel: boolean; webrtc: boolean };
  memberUnlockDays?: number;
}

const count = (plan: Plan, what: string, n = 1): void => {
  plan.kept.set(what, (plan.kept.get(what) ?? 0) + n);
};

function add(plan: Plan, target: V5ConfigTarget, key: string, value: unknown, from: string): void {
  const path = configPath(target);
  const planned = plan.files.get(path) ?? {
    target,
    label: from,
    entries: new Map<string, unknown>(),
    fresh: ` Carried from v4 ${from} by the v4 → v5 converter.`,
  };
  if (planned.entries.has(key)) throw new V4InputError(`${from}: two v4 keys map to ${path} ${key}`);
  planned.entries.set(key, value);
  plan.files.set(path, planned);
}

/** Whether a v4 file is present, by `lstat` only: the content is never opened. */
async function present(home: string, path: string): Promise<boolean> {
  return (await lstat(join(home, path)).catch(() => undefined)) !== undefined;
}

/** v4's security settings as v4 enforced them: the document's, the defaults when absent, the strictest when damaged. */
async function v4Security(home: string, plan: Plan): Promise<V4SecuritySettings> {
  let decoded: unknown;
  try {
    decoded = await readV4Json(home, join(home, V4_SECURITY_JSON));
  } catch {
    plan.notes.push(`${V4_SECURITY_JSON} is damaged: v4 enforced its strictest settings, so those are carried`);
    return V4_DAMAGED_SECURITY;
  }
  if (decoded === undefined) return V4_DEFAULT_SECURITY;
  const parsed = V4SecurityDocument.safeParse(decoded);
  if (parsed.success) return parsed.data.settings;
  plan.notes.push(`${V4_SECURITY_JSON} is damaged: v4 enforced its strictest settings, so those are carried`);
  return V4_DAMAGED_SECURITY;
}

/** The relay entries v4 dialled: the `carriers` relays, else the legacy `relay` block, else the implied hosted one. */
function v4Relays(document: V4DaemonDocument): {
  readonly entries: readonly V4RelayEntry[];
  readonly written: boolean;
} {
  const declared = (document.carriers ?? []).filter((entry): entry is V4RelayEntry => entry.kind === 'relay');
  if (declared.length > 0) return { entries: declared, written: true };
  if (document.relay !== undefined) return { entries: [{ kind: 'relay', ...document.relay }], written: true };
  return { entries: [{ kind: 'relay', source: 'discovery' }], written: false };
}

function planCarriers(plan: Plan, document: V4DaemonDocument): void {
  const from = V4_DAEMON_JSON;
  const carriers = document.carriers ?? [];
  const bind = carriers.find(entry => entry.kind === 'bind');
  if (bind !== undefined) {
    add(
      plan,
      CONNECTIONS_CONFIG,
      'direct',
      { host: bind.host, ...(bind.port === undefined ? {} : { port: bind.port }) },
      from,
    );
    for (const key of ['host', 'port'] as const)
      if (document[key] !== undefined)
        plan.dropped.push({
          what: `${from} ${key}`,
          why: 'superseded in v4 by the carriers bind entry; v4 did not read it',
        });
    count(plan, 'carriers');
  } else if (document.host !== undefined || document.port !== undefined) {
    // v4's `legacyBindEntry`: an unwritten host is the loopback its schema defaulted to; an unwritten port stays unwritten.
    add(
      plan,
      CONNECTIONS_CONFIG,
      'direct',
      { host: document.host ?? V4_LOOPBACK, ...(document.port === undefined ? {} : { port: document.port }) },
      from,
    );
    count(plan, 'carriers');
  }

  const relays = v4Relays(document);
  if (relays.written) {
    if (carriers.some(entry => entry.kind === 'relay') && document.relay !== undefined)
      plan.dropped.push({
        what: `${from} relay`,
        why: 'superseded in v4 by the carriers relay entries; v4 did not read it',
      });
    // v5 holds v4's ordered rendezvous set as it is: every entry, its order, and each one's on/off (`RelayEntriesSchema`).
    const list = relays.entries.map(entry => {
      const base = {
        enabled: entry.enabled ?? true,
        ...(entry.reconnectSeconds === undefined ? {} : { reconnectSeconds: entry.reconnectSeconds }),
      };
      return 'url' in entry ? { url: entry.url, ...base } : { source: 'discovery', ...base };
    });
    add(plan, CONNECTIONS_CONFIG, 'relay', list, from);
    count(plan, 'relay entries', list.length);
  }

  const tunnel = carriers.find(entry => entry.kind === 'tunnel');
  if (tunnel !== undefined) {
    add(plan, CONNECTIONS_CONFIG, 'tunnel', { enabled: tunnel.enabled ?? true }, from);
    count(plan, 'carriers');
  }
  if (document.webrtc !== undefined) {
    add(plan, CONNECTIONS_CONFIG, 'webrtc', { ...document.webrtc }, from);
    count(plan, 'carriers');
  }
  plan.carriers = {
    relay: relays.entries.some(entry => entry.enabled ?? true),
    tunnel: tunnel === undefined ? false : (tunnel.enabled ?? true),
    webrtc: document.webrtc?.enabled ?? true,
  };
}

function planHarness(plan: Plan, document: V4DaemonDocument): void {
  const harness = document.harness;
  if (harness === undefined) return;
  const from = `${V4_DAEMON_JSON} harness`;
  const claude = harness.paths?.claude;
  const codex = harness.paths?.codex;
  if (claude !== undefined) add(plan, CLAUDE_CODE_CONFIG, 'binary', claude, from);
  if (codex !== undefined) add(plan, CODEX_CONFIG, 'binary', codex, from);
  // v4's one list covered every harness, so both v5 harnesses search it.
  if (harness.searchPaths !== undefined && harness.searchPaths.length > 0) {
    add(plan, CLAUDE_CODE_CONFIG, 'searchPaths', [...harness.searchPaths], from);
    add(plan, CODEX_CONFIG, 'searchPaths', [...harness.searchPaths], from);
  }
  count(
    plan,
    'harness paths',
    (claude === undefined ? 0 : 1) + (codex === undefined ? 0 : 1) + (harness.searchPaths?.length ?? 0),
  );
}

function planAgenda(plan: Plan, document: V4DaemonDocument): void {
  if (document.agenda === undefined && document.attention === undefined) return;
  const window = v4AgendaWindow(document);
  const spelled = document.agenda !== undefined ? 'agenda' : 'attention';
  if (window.deadlineWarnHours !== undefined) {
    add(plan, AGENDA_CONFIG, 'deadlineWarnHours', window.deadlineWarnHours, `${V4_DAEMON_JSON} ${spelled}`);
    count(plan, 'agenda settings');
  }
  if (window.resurfaceAfterMinutes !== undefined)
    plan.dropped.push({ what: `${V4_DAEMON_JSON} ${spelled}.resurfaceAfterMinutes`, why: RESURFACE_NOT_CARRIED });
  const windows = (
    ['replySettleSeconds', 'replyMaxWaitSeconds', 'replyComposerWaitSeconds', 'replyReceiptSeconds'] as const
  ).filter(key => window[key] !== undefined);
  if (windows.length > 0)
    plan.dropped.push({ what: `${V4_DAEMON_JSON} ${spelled}.${windows.join(', ')}`, why: AGENDA_NOT_CARRIED });
  if (document.agenda !== undefined && document.attention !== undefined)
    plan.dropped.push({
      what: `${V4_DAEMON_JSON} attention`,
      why: 'v4 read agenda first, key by key; the keys it left out were read from attention and are carried above',
    });
}

/** The link store: a restriction v5 has no field for yet waits; discovery (the default) needs no field. */
function planCatalogs(plan: Plan, document: V4DaemonDocument): void {
  const catalogs = document.catalogs;
  if (catalogs === undefined) return;
  const store = catalogs.linkStore;
  if (store !== undefined && !('source' in store))
    plan.waiting.push(
      `${V4_DAEMON_JSON} catalogs.linkStore (${'url' in store ? 'the owner’s own link store' : 'download links turned off'}: v5 Catalogs declares no config schema yet)`,
    );
  // memberUnlockDays is Gate's in v5 (`gate.yaml` `security`), written with the security settings.
  if (store !== undefined && 'source' in store)
    plan.dropped.push({
      what: `${V4_DAEMON_JSON} catalogs.linkStore`,
      why: 'the hosted link store found by discovery, which is v5 Catalogs’ own default reading',
    });
}

function planGrants(plan: Plan, document: V4DaemonDocument): void {
  const effective = v4EffectiveGrants(document.grants);
  const v5Names = new Set<string>(CAPABILITY_NAMES);
  for (const name of Object.keys(effective))
    if (!v5Names.has(name))
      throw new V4InputError(
        `${V4_DAEMON_JSON} grants.${name}: v5 has no such capability, so this grant cannot be carried`,
      );
  // A capability v5 has and v4 did not name is off on both axes: a narrowing, never a widening.
  const grants = Object.fromEntries(
    CAPABILITY_NAMES.map(name => [
      name,
      (effective as Record<string, V4Grant>)[name] ?? { use: false, configure: false },
    ]),
  );
  add(plan, GATE_CONFIG, 'grants', grants, V4_DAEMON_JSON);
  plan.grants = grants;
  count(plan, 'capability grants (both axes written)', CAPABILITY_NAMES.length);
}

async function buildPlan(ctx: StepContext): Promise<Plan> {
  const plan: Plan = { files: new Map(), kept: new Map(), dropped: [], waiting: [], notes: [] };
  const home = ctx.v4.home;
  const decoded = await readV4Json(home, join(home, V4_DAEMON_JSON));
  if (decoded !== undefined && !isRecord(decoded)) throw new V4InputError(`${V4_DAEMON_JSON}: is not a JSON object`);
  const parsed = V4DaemonDocument.safeParse(decoded ?? {});
  if (!parsed.success) {
    // Key paths and zod codes only: a parser's message can quote the value.
    const where = parsed.error.issues.map(issue => {
      const keys = issue.code === 'unrecognized_keys' ? ` ${issue.keys.join(', ')}` : '';
      return `${issue.path.length === 0 ? '(top)' : issue.path.join('.')} (${issue.code}${keys})`;
    });
    throw new V4InputError(`${V4_DAEMON_JSON}: is not a document v4 booted with, at ${where.join(', ')}`);
  }
  const document = parsed.data;

  planGrants(plan, document);
  const security = await v4Security(home, plan);
  // v4's effective member unlock (30 unless written): v5 keeps it beside the security settings.
  const memberUnlockDays = document.catalogs?.memberUnlockDays ?? V4_MEMBER_UNLOCK_DAYS_DEFAULT;
  add(plan, GATE_CONFIG, 'security', { ...security, memberUnlockDays }, V4_SECURITY_JSON);
  plan.security = security;
  plan.memberUnlockDays = memberUnlockDays;
  if (document.catalogs?.memberUnlockDays !== undefined) count(plan, 'member unlock days (from daemon.json catalogs)');
  count(plan, 'security settings');
  planCarriers(plan, document);
  planHarness(plan, document);
  planAgenda(plan, document);
  planCatalogs(plan, document);

  if (document.corsOrigins !== undefined) {
    const narrowed = !document.corsOrigins.includes(V4_HOSTED_APP_ORIGIN);
    plan.dropped.push({
      what: `${V4_DAEMON_JSON} corsOrigins (${String(document.corsOrigins.length)} origin(s)${narrowed ? ', without the hosted app' : ''})`,
      why: 'v5 declares no browser-origin allowlist: the app reaches the daemon only through sealed carrier sessions',
    });
  }
  for (const [key, why] of Object.entries(KEY_NOT_CARRIED))
    if (document[key as keyof V4DaemonDocument] !== undefined)
      plan.dropped.push({ what: `${V4_DAEMON_JSON} ${key}`, why });

  // config/routing.json is the Packs step's (src/steps/packs.ts).
  if (await present(home, V4_OPERATOR_PASSWORD))
    plan.dropped.push({
      what: V4_OPERATOR_PASSWORD,
      why: 'retired by v4 4.291.5 (deleted at its boot; the passkey step-up replaced it); never opened, and nothing for the owner to redo',
    });
  return plan;
}

/** The file text: this step's keys added to what an earlier step wrote for the same place, or a fresh file. */
function textOf(ctx: StepContext, planned: Planned): string {
  const earlier = ctx.v5.written(planned.target, undefined);
  const document = earlier === undefined ? new Document({}, YAML_OPTIONS) : parseDocument(earlier, YAML_OPTIONS);
  if (earlier === undefined) document.commentBefore = planned.fresh;
  for (const [key, value] of planned.entries) {
    if (document.has(key))
      throw new V4InputError(
        `${planned.label}: ${configPath(planned.target)} ${key} is also written by another v4 file`,
      );
    document.set(key, value);
  }
  return document.toString({ lineWidth: 0 });
}

const readBack = (text: string): unknown => parseDocument(text, YAML_OPTIONS).toJS() ?? {};

/** What v5 will enforce, compared with what v4 enforced: anything wider fails the step, naming the key. */
function widened(plan: Plan, gateText: string | undefined, connectionsText: string | undefined): string[] {
  const found: string[] = [];
  if (gateText !== undefined && plan.grants !== undefined && plan.security !== undefined) {
    const gate = GateConfigSchema.parse(readBack(gateText));
    for (const name of CAPABILITY_NAMES) {
      const was = plan.grants[name];
      if (gate.grants[name].use && was?.use !== true) found.push(`grants.${name}.use`);
      if (gate.grants[name].configure && was?.configure !== true) found.push(`grants.${name}.configure`);
    }
    for (const field of SECURITY_SETTING_FIELDS)
      if (widensSecurity(field, plan.security[field], gate.security[field])) found.push(`security.${field}`);
    if (gate.security.memberUnlockDays > (plan.memberUnlockDays ?? V4_MEMBER_UNLOCK_DAYS_DEFAULT))
      found.push('security.memberUnlockDays');
  }
  if (plan.carriers !== undefined) {
    const connections = ConnectionsConfigSchema.parse(connectionsText === undefined ? {} : readBack(connectionsText));
    // v5's reading of an absent entry: relay and WebRTC on, tunnel off (`connectionsLoosens`).
    const relayOn =
      connections.relay === undefined ||
      connections.relay.length === 0 ||
      connections.relay.some(entry => entry.enabled);
    if (relayOn && !plan.carriers.relay) found.push('relay');
    if ((connections.tunnel?.enabled ?? false) && !plan.carriers.tunnel) found.push('tunnel');
    if ((connections.webrtc?.enabled ?? true) && !plan.carriers.webrtc) found.push('webrtc');
  }
  return found;
}

export const daemonSettingsStep: Step = {
  id: 'daemon-settings',
  title: 'Daemon settings (grants and security, carriers, harness paths, agenda deadline)',
  owner: ['core-gate', 'plugin-connections', 'plugin-claude-code', 'plugin-codex', 'plugin-agenda'],
  reads: [V4_DAEMON_JSON, V4_SECURITY_JSON, `${V4_OPERATOR_PASSWORD} (lstat only, never opened)`],
  sealed: [],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    let plan: Plan;
    try {
      plan = await buildPlan(ctx);
      const texts = new Map<string, { planned: Planned; text: string }>();
      for (const [path, planned] of plan.files) {
        const text = textOf(ctx, planned);
        const secrets = rawSecretPaths(readBack(text));
        if (secrets.length > 0)
          throw new V4InputError(
            `${planned.label}: the value at ${secrets.join(', ')} (${path}) looks like a raw secret; store it with \`fy secret set NAME\` and write \${secret:NAME} instead`,
          );
        const problem = v5ConfigProblem(planned.target, undefined, text);
        if (problem !== undefined) throw new V4InputError(`${planned.label}: v5 refuses it as ${path}: ${problem}`);
        texts.set(path, { planned, text });
      }
      const wider = widened(
        plan,
        texts.get(configPath(GATE_CONFIG))?.text,
        texts.get(configPath(CONNECTIONS_CONFIG))?.text,
      );
      if (wider.length > 0)
        throw new V4InputError(
          `v5 would allow more than v4 enforced at ${wider.join(', ')}; nothing was written (a converter defect: report it)`,
        );
      for (const { planned, text } of texts.values()) await ctx.v5.config(planned.target, undefined, text);
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'the v4 daemon settings could not be converted'),
        kept: [],
        notCarried: this.notCarried,
      };
    }
    const kept: KeptItem[] = [...plan.kept].map(([what, n]) => ({ what, count: n }));
    const notCarried = [...this.notCarried, ...plan.dropped];
    const notes = [...(ctx.dryRun ? ['dry run: nothing written'] : []), ...plan.notes];
    if (plan.waiting.length > 0)
      return {
        ...base,
        status: 'pending',
        note: [`waits for: ${plan.waiting.join('; ')}`, ...notes].join('; '),
        kept,
        notCarried,
      };
    return { ...base, status: 'converted', ...(notes.length > 0 ? { note: notes.join('; ') } : {}), kept, notCarried };
  },
};
