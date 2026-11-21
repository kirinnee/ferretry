import { afterAll, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { RunnerSessionGit } from '../../../../../daemon/adapters/session/filesystem/index.ts';
import { testDiffScratch } from '../../../../support/daemon/session-filesystem/index.ts';
import { testGitRunner } from '../../../../support/daemon/host-io.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRepository } from '../../support/repository.ts';

/**
 * The owner's GLOBAL ignore rules reach the file list (&F6061 F3).
 *
 * The hardened Git environment points `GIT_CONFIG_GLOBAL` at `/dev/null` so a hostile global config can run nothing,
 * which also drops a custom `core.excludesFile` set in `~/.gitconfig`. A file the owner told Git to ignore everywhere
 * must not turn up in a project's file list. Every case builds a fake host home in a temp folder and hands it to the
 * Git child exactly as the kernel does (`HOME`, and `XDG_CONFIG_HOME` where set); nothing reads the real `~`.
 */

afterAll(async () => {
  await cleanupTempDirectories();
});

/** A runner whose child sees `environment` as the daemon's own, the way the kernel's spawn base does. */
const gitWith = (environment: Record<string, string>): RunnerSessionGit =>
  new RunnerSessionGit(
    testGitRunner(() => ({ PATH: process.env.PATH, ...environment })),
    testDiffScratch,
  );

/** A repository holding one wanted file and one `scratch.tmp` the owner's global rules ignore. */
async function repositoryWithScratch(label: string): Promise<string> {
  const { root } = await tempRepository(label);
  await writeFile(path.join(root, 'wanted.ts'), 'x\n');
  await writeFile(path.join(root, 'scratch.tmp'), 'y\n');
  return root;
}

describe('the file list and the owner’s global ignore rules', () => {
  it('should honour ~/.config/git/ignore', async () => {
    // Arrange
    const home = await tempDirectory('home-xdg-default');
    await mkdir(path.join(home, '.config', 'git'), { recursive: true });
    await writeFile(path.join(home, '.config', 'git', 'ignore'), '*.tmp\n');
    const root = await repositoryWithScratch('global-ignore-default');

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('wanted.ts');
    should(listed.paths).not.containEql('scratch.tmp');
  });

  it('should honour $XDG_CONFIG_HOME/git/ignore when the daemon has one', async () => {
    // Arrange
    const home = await tempDirectory('home-xdg-custom');
    const config = await tempDirectory('xdg-config');
    await mkdir(path.join(config, 'git'), { recursive: true });
    await writeFile(path.join(config, 'git', 'ignore'), '*.tmp\n');
    const root = await repositoryWithScratch('global-ignore-xdg');

    // Act
    const listed = await gitWith({ HOME: home, XDG_CONFIG_HOME: config }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).not.containEql('scratch.tmp');
  });

  it('should honour core.excludesFile set in ~/.gitconfig', async () => {
    // Arrange
    const home = await tempDirectory('home-excludes-file');
    await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
    await writeFile(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
    const root = await repositoryWithScratch('global-ignore-excludes-file');

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('wanted.ts');
    should(listed.paths).not.containEql('scratch.tmp');
  });

  it('should expand a ~ in core.excludesFile the way Git does', async () => {
    // Arrange
    const home = await tempDirectory('home-excludes-tilde');
    await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
    await writeFile(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/my-ignore\n');
    const root = await repositoryWithScratch('global-ignore-tilde');

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).not.containEql('scratch.tmp');
  });

  it('should list the file when the owner has no global rule at all', async () => {
    // Arrange
    const home = await tempDirectory('home-empty');
    const root = await repositoryWithScratch('global-ignore-none');

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('scratch.tmp');
  });

  it('should still run nothing from the global config: a hostile fsmonitor or hook there is inert', async () => {
    // Arrange
    const home = await tempDirectory('home-hostile');
    const marker = path.join(home, 'ran');
    await writeFile(path.join(home, 'hook.sh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(
      path.join(home, '.gitconfig'),
      `[core]\n\tfsmonitor = ${path.join(home, 'hook.sh')}\n\thooksPath = ${home}\n\tpager = touch ${marker}\n`,
    );
    const root = await repositoryWithScratch('global-ignore-hostile');

    // Act
    await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(await Bun.file(marker).exists()).be.false();
  });

  it('should answer for a repository the global rule never touches, with the fixture still intact', async () => {
    // Arrange: a control that the fixture helper itself reads no global config.
    const root = await repositoryWithScratch('global-ignore-control');
    await setupGit(root, 'status', '--short');

    // Act
    const listed = await gitWith({ HOME: await tempDirectory('home-control') }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('scratch.tmp');
  });
});
