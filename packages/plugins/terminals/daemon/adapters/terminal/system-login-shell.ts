import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  chooseLoginShell,
  describeShellChoice,
  directoryServiceShell,
  listedShells,
  type LoginShellCandidate,
  type LoginShellPort,
  passwdShell,
} from '../../lib/terminal/login-shell.ts';

/** The facts about this machine and account the login shell is read from; every one is injected. */
export interface SystemLoginShellSources {
  readonly platform: string;
  readonly uid: number | undefined;
  readonly username: string | undefined;
  readonly environmentShell: string | undefined;
  readonly passwdFile: string;
  readonly shellsFile: string;
  /** `terminals.shell` from `config/daemon.json`, or undefined when the operator did not set one. */
  readonly configured: () => Promise<string | undefined>;
  /** Standard output of a program that exited 0, or undefined if it is missing or failed. */
  readonly run: (argv: readonly string[]) => Promise<string | undefined>;
  readonly report: (message: string) => void;
}

async function readText(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch(() => undefined);
}

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A user name safe to place in a directory-service path: nothing that could climb out of `/Users/`. */
function plainUserName(name: string | undefined): name is string {
  return name !== undefined && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/u.test(name) && name !== '.' && name !== '..';
}

/**
 * The owner's login shell, resolved ONCE for the life of the daemon and shared by every terminal.
 *
 * Order: the operator's `terminals.shell`, the account's own entry (the passwd file, or the directory
 * service on macOS where a launchd daemon often has no `$SHELL`), then `$SHELL`, then `/bin/sh`. A
 * candidate is used only when `/etc/shells` lists it and it is an executable file; the first refusal
 * and the fallback are said once, on stderr. Resolution never rejects: a terminal that cannot find the
 * owner's shell still opens `/bin/sh`.
 */
export class SystemLoginShell implements LoginShellPort {
  private resolved: Promise<string> | undefined;

  constructor(private readonly sources: SystemLoginShellSources) {}

  shell(): Promise<string> {
    this.resolved ??= this.resolve();
    return this.resolved;
  }

  private async resolve(): Promise<string> {
    const { sources } = this;
    const [configured, account, shellsText] = await Promise.all([
      sources.configured().catch(() => undefined),
      this.account().catch(() => undefined),
      readText(sources.shellsFile),
    ]);
    const candidates: LoginShellCandidate[] = [];
    if (configured !== undefined) candidates.push({ source: 'config', path: configured });
    if (account !== undefined) candidates.push(account);
    if (sources.environmentShell !== undefined && sources.environmentShell !== '')
      candidates.push({ source: 'environment', path: sources.environmentShell });
    const choice = await chooseLoginShell(
      candidates,
      shellsText === undefined ? undefined : listedShells(shellsText),
      executableFile,
    );
    const notice = describeShellChoice(choice);
    if (notice !== undefined) sources.report(`${notice}\n`);
    return choice.shell;
  }

  private async account(): Promise<LoginShellCandidate | undefined> {
    const { sources } = this;
    if (sources.platform === 'darwin') {
      if (!plainUserName(sources.username)) return undefined;
      const output = await sources.run(['/usr/bin/dscl', '.', '-read', `/Users/${sources.username}`, 'UserShell']);
      const path = output === undefined ? undefined : directoryServiceShell(output);
      return path === undefined ? undefined : { source: 'directory-service', path };
    }
    if (sources.uid === undefined) return undefined;
    // getent answers for accounts the file does not hold (LDAP, SSSD); the file is the floor.
    const entry = await sources.run(['getent', 'passwd', String(sources.uid)]);
    const fromEntry = entry === undefined ? undefined : passwdShell(entry, sources.uid);
    const path = fromEntry ?? passwdShell((await readText(sources.passwdFile)) ?? '', sources.uid);
    return path === undefined ? undefined : { source: 'passwd', path };
  }
}

export async function runProgram(argv: readonly string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The account name, or undefined when this uid has no passwd entry (a container run as an arbitrary uid). */
export function accountName(read: () => string): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The production wiring: this process's account, the real system files, and stderr for the notice. */
export function systemLoginShell(
  configured: () => Promise<string | undefined>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SystemLoginShell {
  const username = accountName(() => userInfo().username);
  return new SystemLoginShell({
    platform: process.platform,
    uid: process.getuid?.(),
    username,
    environmentShell: environment.SHELL,
    passwdFile: '/etc/passwd',
    shellsFile: '/etc/shells',
    configured,
    run: runProgram,
    report: message => process.stderr.write(message),
  });
}
