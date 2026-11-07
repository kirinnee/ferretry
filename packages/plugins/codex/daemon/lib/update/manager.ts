/**
 * What a package manager's output says, and where one lives. Pure.
 */
import type { ExecutableResolverPort } from './ports.ts';

/** The package managers an update may run. */
export type PackageManager = 'brew' | 'npm';

/**
 * A daemon started by launchd or systemd inherits a minimal `PATH`, and Homebrew's prefix is exactly what such a `PATH`
 * leaves out. So after the inherited `PATH`, these absolute paths are asked too. Only stats: nothing is launched to
 * find a manager.
 */
const MANAGER_LOCATIONS: Readonly<Record<PackageManager, readonly string[]>> = {
  brew: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
  npm: ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'],
};

/** Find one manager on this machine: the inherited `PATH` first, then its usual locations. */
export async function locateManager(
  manager: PackageManager,
  executables: ExecutableResolverPort,
): Promise<string | undefined> {
  const found = await executables.resolve(manager);
  if (found !== undefined) return found;
  for (const path of MANAGER_LOCATIONS[manager]) if (await executables.runnable(path)) return path;
  return undefined;
}

/**
 * Lines a manager prints when it needs admin rights it was not given.
 *
 * One list for every manager rather than one per manager: the phrases do not collide, and a manager that borrows
 * another's wording (Homebrew's cask installers print `sudo`'s own refusals) is still read.
 */
const NEEDS_ADMIN = [
  /\bEACCES\b/u,
  /\bEPERM\b/u,
  /permission denied/iu,
  /sudo: (?:a terminal is required|a password is required|no tty present)/iu,
  /need sudo access/iu,
  /are you root\?/iu,
];

/** An OSC sequence: `ESC ]` up to a `BEL` or a string terminator, so the URL a hyperlink carries is consumed with it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
/** A CSI sequence — colour, cursor movement, erasure. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** A two-character escape such as `ESC ( B`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const SHORT_ESCAPE = /\u001b[()#][0-9A-Za-z]|\u001b[<>=]/gu;
/** Control characters that survive stripping. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** One output line with every terminal escape and stray control character removed. */
const stripTerminalEscapes = (raw: string): string =>
  raw
    .replaceAll(OSC_SEQUENCE, '')
    .replaceAll(CSI_SEQUENCE, '')
    .replaceAll(SHORT_ESCAPE, '')
    .replaceAll(CONTROL_CHARACTERS, '');

function lastLine(tail: readonly string[]): string | undefined {
  const line = tail
    .map(entry => stripTerminalEscapes(entry).trim())
    .filter(entry => entry !== '')
    .at(-1);
  return line === undefined ? undefined : line.slice(0, 200);
}

/** What a manager's last lines say: whether it needed admin rights it was not given, and the last thing it said. */
export function readManagerTail(tail: readonly string[]): {
  readonly needsAdmin: boolean;
  readonly said: string | undefined;
} {
  const lines = tail.map(stripTerminalEscapes);
  return { needsAdmin: lines.some(line => NEEDS_ADMIN.some(pattern => pattern.test(line))), said: lastLine(tail) };
}

/**
 * The environment a manager runs in.
 *
 * Its own directory goes first on `PATH`, because npm is a script whose `#!/usr/bin/env node` must find the node beside
 * it on a daemon whose inherited `PATH` is minimal. `NONINTERACTIVE` is Homebrew's own switch for 'never stop to ask'.
 */
export function installEnvironment(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const directory = executable.slice(0, executable.lastIndexOf('/')) || '/';
  const inherited = environment.PATH;
  return {
    PATH: inherited === undefined || inherited === '' ? directory : `${directory}:${inherited}`,
    NONINTERACTIVE: '1',
  };
}
