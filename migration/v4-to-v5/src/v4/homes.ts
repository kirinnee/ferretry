/**
 * The homes a converted value must not reach: v4's home and worktree folder, and the user's harness homes
 * (`~/.claude*`, `~/.codex*`), in every spelling. The ONE owner of this list: the preview's last gate
 * (`preview/gate.ts`) and the carried-file check (`steps/component-assets.ts`) both import it from here.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** `path` with every existing link resolved; the part that does not exist yet is kept as written. */
export function resolveReal(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      existing = parent;
    }
  }
}

/** Everything the gate looks for, built once from every spelling of the homes involved. */
export interface Needles {
  /** Matched whole (what follows must end a path component): v4's home, its worktree folder, in every spelling. */
  readonly v4: readonly string[];
  /** Matched as a prefix: `<home>/.claude*` and `<home>/.codex*`. */
  readonly harness: readonly string[];
}

export interface Spellings {
  /** The v4 home as the caller named it, when that differs from the resolved one. */
  readonly v4Given?: string | undefined;
  /** The user's home as given (`$HOME`, the `home` input), beside the resolved one. */
  readonly homeGiven?: readonly string[] | undefined;
}

const HOME_FORMS = ['~', '$HOME', '${HOME}'] as const;

/** Every spelling of v4's home and of the harness homes: resolved, as given, `~/`, `$HOME`, `${HOME}`, the worktree sibling. */
export function needlesFor(v4Home: string, home: string, given: Spellings = {}): Needles {
  const userHomes = new Set<string>([home, resolveReal(home), resolveReal(homedir()), homedir()]);
  for (const spelling of given.homeGiven ?? []) if (spelling !== '') userHomes.add(spelling);
  const envHome = process.env.HOME;
  if (envHome !== undefined && envHome !== '') userHomes.add(envHome);
  const v4Spellings = new Set<string>([v4Home, resolveReal(v4Home)]);
  if (given.v4Given !== undefined && given.v4Given !== '') v4Spellings.add(given.v4Given);
  // v4's home lives at `~/.ferretry` by default: protected in every home-relative spelling whatever `--v4` said.
  const relatives = new Set<string>(['.ferretry']);
  for (const spelling of v4Spellings)
    for (const base of userHomes) {
      const rel = relative(base, spelling);
      if (rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')) relatives.add(rel);
    }
  const v4 = new Set<string>();
  for (const spelling of v4Spellings) {
    v4.add(spelling);
    v4.add(`${spelling}-worktrees`);
  }
  for (const rel of relatives)
    for (const form of HOME_FORMS) {
      v4.add(`${form}/${rel}`);
      v4.add(`${form}/${rel}-worktrees`);
    }
  for (const base of userHomes) {
    v4.add(join(base, '.ferretry'));
    v4.add(join(base, '.ferretry-worktrees'));
  }
  const harness = new Set<string>();
  for (const base of [...userHomes, ...HOME_FORMS])
    for (const name of ['.claude', '.codex']) harness.add(`${base.replace(/\/+$/u, '')}/${name}`);
  return { v4: [...v4].filter(item => item !== ''), harness: [...harness] };
}

/** `needle` followed by anything that ends a path component: `<v4 home>-v5` and `<v4 home>.staging` are other folders. */
export function namesWhole(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const next = text[at + needle.length];
    if (next === undefined || !/[\w.-]/u.test(next)) return true;
  }
  return false;
}

export const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Whether a gated value names v4 (whole) or a harness home (prefix), as written or URL-decoded. */
export function valueHits(value: string, needles: Needles, only: 'both' | 'harness' = 'both'): boolean {
  const forms = value === decoded(value) ? [value] : [value, decoded(value)];
  for (const form of forms) {
    if (needles.harness.some(needle => form.includes(needle))) return true;
    if (only === 'both' && needles.v4.some(needle => namesWhole(form, needle))) return true;
  }
  return false;
}
