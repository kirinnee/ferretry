import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';

/** A hermetic git: no user config, no system config, a fixed identity, so a fixture is the same on every machine. */
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

/**
 * The kernel's spawn and roots as far as the working tree uses them, over the real disk: real git, real files. The
 * folder handle refuses what the kernel's `imports` root refuses for this use (a `..`, a link, a second hard link).
 */
export function realKernel(): Pick<KernelPorts, 'roots' | 'spawn'> {
  return {
    spawn: {
      run: async () => {
        throw new Error('not used');
      },
      start: () => {
        throw new Error('not used');
      },
      runBytes: async (program, args, options) => {
        const child = Bun.spawn([program, ...args], { env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
        const out = new Uint8Array(await new Response(child.stdout).arrayBuffer());
        const exitCode = await child.exited;
        const cap = options?.maxStdoutBytes ?? 1024 * 1024;
        return {
          exitCode,
          stdout: out.slice(0, cap),
          stderr: await new Response(child.stderr).text(),
          stdoutTruncated: out.length > cap,
          stderrTruncated: false,
          timedOut: false,
        };
      },
    },
    roots: {
      root: (_name: string, scope?: { readonly subfolder?: string }) => {
        const base = scope?.subfolder ?? '';
        return {
          resolve: (relative: string) =>
            relative.startsWith('/') || relative.split('/').includes('..')
              ? { ok: false, error: 'outside' }
              : { ok: true, value: join(base, relative) },
          lstat: async (path: string) => {
            try {
              const s = lstatSync(path);
              return {
                kind: s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other',
                size: s.size,
                links: s.nlink,
                mode: s.mode & 0o7777,
                modified: s.mtime.toISOString(),
              };
            } catch {
              return undefined;
            }
          },
          readBytes: async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer()),
        };
      },
    } as unknown as KernelPorts['roots'],
  };
}

export interface Fixture {
  readonly folder: string;
  /** Every planted value a move must never carry, by the file it was planted in. */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * A repository like a ferret's: a remote with the first commit, one local commit the remote lacks, an uncommitted change to a
 * tracked file, new files (one plain, two named like secrets), and ignored files (`.env`, `node_modules/`).
 */
export function makeRepository(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'relocate-fixture-'));
  const remote = join(root, 'remote.git');
  const folder = join(root, 'work');
  mkdirSync(folder, { recursive: true });
  git(root, 'init', '--bare', '-q', '-b', 'main', remote);
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'remote', 'add', 'origin', remote);
  writeFileSync(join(folder, '.gitignore'), '.env\nnode_modules/\n');
  writeFileSync(join(folder, 'README.md'), 'a project\n');
  writeFileSync(join(folder, 'tracked.txt'), 'one\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'first');
  git(folder, 'push', '-q', 'origin', 'main');
  writeFileSync(join(folder, 'second.txt'), 'two\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'second (not pushed)');
  writeFileSync(join(folder, 'tracked.txt'), 'one\nchanged\n');
  writeFileSync(join(folder, 'new.txt'), 'a new file\n');
  const secrets = {
    '.env': 'IGNORED-ENV-VALUE-91c3',
    '.env.local': 'UNTRACKED-ENV-LOCAL-VALUE-77ab',
    'deploy.pem': 'UNTRACKED-PEM-VALUE-5d20',
  };
  writeFileSync(join(folder, '.env'), `${secrets['.env']}\n`);
  writeFileSync(join(folder, '.env.local'), `${secrets['.env.local']}\n`);
  writeFileSync(join(folder, 'deploy.pem'), `${secrets['deploy.pem']}\n`);
  mkdirSync(join(folder, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(folder, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  return { folder, secrets };
}

/** Every file below a folder, as `relative path → bytes`, for a byte-for-byte comparison before and after. */
export function snapshotOf(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (name === '.git') continue;
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else out.set(`${prefix}${name}`, readFileSync(path, 'utf8'));
    }
  };
  walk(folder, '');
  return out;
}
