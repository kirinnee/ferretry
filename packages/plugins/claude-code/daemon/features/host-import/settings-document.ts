/**
 * What Claude Code's settings owner keeps of an imported settings component (r9 A6), as a pure function.
 *
 * The setup import hands the owner a settings component in the account model's shape (`harness`, `document`, `flags`, `env`).
 * The owner's item is `{ settings, flags? }`. Nothing the harness would EXECUTE comes in from the host: a command, script,
 * helper or launcher found on the host is not one this machine agreed to run. Every such key is gone, each returns as a put
 * warning (`Not imported: <key> runs a command`). Two other kinds stay out for another reason:
 *
 *  - `hooks`: nothing imports hooks (a second guard behind the planner and behind Runtimes' hand-over);
 *  - `env`: the login's environment holds it (A8), where `${secret:NAME}` is resolved at launch; the component's own `env` too.
 *
 * The command keys come from the settings reference (https://code.claude.com/docs/en/settings-reference): `apiKeyHelper`,
 * `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, `statusLine`,
 * `fileSuggestion`, `policyHelper`, `processWrapper`, `sshHostCommands`, `spellcheck` (names a program), the sandbox binaries
 * (`sandbox.bwrapPath`, `sandbox.socatPath`, `sandbox.ripgrep`) and the plugin keys that load code with its own hooks and
 * helpers (`enabledPlugins`, `prependPlugins`, `appendPlugins`, `pluginConfigs`, `extraKnownMarketplaces`).
 *
 * A value that is a credential by its value or by the key that holds it, ANYWHERE in the document, is left out too (see
 * `drop-secrets.ts`: `Not imported: <path> looks like a secret`): a secret outside an env block is never copied.
 *
 * Nothing here reads a value into a sentence: the sentences name keys, never what they held.
 */
import { z } from 'zod';
import { flagHoldsSecret, withoutSecrets } from './drop-secrets.ts';

const RUNS_A_COMMAND = 'runs a command';
const LOADS_CODE = 'loads code that runs a command';

/** The top-level settings keys never imported, with the reason for each (a key, never its value). */
const NOT_IMPORTED: Readonly<Record<string, string>> = {
  hooks: 'holds hooks, which are never imported',
  env: 'is moved to the login instead',
  apiKeyHelper: RUNS_A_COMMAND,
  statusLine: RUNS_A_COMMAND,
  fileSuggestion: RUNS_A_COMMAND,
  awsAuthRefresh: RUNS_A_COMMAND,
  awsCredentialExport: RUNS_A_COMMAND,
  gcpAuthRefresh: RUNS_A_COMMAND,
  otelHeadersHelper: RUNS_A_COMMAND,
  proxyAuthHelper: RUNS_A_COMMAND,
  policyHelper: RUNS_A_COMMAND,
  processWrapper: RUNS_A_COMMAND,
  sshHostCommands: RUNS_A_COMMAND,
  spellcheck: RUNS_A_COMMAND,
  enabledPlugins: LOADS_CODE,
  prependPlugins: LOADS_CODE,
  appendPlugins: LOADS_CODE,
  pluginConfigs: LOADS_CODE,
  extraKnownMarketplaces: LOADS_CODE,
};

/** Keys inside an object setting that name a binary or command; the rest of the object stays. */
const NESTED_NOT_IMPORTED: Readonly<Record<string, readonly string[]>> = {
  sandbox: ['bwrapPath', 'socatPath', 'ripgrep'],
};

const notImported = (key: string, why: string): string => `Not imported: ${key} ${why}`;

/** Removes the nested command keys of an object setting; names each one it removed. */
function withoutNested(key: string, value: unknown, dropped: string[]): unknown {
  const nested = Object.hasOwn(NESTED_NOT_IMPORTED, key) ? NESTED_NOT_IMPORTED[key] : undefined;
  if (nested === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [inner, innerValue] of Object.entries(value)) {
    if (nested.includes(inner)) dropped.push(notImported(`${key}.${inner}`, RUNS_A_COMMAND));
    else kept[inner] = innerValue;
  }
  return kept;
}

const ImportedSettingsSchema = z.object({
  harness: z.enum(['claude', 'claude-code']),
  document: z.record(z.string(), z.unknown()).optional(),
  flags: z.array(z.string().min(1)).min(1).optional(),
});

/** The owner's item as the import wants it written. */
interface ImportedSettingsItem {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly flags?: readonly string[];
}

export type ImportedSettings =
  | {
      readonly ok: true;
      readonly item: ImportedSettingsItem;
      /** One sentence per kept-out key, for the owner's log and the person's screen (`Not imported: hooks holds hooks, which are never imported`). */
      readonly dropped: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Parses the document an import hands over and removes what is never imported. */
export function importedSettings(documentText: string): ImportedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentText);
  } catch {
    return { ok: false, reason: 'the settings document is not valid' };
  }
  const shaped = ImportedSettingsSchema.safeParse(parsed);
  if (!shaped.success) return { ok: false, reason: 'the settings document is not Claude Code settings' };
  const { document = {} } = shaped.data;
  // A launch flag that carries a credential (`--api-key sk-…`) is a secret outside any env block: no flag list is kept then.
  const flags = shaped.data.flags !== undefined && flagHoldsSecret(shaped.data.flags) ? undefined : shaped.data.flags;
  const dropped: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    const why = Object.hasOwn(NOT_IMPORTED, key) ? NOT_IMPORTED[key] : undefined;
    if (why !== undefined) {
      dropped.push(notImported(key, why));
      continue;
    }
    const clean = withoutSecrets(withoutNested(key, value, dropped), key, key, dropped);
    if (clean !== undefined) settings[key] = clean;
  }
  if (shaped.data.flags !== undefined && flags === undefined) dropped.push('Not imported: flags look like a secret');
  // The component's own `env` (a model-shape key beside `document`) is the login's too.
  if ('env' in (parsed as Record<string, unknown>)) dropped.push(notImported('env', NOT_IMPORTED.env!));
  if (Object.keys(settings).length === 0 && flags === undefined) {
    return { ok: false, reason: 'nothing in it is imported: every key is one Ferretry keeps out' };
  }
  return { ok: true, item: { settings, ...(flags === undefined ? {} : { flags }) }, dropped };
}
