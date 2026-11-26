import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots: string[] = [];
export async function tempDirectory(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `${label}-`)));
  roots.push(root);
  return root;
}
export async function cleanupTempDirectories(): Promise<void> {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
}
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
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`synthetic Git ${args[0]}: ${error}`);
  return out;
}
export async function tempRepository(label: string) {
  const root = await tempDirectory(label);
  await setupGit(root, 'init', '-b', 'main', '--quiet');
  await Bun.write(path.join(root, 'README.md'), '# fixture\n');
  await setupGit(root, 'add', 'README.md');
  await setupGit(root, 'commit', '-qm', 'chore: fixture');
  return { root };
}
export async function tempRemote(repository: string, name: string, branch: string) {
  const root = await tempDirectory('tidy-remote');
  await setupGit(root, 'init', '--bare', '-b', 'main', '--quiet');
  await setupGit(repository, 'remote', 'add', name, root);
  await setupGit(repository, 'push', name, branch);
}
