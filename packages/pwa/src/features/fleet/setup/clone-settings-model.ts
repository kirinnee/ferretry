/**
 * Clone v2: copy a machine's SETTINGS, not only its fleet (spec R6, R5 "Clone = copy these files minus
 * secrets"; build plan P9), as data.
 *
 * What a person can pick to copy from another paired machine:
 *
 * - **Profiles, components, runtimes and logins** — the existing reviewed `clone.import` change, with
 *   every command it would run listed first (`clone-model.ts`). Logins travel as descriptors.
 * - **Warden**, **Learning defaults** and **Voice clean-up** — `warden.yaml`, `learning.yaml` and
 *   `voice.yaml`, copied as the files they are: read from the source with `GET /v1/config/file` and
 *   written here with `PUT /v1/config/file`, which validates them and HOLDS any edit that loosens spend
 *   or authority until the owner confirms it. A configuration file never holds a secret value (the
 *   daemon refuses one), so a copied file carries at most `${secret:NAME}` references.
 * - **Agent controls and default runtime** — the source's machine settings, applied here as one
 *   reviewed `machine.settings` change. `machine.yaml` is NOT copied whole: its advanced block names
 *   this machine's own paths and tools.
 *
 * SECRETS AND LOGIN TOKENS NEVER TRAVEL WITH THE SETTINGS — no route returns a value, and a secret is copied
 * only by name, on its own (docs/secrets.md). What travels can still NEED one,
 * so the preview lists every secret and sign-in the copied settings need ("needs: JEV_API_KEY,
 * GROQ_API_KEY, Claude Code login…"), each marked when this machine already holds it, with a field to
 * add it now.
 *
 * Pure: the source's files, bundle and machine view in; the items, the needs and the change out.
 */

import {
  type FleetAccountChange,
  type FleetCloneBundle,
  type FleetMachineView,
  type SpeedupProvider,
  type SpeedupsView,
  secretReferencesIn,
} from '@ferretry/protocol';
import { countWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

/** One thing Clone can copy, with the id the checkbox and the result use. */
export type CloneItemId = 'fleet' | 'warden' | 'learning' | 'voice' | 'controls';

export interface CloneItem {
  readonly id: CloneItemId;
  readonly label: string;
  /** The configuration file it is, for the items that are copied as one. */
  readonly file?: string;
  /** What it covers, in one line. */
  readonly detail: string;
}

/** The settings copied as files, in the order the preview lists them. */
export const CLONE_SETTINGS_FILES: readonly (CloneItem & { readonly file: string })[] = [
  {
    id: 'warden',
    label: 'Warden',
    file: 'warden.yaml',
    detail: 'How it judges, how often, the spend caps and what it may do alone.',
  },
  {
    id: 'learning',
    label: 'Learning defaults',
    file: 'learning.yaml',
    detail: 'Whether new ferrets are instructed to file lessons.',
  },
  {
    id: 'voice',
    label: 'Voice clean-up',
    file: 'voice.yaml',
    detail: 'Which provider cleans up a dictated transcript, and its model.',
  },
];

export const CLONE_ITEMS: readonly CloneItem[] = [
  {
    id: 'fleet',
    label: 'Profiles, components, runtimes and logins',
    detail: 'Logins travel as plain variables and secret NAMES only; a signed-in login arrives empty.',
  },
  ...CLONE_SETTINGS_FILES,
  {
    id: 'controls',
    label: 'Agent controls and default runtime',
    detail: 'What agents may control, agent permissions, and the runtime a new ferret uses.',
  },
];

/** Every item ticked: the preview's starting point. */
export const ALL_CLONE_ITEMS: readonly CloneItemId[] = CLONE_ITEMS.map(item => item.id);

// ── What the source has ──────────────────────────────────────────────────────────────────────────

/** One settings file as read from the source: its text, or that it has none (it runs on defaults). */
export interface SourceSettingsFile {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
}

/**
 * The one-line summary of a source item, so a checkbox says what it would bring ("triage: jev").
 * Read from the file's text, never parsed into effect here: the TARGET validates what it is sent.
 */
export const sourceItemSummary = (
  id: CloneItemId,
  files: ReadonlyMap<string, SourceSettingsFile>,
  machine: FleetMachineView | null,
  bundle: FleetCloneBundle | null,
): string => {
  if (id === 'fleet') {
    if (bundle === null) return 'Not read';
    return [
      countWords(Object.keys(bundle.profiles).length, 'profile'),
      countWords(Object.keys(bundle.runtimes).length, 'runtime'),
      countWords(bundle.credentials.length, 'login'),
    ].join(', ');
  }
  if (id === 'controls') {
    if (machine === null) return 'Not read';
    const on = (Object.keys(machine.agentControl) as (keyof FleetMachineView['agentControl'])[]).filter(
      kind => machine.agentControl[kind],
    );
    return `${on.length === 0 ? 'no controls' : on.join(', ')} · default runtime ${machine.defaultRuntime ?? 'automatic'}`;
  }
  const item = CLONE_SETTINGS_FILES.find(candidate => candidate.id === id) as CloneItem & { readonly file: string };
  const file = files.get(item.file);
  if (file === undefined) return 'Not read';
  if (!file.exists) return 'Not set on the source: copies the defaults';
  const lines = settingLines(file.text);
  return lines.length === 0 ? 'Defaults' : lines.join(' · ');
};

/** The top-level `key: value` lines of a YAML text, comments and nesting left out: a glance, not a parse. */
const settingLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .filter(line => /^[A-Za-z][\w-]*:\s*\S/u.test(line) && !line.trimStart().startsWith('#'))
    .map(line => line.replace(/\s+#.*$/u, '').trim())
    .slice(0, 3);

/** The value of a top-level or indented `key:` in a YAML text, unquoted; `undefined` when absent. */
const yamlValue = (text: string, key: string): string | undefined => {
  const match = new RegExp(`^\\s*${key}:\\s*["']?([\\w-]+)["']?\\s*(?:#.*)?$`, 'mu').exec(text);
  return match?.[1];
};

/**
 * The speed-up keys a copied settings file would SPEND: the Warden's Jev guard, and voice clean-up on
 * Groq or Cerebras. A file that does not name one needs no key.
 */
export const providersNeededBy = (path: string, text: string): readonly SpeedupProvider[] => {
  if (path === 'warden.yaml') {
    const enabled = yamlValue(text, 'enabled');
    // The layer, or the single `triage: jev` a file from before the layers still says.
    const jev = yamlValue(text, 'jev') === 'true' || yamlValue(text, 'triage') === 'jev';
    return jev && enabled !== 'false' ? ['jev'] : [];
  }
  if (path === 'voice.yaml') {
    const provider = yamlValue(text, 'provider');
    return provider === 'groq' || provider === 'cerebras' ? [provider] : [];
  }
  return [];
};

// ── What it needs here ───────────────────────────────────────────────────────────────────────────

/** One secret or sign-in the copied settings need on this machine. */
export interface CloneNeed {
  /** Stable key for the list. */
  readonly key: string;
  readonly kind: 'secret' | 'sign-in';
  /** `JEV_API_KEY`, or "Claude Code login (claude-work)". */
  readonly name: string;
  /** The secret's name when it is one this browser can add: the field stores under this name. */
  readonly secretName?: string;
  /** For a sign-in: the login it is, so Done can link to it. */
  readonly credentialId?: string;
  /** Why it is needed: "the Warden's Jev guard", "login glm-env". */
  readonly why: string;
  /** Whether this machine already holds it. A sign-in is never held: the copy arrives empty. */
  readonly held: boolean;
}

const PROVIDER_WHY: Readonly<Record<SpeedupProvider, string>> = {
  jev: 'the Warden’s Jev guard',
  groq: 'voice clean-up on Groq',
  cerebras: 'voice clean-up on Cerebras',
};

/**
 * Everything the chosen items need here, secrets first then sign-ins, each once.
 *
 * `held` is the secret NAMES this machine holds (`GET /v1/secrets` answers names, never values);
 * `speedups` is this machine's Speed-ups read, which names the secret each provider spends — `null`
 * when it could not be read, and then a key is named by its provider and has no field.
 */
export const cloneNeeds = (
  chosen: readonly CloneItemId[],
  bundle: FleetCloneBundle | null,
  files: ReadonlyMap<string, SourceSettingsFile>,
  speedups: SpeedupsView | null,
  held: readonly string[],
): readonly CloneNeed[] => {
  const secrets = new Map<string, CloneNeed>();
  const addSecret = (name: string, why: string, secretName: string | undefined): void => {
    if (secrets.has(name)) return;
    secrets.set(name, {
      key: `secret:${name}`,
      kind: 'secret',
      name,
      ...(secretName === undefined ? {} : { secretName }),
      why,
      held: secretName !== undefined && held.includes(secretName),
    });
  };
  for (const item of CLONE_SETTINGS_FILES) {
    const file = files.get(item.file);
    if (!chosen.includes(item.id) || file === undefined || !file.exists) continue;
    for (const provider of providersNeededBy(item.file, file.text)) {
      const status = speedups?.providers.find(candidate => candidate.provider === provider);
      const name = status?.secretName ?? `${provider} key`;
      addSecret(name, PROVIDER_WHY[provider], status?.secretName);
    }
    for (const name of secretReferencesIn(file.text)) addSecret(name, item.label, name);
  }
  const signIns: CloneNeed[] = [];
  if (chosen.includes('fleet') && bundle !== null) {
    // A copied MCP server or settings file can name a secret in its environment, as a login can.
    for (const name of secretReferencesIn(JSON.stringify(bundle.components)))
      addSecret(name, 'a copied component', name);
    for (const file of bundle.files)
      for (const name of secretReferencesIn(file.content)) addSecret(name, file.path, name);
    for (const credential of bundle.credentials) {
      if (credential.store === 'environment') {
        for (const value of Object.values(credential.env ?? {}))
          for (const name of secretReferencesIn(value)) addSecret(name, `login ${credential.id}`, name);
        continue;
      }
      signIns.push({
        key: `sign-in:${credential.id}`,
        kind: 'sign-in',
        name: `${SETUP_HARNESS_NAMES[credential.harness]} login (${credential.id})`,
        credentialId: credential.id,
        why: credential.email ?? credential.label ?? 'signed in on the source',
        held: false,
      });
    }
  }
  return [...secrets.values(), ...signIns];
};

/** "JEV_API_KEY, GROQ_API_KEY, Claude Code login (claude-work)" — what is not held yet, or `null`. */
export const needsSentence = (needs: readonly CloneNeed[]): string | null => {
  const missing = needs.filter(need => !need.held);
  return missing.length === 0 ? null : missing.map(need => need.name).join(', ');
};

// ── The copy ─────────────────────────────────────────────────────────────────────────────────────

/** The source's controls and default runtime as this machine's `machine.settings` change. */
export const controlsChange = (source: FleetMachineView): FleetAccountChange => ({
  kind: 'machine.settings',
  agentPermissions: source.agentPermissions,
  defaultRuntime: source.defaultRuntime,
  agentControl: source.agentControl,
});

/** How one copied item ended. */
export type CloneItemOutcome =
  | { readonly kind: 'copied' }
  /** Written, but it loosens something, so it waits for the owner; the tighter version is in effect. */
  | { readonly kind: 'pending'; readonly path: string; readonly etag: string; readonly changes: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

/** The Done line for one item's outcome. */
export const outcomeSentence = (item: CloneItem, outcome: CloneItemOutcome): string => {
  switch (outcome.kind) {
    case 'copied':
      return `${item.label}: copied, in effect now.`;
    case 'pending':
      return `${item.label}: copied, and waiting for your confirmation because it loosens something: ${outcome.changes.join('; ')}.`;
    case 'refused':
      return `${item.label}: not copied. ${outcome.reason}`;
  }
};
