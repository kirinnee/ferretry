/**
 * What Claude Code's settings owner keeps of an imported settings component (r9 A6), as a pure function.
 *
 * The setup import hands the owner a settings component in the account model's shape (`harness`, `document`, `flags`, `env`).
 * The owner's item is `{ settings, flags? }`. Four kinds of key never make it in, because each is something Ferretry would
 * RUN or something another part owns:
 *
 *  - `hooks`: nothing imports hooks (a second guard behind the planner and behind Runtimes' hand-over);
 *  - `env`: the login's environment holds it (A8), where `${secret:NAME}` is resolved at launch; the component's own `env` too;
 *  - `apiKeyHelper`, `statusLine` and the other keys that name a COMMAND the harness runs (`awsAuthRefresh`,
 *    `awsCredentialExport`, `otelHeadersHelper`): a command found on the host is not one this machine agreed to run.
 *
 * Nothing here reads a value into a sentence: the sentences name keys, never what they held.
 */
import { z } from 'zod';

/** The top-level settings keys never imported, with the sentence for each (a key, never its value). */
const NOT_IMPORTED: Readonly<Record<string, string>> = {
  hooks: 'hooks are not imported',
  env: 'its environment goes to the login instead',
  apiKeyHelper: 'it names a command Ferretry would have to run',
  statusLine: 'it names a command Ferretry would have to run',
  awsAuthRefresh: 'it names a command Ferretry would have to run',
  awsCredentialExport: 'it names a command Ferretry would have to run',
  otelHeadersHelper: 'it names a command Ferretry would have to run',
};

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
      /** One sentence per kept-out key, for the owner's log and the person's screen (`hooks: hooks are not imported`). */
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
  const { document = {}, flags } = shaped.data;
  const dropped: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    const why = Object.hasOwn(NOT_IMPORTED, key) ? NOT_IMPORTED[key] : undefined;
    if (why === undefined) settings[key] = value;
    else dropped.push(`${key}: ${why}`);
  }
  // The component's own `env` (a model-shape key beside `document`) is the login's too.
  if ('env' in (parsed as Record<string, unknown>)) dropped.push(`env: ${NOT_IMPORTED.env}`);
  if (Object.keys(settings).length === 0 && flags === undefined) {
    return { ok: false, reason: 'nothing in it is imported: every key is one Ferretry keeps out' };
  }
  return { ok: true, item: { settings, ...(flags === undefined ? {} : { flags }) }, dropped };
}
