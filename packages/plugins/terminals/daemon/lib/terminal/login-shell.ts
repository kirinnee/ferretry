/**
 * Which shell a web terminal opens: the owner's own, not whatever `/bin/sh` happens to be.
 *
 * A terminal that starts `/bin/sh` is a bare prompt with none of the owner's aliases, history,
 * completion or prompt. The shell they chose is recorded in the system account database (the passwd
 * entry for the daemon's uid; on macOS the directory service, because a launchd daemon often has no
 * `$SHELL`), so that is where it is read — and only trusted when the machine itself lists it in
 * `/etc/shells` and it can be run. Anything else falls back to `/bin/sh` and says why, once.
 *
 * Pure: every read is a fact handed in by the adapter, so this is decided from fixtures.
 */

/** Where a candidate came from, in the order they are tried. */
export type LoginShellSource = 'config' | 'passwd' | 'directory-service' | 'environment';

export const FALLBACK_LOGIN_SHELL = '/bin/sh';

export interface LoginShellCandidate {
  readonly source: LoginShellSource;
  readonly path: string;
}

export interface LoginShellRejection extends LoginShellCandidate {
  readonly reason: string;
}

export interface LoginShellChoice {
  readonly shell: string;
  /** Absent when nothing was accepted and {@link FALLBACK_LOGIN_SHELL} is the answer. */
  readonly source?: LoginShellSource;
  readonly rejected: readonly LoginShellRejection[];
}

/** What the daemon asks once, when its first terminal is about to open. */
export interface LoginShellPort {
  /** The absolute path of the shell a new terminal runs as a login shell. Never rejects. */
  shell(): Promise<string>;
}

/**
 * Programs `/etc/shells` or a passwd entry may name that are not a shell anyone can type into. A
 * distribution that lists `nologin` there is common enough that "listed" alone is not "usable".
 */
const NOT_INTERACTIVE = new Set(['nologin', 'false', 'true']);

/** The shell field of the passwd entry for `uid`, or undefined when there is no such entry. */
export function passwdShell(passwd: string, uid: number): string | undefined {
  for (const line of passwd.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    // name:password:uid:gid:gecos:home:shell
    const fields = line.split(':');
    if (fields.length < 7 || fields[2] !== String(uid)) continue;
    const shell = fields.slice(6).join(':').trim();
    return shell === '' ? undefined : shell;
  }
  return undefined;
}

/** The shell from `dscl . -read /Users/<name> UserShell` (`UserShell: /bin/zsh`). */
export function directoryServiceShell(output: string): string | undefined {
  const match = /^UserShell:\s*(\S.*?)\s*$/mu.exec(output);
  return match?.[1];
}

/** The absolute paths `/etc/shells` lists: comments and blank lines are not entries. */
export function listedShells(text: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#') && line.startsWith('/')) paths.add(line);
  }
  return paths;
}

function malformed(path: string): string | undefined {
  if (!path.startsWith('/')) return 'it is not an absolute path';
  // A path with a space, newline or control character is never a shell /etc/shells would list.
  if ([...path].some(char => char.trim() === '' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return 'it contains whitespace or a control character';
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (NOT_INTERACTIVE.has(name)) return `${name} is not an interactive shell`;
  return undefined;
}

/**
 * The first candidate that is an absolute, listed, runnable shell; otherwise `/bin/sh` with every
 * refusal and its reason. `listed` is undefined when `/etc/shells` could not be read — nothing can then
 * be proved to be a shell, so nothing but the fallback is accepted.
 */
export async function chooseLoginShell(
  candidates: readonly LoginShellCandidate[],
  listed: ReadonlySet<string> | undefined,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<LoginShellChoice> {
  const rejected: LoginShellRejection[] = [];
  for (const candidate of candidates) {
    const reason =
      malformed(candidate.path) ??
      (listed === undefined
        ? '/etc/shells could not be read'
        : listed.has(candidate.path)
          ? (await isExecutable(candidate.path))
            ? undefined
            : 'it is not an executable file'
          : 'it is not listed in /etc/shells');
    if (reason === undefined) return { shell: candidate.path, source: candidate.source, rejected };
    rejected.push({ ...candidate, reason });
  }
  return { shell: FALLBACK_LOGIN_SHELL, rejected };
}

function describeSource(source: LoginShellSource): string {
  switch (source) {
    case 'config':
      return 'terminals.shell in config/daemon.json';
    case 'passwd':
      return 'the passwd entry';
    case 'directory-service':
      return 'the directory service';
    case 'environment':
      return '$SHELL';
  }
}

/**
 * The one line the daemon prints when its choice was not simply the owner's login shell, or undefined
 * when nothing was refused. A refused candidate that a later one replaced is still said — an owner who
 * set `terminals.shell` and got their passwd shell instead should be told why.
 */
export function describeShellChoice(choice: LoginShellChoice): string | undefined {
  if (choice.source !== undefined && choice.rejected.length === 0) return undefined;
  if (choice.rejected.length === 0)
    return `terminals: no login shell was found for this account (no terminals.shell, passwd or directory entry, or $SHELL); terminals open ${choice.shell} (the fallback).`;
  const refusals = choice.rejected
    .map(entry => `${entry.path} from ${describeSource(entry.source)} was not used because ${entry.reason}`)
    .join('; ');
  return `terminals: ${refusals}; terminals open ${choice.shell}${
    choice.source === undefined ? ' (the fallback)' : ''
  }.`;
}
