/**
 * What the setup import hands Codex as one `settings` component, turned into this plugin's own settings item.
 *
 * Pure: it reads the document text Runtimes gives (the account model's shape, JSON-formatted) and answers the item to
 * write or a sentence of why not. It reads no file and holds no value beyond the call. What it never lets through:
 *
 * - a root `profile` key. It selects a `[profiles.*]` table in the host's `config.toml`, and a home that names a profile
 *   that is not there fails every launch. Each Codex profile the person chose is its own item (`model` and
 *   `model_reasoning_effort` only), never a selection.
 * - a `hooks` key. Nothing imports hooks (the owner said so); `hooks.json` is never read or written here.
 * - the component's `env`. A Codex settings item has no environment; the import moves it to the login's.
 * - a `${secret:NAME}` reference. A reference in a settings item reaches `config.toml` literally (pending (f)), so it
 *   would launch Codex with the text of a reference instead of a value. A raw secret is the kernel's to refuse.
 */
import type { SettingsItem } from '../../../contract/index.ts';

export type SettingsItemResult =
  | { readonly ok: true; readonly item: SettingsItem }
  | { readonly ok: false; readonly reason: string };

/** The document keys an import never writes into a Codex settings item. */
const DROPPED_SETTINGS_KEYS: readonly string[] = ['profile', 'hooks'];

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

export function settingsItemFromImport(documentText: string): SettingsItemResult {
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

  const settings = Object.fromEntries(Object.entries(document).filter(([key]) => !DROPPED_SETTINGS_KEYS.includes(key)));
  const reference = secretReferenceAt(settings, '');
  if (reference !== undefined)
    return {
      ok: false,
      reason: `"${reference}" names a secret, and Codex's settings would carry the reference as plain text; it stays out of the import`,
    };

  const flags = parsed.flags;
  if (flags !== undefined && !(Array.isArray(flags) && flags.every(word => typeof word === 'string' && word !== '')))
    return { ok: false, reason: 'the launch flags to import are not a list of words' };
  const flagReference = secretReferenceAt(flags, 'flags');
  if (flagReference !== undefined)
    return { ok: false, reason: `"${flagReference}" names a secret; a launch flag never carries one` };

  const description = typeof parsed.description === 'string' ? parsed.description : undefined;
  return {
    ok: true,
    item: {
      ...(description === undefined ? {} : { description }),
      settings,
      ...(flags === undefined || flags.length === 0 ? {} : { flags: flags as string[] }),
    },
  };
}
