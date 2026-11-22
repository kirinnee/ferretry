import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { RunnerSessionGit } from '../../../../../daemon/adapters/session/filesystem/index.ts';
import { testDiffScratch } from '../../../../support/daemon/session-filesystem/index.ts';
import { testGitRunner } from '../../../../support/daemon/host-io.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRepository } from '../../support/repository.ts';

/**
 * The owner's GLOBAL ignore rules reach the file list (&F6061 F3).
 *
 * The hardened Git environment points `GIT_CONFIG_GLOBAL` at `/dev/null`, which would drop a custom `core.excludesFile`
 * set in `~/.gitconfig`. The list therefore lets Git read the owner's own config (the program-running keys stay pinned
 * by `-c`), so Git's own precedence, includes and defaults apply, and a rule Git cannot read FAILS the list rather than
 * passing it. A file the owner told Git to ignore everywhere must not turn up in a project's file list. Every case builds a fake host home in a temp folder and hands it to the
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

  it('should keep Git’s precedence: a repository’s own core.excludesFile beats the global one', async () => {
    // Arrange: the global file hides global.tmp; the repository's own hides local.tmp. Plain Git lists global.tmp only.
    const home = await tempDirectory('home-both-scopes');
    await writeFile(path.join(home, 'global-ignore'), 'global.tmp\n');
    await writeFile(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'global-ignore')}\n`);
    const root = await tempRepository('both-scopes').then(repository => repository.root);
    await writeFile(path.join(root, 'wanted.ts'), 'x\n');
    await writeFile(path.join(root, 'global.tmp'), 'y\n');
    await writeFile(path.join(root, 'local.tmp'), 'z\n');
    await writeFile(path.join(home, 'local-ignore'), 'local.tmp\n');
    await setupGit(root, 'config', 'core.excludesFile', path.join(home, 'local-ignore'));

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('wanted.ts');
    should(listed.paths).containEql('global.tmp');
    should(listed.paths).not.containEql('local.tmp');
  });

  it('should honour a core.excludesFile reached through include.path in ~/.gitconfig', async () => {
    // Arrange
    const home = await tempDirectory('home-include');
    await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
    await writeFile(path.join(home, 'split.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
    await writeFile(path.join(home, '.gitconfig'), `[include]\n\tpath = ${path.join(home, 'split.gitconfig')}\n`);
    const root = await repositoryWithScratch('global-ignore-include');

    // Act
    const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

    // Assert
    should(listed.paths).containEql('wanted.ts');
    should(listed.paths).not.containEql('scratch.tmp');
  });

  describe('when the owner’s rules cannot be established or read', () => {
    /** Runs `act` with `file` unreadable, and puts the mode back so the temp folder can be removed. */
    const unreadable = async (file: string, act: () => Promise<unknown>): Promise<unknown> => {
      await chmod(file, 0o000);
      try {
        return await act().then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        await chmod(file, 0o644);
      }
    };

    it('should refuse the list when ~/.gitconfig cannot be read, instead of listing what it hides', async () => {
      // Arrange
      const home = await tempDirectory('home-config-denied');
      await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
      const config = path.join(home, '.gitconfig');
      await writeFile(config, `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
      const root = await repositoryWithScratch('global-config-denied');

      // Act
      const failure = await unreadable(config, () => gitWith({ HOME: home }).listFiles(root, 1024 * 1024));

      // Assert
      should(failure).be.instanceof(Error);
    });

    it('should refuse the list when the ignore file itself cannot be read', async () => {
      // Arrange
      const home = await tempDirectory('home-ignore-denied');
      await mkdir(path.join(home, '.config', 'git'), { recursive: true });
      const ignore = path.join(home, '.config', 'git', 'ignore');
      await writeFile(ignore, '*.tmp\n');
      const root = await repositoryWithScratch('global-ignore-denied');

      // Act
      const failure = await unreadable(ignore, () => gitWith({ HOME: home }).listFiles(root, 1024 * 1024));

      // Assert
      should(failure).be.instanceof(Error);
    });

    it('should refuse the list when an included config cannot be read', async () => {
      // Arrange
      const home = await tempDirectory('home-include-denied');
      const included = path.join(home, 'split.gitconfig');
      await writeFile(included, '[core]\n\texcludesFile = /nowhere\n');
      await writeFile(path.join(home, '.gitconfig'), `[include]\n\tpath = ${included}\n`);
      const root = await repositoryWithScratch('global-include-denied');

      // Act
      const failure = await unreadable(included, () => gitWith({ HOME: home }).listFiles(root, 1024 * 1024));

      // Assert
      should(failure).be.instanceof(Error);
    });

    it('should refuse the list when ~/.config/git/config cannot be read, even beside a readable ~/.gitconfig', async () => {
      // Arrange: Git lists `--global` from ~/.gitconfig alone and skips an unreadable XDG config without a word, so the
      // index would otherwise be complete while hiding a rule the owner set there.
      const home = await tempDirectory('home-xdg-config-denied');
      await mkdir(path.join(home, '.config', 'git'), { recursive: true });
      await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = owner\n');
      const xdgConfig = path.join(home, '.config', 'git', 'config');
      await writeFile(xdgConfig, `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
      await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
      const root = await repositoryWithScratch('global-xdg-config-denied');

      // Act
      const failure = await unreadable(xdgConfig, () => gitWith({ HOME: home }).listFiles(root, 1024 * 1024));

      // Assert
      should(failure).be.instanceof(Error);
    });

    it('should refuse the list when the ACTIVE config ($XDG_CONFIG_HOME/git/config) cannot be read', async () => {
      // Arrange: a custom XDG_CONFIG_HOME beside a readable ~/.gitconfig. Git skips the unreadable custom config in
      // silence while `ls-files` still reads it, so the index would list a name the owner ignores globally.
      const home = await tempDirectory('home-custom-xdg-denied');
      const config = await tempDirectory('custom-xdg-denied');
      await mkdir(path.join(config, 'git'), { recursive: true });
      await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = owner\n');
      await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
      const active = path.join(config, 'git', 'config');
      await writeFile(active, `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
      const root = await repositoryWithScratch('global-custom-xdg-denied');

      // Act
      const failure = await unreadable(active, () =>
        gitWith({ HOME: home, XDG_CONFIG_HOME: config }).listFiles(root, 1024 * 1024),
      );

      // Assert
      should(failure).be.instanceof(Error);
    });

    it('should list a complete index when the custom config is readable and the INACTIVE default is not', async () => {
      // Arrange: with XDG_CONFIG_HOME set Git never reads ~/.config/git/config, so its mode must not block the list.
      const home = await tempDirectory('home-inactive-default-denied');
      const config = await tempDirectory('custom-xdg-readable');
      await mkdir(path.join(home, '.config', 'git'), { recursive: true });
      await mkdir(path.join(config, 'git'), { recursive: true });
      await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = owner\n');
      await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
      await writeFile(path.join(config, 'git', 'config'), `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`);
      const inactive = path.join(home, '.config', 'git', 'config');
      await writeFile(inactive, '[user]\n\temail = inactive@example.test\n');
      const root = await repositoryWithScratch('global-inactive-default-denied');

      // Act
      const result = await chmod(inactive, 0o000).then(async () => {
        try {
          return await gitWith({ HOME: home, XDG_CONFIG_HOME: config }).listFiles(root, 1024 * 1024);
        } finally {
          await chmod(inactive, 0o644);
        }
      });

      // Assert
      should(result.truncated).be.false();
      should(result.paths).containEql('wanted.ts');
      should(result.paths).not.containEql('scratch.tmp');
    });

    it('should still list a complete index when ~/.config/git/config is readable beside ~/.gitconfig', async () => {
      // Arrange
      const home = await tempDirectory('home-xdg-config-readable');
      await mkdir(path.join(home, '.config', 'git'), { recursive: true });
      await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = owner\n');
      await writeFile(path.join(home, 'my-ignore'), '*.tmp\n');
      await writeFile(
        path.join(home, '.config', 'git', 'config'),
        `[core]\n\texcludesFile = ${path.join(home, 'my-ignore')}\n`,
      );
      const root = await repositoryWithScratch('global-xdg-config-readable');

      // Act
      const listed = await gitWith({ HOME: home }).listFiles(root, 1024 * 1024);

      // Assert
      should(listed.truncated).be.false();
      should(listed.paths).containEql('wanted.ts');
      should(listed.paths).not.containEql('scratch.tmp');
    });

    it('should refuse the list when ~/.gitconfig is malformed', async () => {
      // Arrange
      const home = await tempDirectory('home-config-malformed');
      await writeFile(path.join(home, '.gitconfig'), '[core\n');
      const root = await repositoryWithScratch('global-config-malformed');

      // Act
      const failure = await gitWith({ HOME: home })
        .listFiles(root, 1024 * 1024)
        .catch((error: unknown) => error);

      // Assert
      should(failure).be.instanceof(Error);
    });
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
