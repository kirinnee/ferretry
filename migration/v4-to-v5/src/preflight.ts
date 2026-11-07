/**
 * What must be true before anything is written: the source is a stopped v4 home, the target is new.
 * Every check reads metadata or the plain-text layout marker only — never a state file's content.
 */
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { V4_LAYOUT_VERSION, v4Paths } from './v4/layout.ts';

export type Preflight = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/** Who holds a path open, without reading it. Injected so tests do not depend on the host's process table. */
export interface LockProbe {
  /** `true` held, `false` not held, `undefined` cannot tell on this host. */
  held(path: string): Promise<boolean | undefined>;
}

export async function preflight(from: string, to: string, lock: LockProbe): Promise<Preflight> {
  const problems: string[] = [];
  const v4 = v4Paths(from);

  const source = await stat(from).catch(() => undefined);
  if (!source?.isDirectory()) return { ok: false, problems: [`${from} is not a folder`] };

  if (await exists(join(from, 'home.json'))) {
    problems.push(`${from} has a home.json: it is already a v5 home, not a v4 one`);
  }
  const marker = await readFile(v4.layoutVersion, 'utf8').catch(() => undefined);
  if (marker === undefined) {
    problems.push(`${from} has no layout-version file, so it is not a v4 home`);
  } else if (marker !== `${V4_LAYOUT_VERSION}\n`) {
    problems.push(
      `${from}/layout-version says ${JSON.stringify(marker.trim())}; this tool converts layout ${V4_LAYOUT_VERSION} (4.291.x) only. Update v4 to 4.291.x first.`,
    );
  }
  if (await exists(v4.daemonLock)) {
    const held = await lock.held(v4.daemonLock);
    if (held === true) problems.push(`the v4 daemon is still running (it holds ${v4.daemonLock}); stop it first`);
    if (held === undefined) problems.push(`cannot tell whether a v4 daemon holds ${v4.daemonLock} on this host`);
  }

  const resolvedFrom = await realpath(from);
  const target = await stat(to).catch(() => undefined);
  if (target !== undefined) {
    if (!target.isDirectory()) problems.push(`${to} exists and is not a folder`);
    else if ((await readdir(to)).length > 0) problems.push(`${to} is not empty; the converter only writes a NEW home`);
  }
  const resolvedTo = target === undefined ? to : await realpath(to);
  if (inside(resolvedFrom, resolvedTo) || inside(resolvedTo, resolvedFrom)) {
    problems.push(`${to} and ${from} overlap; the new home must be a separate folder`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== child);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/**
 * The host's lock probe: on Linux, whether any process has the file open (`/proc/<pid>/fd` links); elsewhere
 * `undefined` unless `lsof` answers. Reads link targets only, never a file.
 */
export function hostLockProbe(): LockProbe {
  return {
    async held(path) {
      const target = await realpath(path);
      if (process.platform === 'linux') {
        const pids = (await readdir('/proc').catch(() => [] as string[])).filter(name => /^\d+$/.test(name));
        for (const pid of pids) {
          const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
          for (const fd of fds) {
            if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === target) return true;
          }
        }
        return false;
      }
      const lsof = Bun.spawnSync(['lsof', '-t', '--', target], { stdout: 'pipe', stderr: 'ignore' });
      if (lsof.exitCode === 0) return lsof.stdout.toString().trim().length > 0;
      if (lsof.exitCode === 1) return false;
      return undefined;
    },
  };
}
