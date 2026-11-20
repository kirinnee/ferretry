/**
 * `hostHistory` in `config/harness-codex.yaml`: whether Ferretry may READ the conversations in the person's own `~/.codex`.
 * It never deletes or changes anything there (docs: one way). The page reads it back from the file every time it opens, so a
 * reload loses nothing; a write changes ONLY this key, through the shared one-key editor, so every other key and comment stays.
 */
import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { type ConfigFile, type OnboardingClient, changeAtMachineWords } from '../onboarding-api.ts';

const ROUTE = 'PUT /v1/config/file' as const;
const FILE = 'harness-codex.yaml';

/**
 * What the text says: an absent key is `true` (the default); a text that does not parse, is not a mapping, or holds something
 * that is not a yes or no is `null` — unknown, never guessed, and never written over.
 */
export function historyOf(text: string): boolean | null {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const { value } = read.read;
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const said = (value as Record<string, unknown>).hostHistory;
  if (said === undefined || said === null) return true;
  return typeof said === 'boolean' ? said : null;
}

/** The value the file says now; `null` when it cannot be known here (withheld by the daemon, unparsable, or not a yes/no). */
export const currentHistory = (file: ConfigFile): boolean | null => (file.withheld ? null : historyOf(file.text));

/** The text with ONLY `hostHistory` changed. Throws on a text it cannot read as a mapping, rather than replacing the file. */
export function withHistory(text: string, on: boolean): string {
  const read = readConfigText(text);
  const value = read.ok ? read.read.value : undefined;
  if (!read.ok || historyOf(text) === null) throw new Error('the file cannot be edited here');
  const now = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return editConfigText(text, { ...now, hostHistory: on }, now, undefined);
}

/**
 * What a write did: in effect now, or written and held until the owner confirms it (turning it ON can be). Never sends a file whose
 * value is unknown.
 */
export async function writeHistory(
  client: OnboardingClient,
  file: ConfigFile,
  on: boolean,
): Promise<'applied' | 'held'> {
  if (currentHistory(file) === null) throw new Error(changeAtMachineWords(file));
  const answer = (await client.call(ROUTE, {
    body: { path: FILE, text: withHistory(file.text, on), etag: file.etag },
  })) as {
    readonly outcome?: string;
  };
  return answer.outcome === 'pending' ? 'held' : 'applied';
}
