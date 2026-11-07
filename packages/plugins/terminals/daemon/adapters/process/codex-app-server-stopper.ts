/**
 * The process boundary {@link CodexAppServerSupervisor} decides over: reading Codex's pid files,
 * reading a process's command line and environment, and asking one process to exit.
 *
 * Linux reads `/proc`, which needs no helper and is exact. macOS has no `/proc`, so it asks `ps`:
 * `-o command=` for a command line and `-E` for the environment of this user's own processes
 * (INFERRED from the BSD `ps` manual; not run here). Any answer this cannot get is `undefined`, which
 * the supervisor reads as "leave the daemon running".
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CodexAppServerProcesses } from '../../lib/fleet/codex-runtime.ts';

export interface CodexAppServerProcessOptions {
  readonly platform: NodeJS.Platform;
  /** An absolute `ps`, needed on a platform with no `/proc`. */
  readonly psExecutable?: string;
  /** Where Linux keeps its process table. A parameter so a test can hand it a fake one. */
  readonly procRoot?: string;
  readonly signal?: (pid: number) => void;
}

export class HostCodexAppServerProcesses implements CodexAppServerProcesses {
  readonly #proc: string;

  constructor(private readonly options: CodexAppServerProcessOptions) {
    this.#proc = options.procRoot ?? '/proc';
  }

  async read(path: string): Promise<string | undefined> {
    return await readFile(path, 'utf8').catch(() => undefined);
  }

  async commandLine(pid: number): Promise<string | undefined> {
    if (this.options.platform === 'linux') {
      const raw = await readFile(`${this.#proc}/${pid}/cmdline`, 'utf8').catch(() => undefined);
      if (raw === undefined || raw === '') return undefined;
      return raw.replace(/\0+$/u, '').split('\0').join(' ');
    }
    const out = await this.#ps(['-ww', '-o', 'command=', '-p', String(pid)]);
    const line = out?.trim();
    return line === undefined || line === '' ? undefined : line;
  }

  async usersOf(codexHome: string): Promise<readonly number[] | undefined> {
    const wanted = `CODEX_HOME=${codexHome}`;
    if (this.options.platform === 'linux') {
      const entries = await readdir(this.#proc).catch(() => undefined);
      if (entries === undefined) return undefined;
      const users: number[] = [];
      for (const entry of entries) {
        if (!/^\d+$/u.test(entry)) continue;
        // Another user's process, or one that has just exited, cannot be read and is not ours.
        const environ = await readFile(`${this.#proc}/${entry}/environ`, 'utf8').catch(() => undefined);
        if (environ?.split('\0').includes(wanted)) users.push(Number(entry));
      }
      return users;
    }
    const out = await this.#ps(['-wwEx', '-o', 'pid=,command=']);
    if (out === undefined) return undefined;
    const users: number[] = [];
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      if (match === null) continue;
      const words = (match[2] as string).split(/\s+/u);
      if (words.includes(wanted)) users.push(Number(match[1]));
    }
    return users;
  }

  async terminate(pid: number): Promise<void> {
    try {
      (this.options.signal ?? (target => process.kill(target, 'SIGTERM')))(pid);
    } catch {
      // Already gone between the check and the signal: the outcome somebody wanted.
    }
  }

  async #ps(args: readonly string[]): Promise<string | undefined> {
    const ps = this.options.psExecutable;
    if (ps === undefined || !isAbsolute(ps)) return undefined;
    try {
      const child = Bun.spawn([ps, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 ? stdout : undefined;
    } catch {
      return undefined;
    }
  }
}
