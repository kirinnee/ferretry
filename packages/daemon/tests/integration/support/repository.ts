import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Every integration test in this tier operates on throwaway repositories under the OS temp
 * directory. Nothing here may ever resolve a developer checkout or a real state home.
 */
const created: string[] = [];

/** Git for *fixture setup only* — never the adapter under test, so setup failures are loud. */
export async function setupGit(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout;
}

/** A temp directory that the suite deletes on teardown. */
export async function tempDirectory(label: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), `fy-${label}-`)));
  created.push(directory);
  return directory;
}

export async function cleanupTempDirectories(): Promise<void> {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

/** A directory holding a stub `git` executable, for driving timeout and failure paths. */
export async function stubGitDirectory(script: string): Promise<string> {
  const directory = await tempDirectory('stub-git');
  const executable = path.join(directory, 'git');
  await Bun.write(executable, script);
  await chmod(executable, 0o700);
  return directory;
}

export interface TempRepository {
  readonly root: string;
  readonly head: string;
}

/** A repository on `main` with one commit, no remote, and no global Git config in reach. */
export async function tempRepository(label = 'repo'): Promise<TempRepository> {
  const root = await tempDirectory(label);
  await setupGit(root, 'init', '-b', 'main', '--quiet');
  await Bun.write(path.join(root, 'README.md'), '# fixture\n');
  await setupGit(root, 'add', 'README.md');
  await setupGit(root, 'commit', '--quiet', '-m', 'chore: seed');
  const head = (await setupGit(root, 'rev-parse', 'HEAD')).trim();
  return { root, head };
}

/** Adds a bare repository as `remoteName` and pushes `branch` to it. */
export async function tempRemote(repository: string, remoteName: string, branch: string): Promise<string> {
  const remote = await tempDirectory(`${remoteName}-remote`);
  await setupGit(remote, 'init', '--bare', '--quiet', '-b', 'main');
  await setupGit(repository, 'remote', 'add', remoteName, remote);
  await setupGit(repository, 'push', '--quiet', remoteName, branch);
  return remote;
}
