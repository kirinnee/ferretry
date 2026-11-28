import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { afterAll, afterEach } from 'bun:test';

const fixtureRoots = new Set<string>();
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

const privateWorktrees = new Set<string>();
afterEach(() => {
  for (const root of privateWorktrees) rmSync(root, { recursive: true, force: true });
  privateWorktrees.clear();
});

function privateWorktreeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'relocate-private-worktrees-'));
  privateWorktrees.add(root);
  return root;
}

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

export function git(cwd: string, ...args: string[]): string {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

/** Synthetic raw tree objects cannot be made through porcelain: this input path deliberately constructs hostile packs. */
export function gitInput(cwd: string, input: Uint8Array, ...args: string[]): string {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV, stdin: input });
  if (done.exitCode !== 0) throw new Error('the synthetic git object could not be made');
  return done.stdout.toString().trim();
}

/**
 * The kernel's spawn and roots as far as the working tree uses them, over the real disk: real git, real files. The
 * folder handle refuses what the kernel's `imports` root refuses for this use (a `..`, a link, a second hard link).
 */
export function realKernel(
  remotes: ReadonlyMap<string, string> = new Map(),
  worktrees = privateWorktreeRoot(),
): Pick<KernelPorts, 'roots' | 'spawn' | 'clock'> {
  mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  return {
    clock: { nowMs: () => performance.now() } as KernelPorts['clock'],
    spawn: {
      run: async () => {
        throw new Error('not used');
      },
      start: () => {
        throw new Error('not used');
      },
      runBytes: async (program, args, options) => {
        let invocation = [...args];
        if (program === 'git' && args.includes('clone')) {
          const remote = args[args.length - 2] ?? '';
          const fixture = remotes.get(remote);
          if (fixture === undefined || fixture === '') throw new Error('test network fence: no external git transport');
          invocation = [
            ...args.slice(0, args.indexOf('clone')),
            '-c',
            'protocol.file.allow=always',
            ...args.slice(args.indexOf('clone'), -2),
            fixture,
            args.at(-1) as string,
          ];
        }
        const child = Bun.spawn([program, ...invocation], {
          env: { ...GIT_ENV, ...(options?.env as Readonly<Record<string, string>> | undefined) },
          cwd: typeof options?.cwd === 'string' ? options.cwd : options?.cwd?.describe,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: options?.stdin === undefined ? 'ignore' : 'pipe',
        });
        if (options?.stdin !== undefined) {
          const sink = child.stdin as unknown as { write(data: Uint8Array): unknown; end(): unknown };
          sink.write(
            typeof options.stdin === 'string' ? new TextEncoder().encode(options.stdin) : new Uint8Array(options.stdin),
          );
          sink.end();
        }
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
      root: (name: string, scope?: { readonly subfolder?: string }) => {
        const base = name === 'worktrees' ? worktrees : (scope?.subfolder ?? '');
        return {
          resolve: (relative: string) =>
            relative.startsWith('/') || relative.split('/').includes('..')
              ? { ok: false, error: 'outside' }
              : { ok: true, value: join(base, relative) },
          pin: async (path: string) => ({
            policyCwd: { describe: path, install: () => () => {} },
            close: async () => {},
          }),
          realPath: async (path: string) => realpathSync(path),
          fileIdentity: async (path: string) => {
            const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
            return stat === undefined ? undefined : { device: stat.dev, inode: stat.ino };
          },
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
          readBytes: async (path: string, limit?: number) =>
            new Uint8Array(await Bun.file(path).arrayBuffer()).slice(0, limit),
          makeDirectory: async (path: string) => {
            mkdirSync(path, { recursive: true });
          },
          createDirectory: async (path: string) => {
            mkdirSync(path, { mode: 0o700 });
            const stat = lstatSync(path, { bigint: true });
            return { device: stat.dev, inode: stat.ino };
          },
          writeBytes: async (path: string, bytes: Uint8Array, options?: { readonly exclusive?: boolean }) => {
            if (options?.exclusive === true && lstatSync(path, { throwIfNoEntry: false }) !== undefined)
              throw new Error('exists');
            writeFileSync(path, bytes);
          },
          remove: async (path: string, options?: { expectedIdentity?: { device: bigint; inode: bigint } }) => {
            if (options?.expectedIdentity !== undefined) {
              const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
              if (stat === undefined) return;
              if (stat.dev !== options.expectedIdentity.device || stat.ino !== options.expectedIdentity.inode)
                throw new Error('changed');
            }
            rmSync(path, { recursive: true, force: true });
          },
        };
      },
    } as unknown as KernelPorts['roots'],
  };
}

/** The address a fixture's project is known by on both machines: never contacted. */
export const REMOTE_URL = 'https://example.invalid/acme/project.git';

export interface Fixture {
  readonly folder: string;
  /** The bare repository the fixture pushed to: a target's own clone of the project comes from here. */
  readonly remote: string;
  /** Every planted value a move must never carry, by the file it was planted in. */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * A repository like a ferret's: a remote with the first commit, one local commit the remote lacks, an uncommitted change to a
 * tracked file, new files (one plain, two named like secrets), and ignored files (`.env`, `node_modules/`).
 */
export function makeRepository(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'relocate-fixture-'));
  fixtureRoots.add(root);
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
  // A network-shaped address, so a move can match the project by it; the bare repository above is where the commits are.
  git(folder, 'remote', 'set-url', 'origin', REMOTE_URL);
  // ... and a push (a test that publishes the local commit) still lands in the bare repository, never on the network.
  git(folder, 'remote', 'set-url', '--push', 'origin', remote);
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
  return { folder, remote, secrets };
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
