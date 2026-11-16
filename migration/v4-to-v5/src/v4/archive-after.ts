/**
 * v4's automatic session archive switch, as this tool reads it. A LOCAL copy on purpose (see `layout.ts`): the
 * variable, its parse rule and the places the v4 daemon's service can set it. Source of truth is today's code at
 * the v4 tag: `packages/daemon/src/lib/session/archive/policy.ts` (`ARCHIVE_AFTER_VARIABLE`, `parseArchiveAfter`),
 * `packages/cli/src/lib/daemon/{layout,unit-file}.ts` (where the unit and the plist live and what `fy daemon install`
 * writes into them) and `docs/session-archive.md` § Setting (the documented drop-in and `launchctl setenv`).
 *
 * `fy daemon install` writes neither the variable nor a drop-in: it writes `FY_HOME`, `HOME`, `PATH`, the locale and a
 * few runtime variables. So the value is always something the OWNER added, by hand or from the documented recipe.
 * Nothing here opens anything but the named unit, its drop-ins and the plist, and a value is never printed by the
 * caller beyond the whole number it is.
 */
import { join } from 'node:path';

/** The variable the v4 daemon reads at boot. */
export const V4_ARCHIVE_VARIABLE = 'FYD_SESSION_ARCHIVE_AFTER_HOURS';

/** v4 daemon name and product (`layout.ts`): the unit is `fyd.service`, the launchd label `com.ferretry.fyd`. */
const V4_UNIT_NAME = 'fyd.service';
const V4_LAUNCHD_LABEL = 'com.ferretry.fyd';

/** The unit file, its drop-in folder and the plist, as `resolveDaemonLayout` derives them. */
export function v4ServicePaths(homeDirectory: string, configHome: string | undefined) {
  const config = configHome === undefined || configHome.trim() === '' ? join(homeDirectory, '.config') : configHome;
  const unitFile = join(config, 'systemd', 'user', V4_UNIT_NAME);
  return {
    unitFile,
    dropInFolder: `${unitFile}.d`,
    plist: join(homeDirectory, 'Library', 'LaunchAgents', `${V4_LAUNCHD_LABEL}.plist`),
  };
}

export type ArchiveAfter =
  | { readonly kind: 'off' }
  | { readonly kind: 'hours'; readonly hours: number }
  | { readonly kind: 'invalid' };

/**
 * `parseArchiveAfter`, key for key: absent, empty or `off` (any case, trimmed) is off; anything that is not a whole
 * number of hours of one or more is a value v4 refused to boot with.
 */
export function parseArchiveAfter(raw: string | undefined): ArchiveAfter {
  const text = raw?.trim().toLowerCase() ?? '';
  if (text === '' || text === 'off') return { kind: 'off' };
  if (!/^[1-9]\d*$/u.test(text)) return { kind: 'invalid' };
  return { kind: 'hours', hours: Number(text) };
}

const SYSTEMD_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  s: ' ',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

/**
 * One `Environment=` value split into its assignments, the way systemd splits it: whitespace separates words, a word
 * may be wrapped in `"` or `'`, a backslash escapes, and `%%` is one `%`.
 */
export function systemdEnvironmentWords(value: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? '';
    if (ch === '\\') {
      const next = value[index + 1] ?? '';
      word = (word ?? '') + (SYSTEMD_ESCAPES[next] ?? next);
      index += 1;
    } else if (ch === '%' && value[index + 1] === '%') {
      word = (word ?? '') + '%';
      index += 1;
    } else if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else word = (word ?? '') + ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (/\s/u.test(ch)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** What one unit-file or drop-in text sets, in order. `reset` is an empty `Environment=`, which clears what came before. */
export interface SystemdEnvironment {
  readonly assignments: ReadonlyMap<string, string>;
  /** Whether the text names an `EnvironmentFile=` (not opened: it can hold anything). */
  readonly environmentFile: boolean;
}

/** The `[Service]` `Environment=` lines of one systemd text; a later assignment of a name wins, an empty line resets. */
export function systemdEnvironment(text: string): SystemdEnvironment {
  // A trailing backslash continues the line.
  const lines = text.replace(/\\\r?\n/gu, ' ').split(/\r?\n/u);
  const assignments = new Map<string, string>();
  let environmentFile = false;
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== 'Service') continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    if (key === 'EnvironmentFile') environmentFile = true;
    if (key !== 'Environment') continue;
    if (value.trim() === '') {
      assignments.clear();
      continue;
    }
    for (const word of systemdEnvironmentWords(value)) {
      const at = word.indexOf('=');
      if (at > 0) assignments.set(word.slice(0, at), word.slice(at + 1));
    }
  }
  return { assignments, environmentFile };
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const xmlText = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos);/gu, (_whole, name: string) => XML_ENTITIES[name] ?? '');

/**
 * `EnvironmentVariables` → one string value of an XML property list, or `undefined` when it names none. launchd's
 * dictionary holds only strings, so its first `</dict>` closes it. A binary plist (`plutil -convert binary1`) is not
 * read: `binary` says so.
 */
export function plistEnvironmentValue(
  text: string,
  name: string,
): { readonly binary: boolean; readonly value: string | undefined } {
  if (text.startsWith('bplist')) return { binary: true, value: undefined };
  const dictionary = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(text)?.[1];
  if (dictionary === undefined) return { binary: false, value: undefined };
  const pair = /<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<string\s*\/>)/gu;
  let value: string | undefined;
  for (const match of dictionary.matchAll(pair))
    if (xmlText(match[1] ?? '').trim() === name) value = xmlText(match[2] ?? '');
  return { binary: false, value };
}
