/**
 * What the setup import hands Codex as one `settings` component, turned into this plugin's own settings items.
 *
 * Pure: it reads the document text Runtimes gives (the account model's shape, JSON-formatted) and answers the items to
 * write, a sentence for everything it kept out, or a sentence of why nothing is imported. It reads no file and holds no
 * value beyond the call. Nothing the harness would EXECUTE comes in from the host, and nothing that holds a credential:
 *
 * - commands: `notify`, `hooks`, a model provider's `auth` (the command that prints its token) and
 *   `gateway_oauth.credential_export`, every `mcp_servers` entry (a stdio command; MCP's own file holds those),
 *   `desktop.custom_file_handlers`, and `plugins` / `marketplaces` (they load code). Each returns as a warning,
 *   `Not imported: <key> runs a command`. Reference: https://learn.chatgpt.com/docs/config-file/config-reference.
 * - a root `profile` key. It selects a `[profiles.*]` table in the host's `config.toml`, and a home that names a profile
 *   that is not there fails every launch.
 * - the component's `env`. A Codex settings item has no environment; the import moves it to the login's.
 * - a credential anywhere (`experimental_bearer_token`, an `api_key`, a token-shaped value): left out by its path
 *   (`drop-secrets.ts`). A `${secret:NAME}` reference is refused whole: it reaches `config.toml` literally (pending
 *   (f)), so it would launch Codex with the text of a reference instead of a value.
 *
 * The `profiles` table is not kept in the main item. Each Codex profile the person chose is its own item
 * (`profile-<name>`) holding only `model` and `model_reasoning_effort`. A table may arrive on its own (the person
 * skipped `codex:settings` and kept `codex:profile:<name>`): then there is no main item, only the profile items.
 */
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import type { SettingsItem } from '../../../contract/index.ts';
import { flagHoldsSecret, withoutSecrets } from './drop-secrets.ts';

/** One item to write, with the name it is written under. */
interface ImportedItem {
  readonly name: string;
  readonly item: SettingsItem;
}

export type SettingsItemsResult =
  | {
      readonly ok: true;
      readonly items: readonly ImportedItem[];
      /** Sentences for what was kept out: keys and rules, never a value. */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const RUNS_A_COMMAND = 'runs a command';

/** Top-level keys never imported, with the reason (`Not imported: <key> <reason>`). */
const DROPPED_KEYS: Readonly<Record<string, string>> = {
  hooks: RUNS_A_COMMAND,
  notify: RUNS_A_COMMAND,
  mcp_servers: RUNS_A_COMMAND,
  plugins: 'loads code that runs a command',
  marketplaces: 'loads code that runs a command',
  profile: 'selects a host profile that is not here; each chosen profile is its own item',
};

/** Nested command keys, as paths (`*` is any key of the table above it). */
const DROPPED_PATHS: readonly (readonly string[])[] = [
  ['model_providers', '*', 'auth'],
  ['model_providers', '*', 'gateway_oauth', 'credential_export'],
  ['desktop', 'custom_file_handlers'],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The path of the first `${secret:…}` reference inside `value`, or `undefined`. Names a key, never a value. */
function secretReferenceAt(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') return value.includes('${secret:') ? path : undefined;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = secretReferenceAt(entry, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = secretReferenceAt(entry, path === '' ? key : `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** `value` without the tables at `path` (`*` = every key); one sentence per removal, naming the real path. */
function withoutPath(value: unknown, path: readonly string[], at: string, warnings: string[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined || !isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (head !== '*' && head !== key) {
      out[key] = entry;
    } else if (rest.length === 0) {
      warnings.push(`Not imported: ${at}${key} ${RUNS_A_COMMAND}`);
    } else {
      out[key] = withoutPath(entry, rest, `${at}${key}.`, warnings);
    }
  }
  return out;
}

/** The file-name part of a profile name: lower-case words joined by `-`, or `''` when nothing is left. */
const profileSlug = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replaceAll(/-+$/gu, '');

/** One chosen profile as an item: `model` and `model_reasoning_effort` only, or `undefined` when it sets neither. */
function profileItem(table: unknown): SettingsItem | undefined {
  if (!isRecord(table)) return undefined;
  const settings: Record<string, unknown> = {};
  for (const key of ['model', 'model_reasoning_effort'] as const) {
    const value = table[key];
    if (typeof value === 'string' && value !== '') settings[key] = value;
  }
  return Object.keys(settings).length === 0 ? undefined : { settings };
}

export function settingsItemsFromImport(name: string, documentText: string): SettingsItemsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentText);
  } catch {
    return { ok: false, reason: 'the settings to import are not a readable document' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'the settings to import are not a document' };
  if (parsed.harness !== 'codex') return { ok: false, reason: 'these settings are not for Codex' };
  const document = parsed.document ?? {};
  if (!isRecord(document)) return { ok: false, reason: 'the settings to import hold no settings document' };

  const warnings: string[] = [];
  let settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'profiles') continue;
    const why = Object.hasOwn(DROPPED_KEYS, key) ? DROPPED_KEYS[key] : undefined;
    if (why === undefined) settings[key] = value;
    else warnings.push(`Not imported: ${key} ${why}`);
  }
  for (const path of DROPPED_PATHS) settings = withoutPath(settings, path, '', warnings) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const kept = withoutSecrets(value, key, key, warnings);
    if (kept !== undefined) clean[key] = kept;
  }
  settings = clean;
  if ('env' in parsed) warnings.push('Not imported: env is moved to the login instead');

  const reference = secretReferenceAt(settings, '');
  if (reference !== undefined)
    return {
      ok: false,
      reason: `"${reference}" names a secret, and Codex's settings would carry the reference as plain text; it stays out of the import`,
    };

  let flags: string[] | undefined;
  const given = parsed.flags;
  if (given !== undefined && !(Array.isArray(given) && given.every(word => typeof word === 'string' && word !== '')))
    return { ok: false, reason: 'the launch flags to import are not a list of words' };
  if (given !== undefined) {
    const words = given as string[];
    const flagReference = secretReferenceAt(words, 'flags');
    if (flagReference !== undefined)
      return { ok: false, reason: `"${flagReference}" names a secret; a launch flag never carries one` };
    if (flagHoldsSecret(words)) warnings.push('Not imported: flags look like a secret');
    else if (words.length > 0) flags = words;
  }

  // The profiles the person chose: one item each. A skipped profile is not in the table (the planner left it out).
  const items: ImportedItem[] = [];
  const hasProfiles = 'profiles' in document;
  const description = typeof parsed.description === 'string' ? parsed.description : undefined;
  if (!hasProfiles || Object.keys(settings).length > 0 || flags !== undefined) {
    items.push({
      name,
      item: {
        ...(description === undefined ? {} : { description }),
        settings,
        ...(flags === undefined ? {} : { flags }),
      },
    });
  }
  const table = document.profiles;
  if (isRecord(table)) {
    for (const [profile, body] of Object.entries(table)) {
      const slug = profileSlug(profile);
      const item = profileItem(withoutSecrets(body, `profiles.${profile}`, '', warnings));
      if (slug === '' || !ITEM_NAME_PATTERN.test(`profile-${slug}`)) {
        warnings.push(`Not imported: profile "${profile}" has no name a file can carry`);
      } else if (item === undefined) {
        warnings.push(`Not imported: profile "${profile}" sets neither a model nor a reasoning effort`);
      } else {
        items.push({ name: `profile-${slug}`, item });
      }
    }
  }
  if (items.length === 0) return { ok: false, reason: 'nothing in it is imported' };
  return { ok: true, items, warnings };
}
