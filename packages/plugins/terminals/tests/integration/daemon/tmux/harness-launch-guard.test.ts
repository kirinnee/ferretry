import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import should from 'should';
import { RealHarnessLaunchGuard } from '../../../../daemon/adapters/tmux/harness-launch-guard.ts';
import { RealHarnessRefusedError, UnprovableHarnessError } from '../../../../daemon/lib/tmux/harness-guard.ts';

async function executable(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

/** A machine with a fake harness pair and, separately, what a real native install looks like. */
async function machine(): Promise<{ root: string; fakes: string; real: string; wrapper: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-harness-guard-'));
  const fakes = join(root, 'fakes');
  await executable(join(fakes, 'claude'));
  await executable(join(fakes, 'codex'));
  const installed = await executable(join(root, 'home', '.local', 'share', 'claude', 'versions', '2.1.0'));
  const real = join(root, 'real-bin');
  await mkdir(real, { recursive: true });
  // The shape of `~/.local/bin/claude`: a link whose name says nothing about what it points at.
  await symlink(installed, join(real, 'claude'));
  const wrapper = await executable(join(root, 'state', 'fleet', 'bin', 'claude-default'));
  return { root, fakes, real, wrapper };
}

describe('RealHarnessLaunchGuard', () => {
  it('should allow a launch whose wrapper and both harness names resolve to fakes', async () => {
    // Arrange
    const subject = await machine();
    const guard = new RealHarnessLaunchGuard(() => `${subject.fakes}:${subject.real}`);

    try {
      // Act
      const actual = await guard
        .check({ session: 'work', cwd: subject.root, command: [subject.wrapper, '--session-id', 'x'] })
        .then(() => 'allowed');

      // Assert
      should(actual).equal('allowed');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('should refuse a fake wrapper whose `claude` on the pane PATH is a real install behind a link', async () => {
    // Arrange
    const subject = await machine();
    const guard = new RealHarnessLaunchGuard(() => `${subject.real}:${subject.fakes}`);

    try {
      // Act
      const actual = await guard
        .check({ session: 'work', cwd: subject.root, command: [subject.wrapper] })
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(RealHarnessRefusedError);
      const refusal = actual as RealHarnessRefusedError;
      should(refusal.harness).equal('claude');
      should(refusal.resolved).endWith(join('.local', 'share', 'claude', 'versions', '2.1.0'));
      should(refusal.install).equal('the Claude Code native installer');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it("should read the launch's own PATH before the daemon's", async () => {
    // Arrange
    const subject = await machine();
    const guard = new RealHarnessLaunchGuard(() => subject.fakes);

    try {
      // Act
      const actual = await guard
        .check({ session: 'work', cwd: subject.root, command: ['claude'], env: { PATH: subject.real } })
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(RealHarnessRefusedError);
      should((actual as RealHarnessRefusedError).harness).equal('claude');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('should resolve a relative program against the launch directory', async () => {
    // Arrange
    const subject = await machine();
    await executable(join(subject.root, 'home', '.claude', 'local', 'claude'));
    const guard = new RealHarnessLaunchGuard(() => subject.fakes);

    try {
      // Act
      const actual = await guard
        .check({ session: 'work', cwd: subject.root, command: ['./home/.claude/local/claude'] })
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(RealHarnessRefusedError);
      should((actual as RealHarnessRefusedError).install).equal('the Claude Code local install');
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });

  it('should judge the located path itself when it cannot be resolved', async () => {
    // Arrange
    const guard = new RealHarnessLaunchGuard(
      () => '/anywhere',
      name => (name === 'codex' ? '/absent/home/.claude/local/codex' : undefined),
    );

    // Act
    const actual = await guard
      .check({ session: 'work', cwd: '/', command: ['agent'] })
      .catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(RealHarnessRefusedError);
    should((actual as RealHarnessRefusedError).resolved).equal('/absent/home/.claude/local/codex');
  });

  it('should refuse a launch whose opaque environment names PATH, since it cannot search what it cannot read', async () => {
    // Arrange
    const guard = new RealHarnessLaunchGuard(() => '/anywhere');

    // Act
    const actual = await guard
      .check({ session: 'work', cwd: '/', command: ['agent'], envNames: ['PATH', 'HOME'] })
      .catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(UnprovableHarnessError);
    should((actual as UnprovableHarnessError).why).equal('own-path');
  });

  it('should refuse a launch when neither the launch nor the daemon has a search path', async () => {
    // Arrange
    const missing = new RealHarnessLaunchGuard(() => undefined);
    const empty = new RealHarnessLaunchGuard(() => '');
    const launch = { session: 'work', cwd: '/', command: ['agent'] as [string] };

    // Act
    const absent = await missing.check(launch).catch((error: unknown) => error);
    const blank = await empty.check(launch).catch((error: unknown) => error);

    // Assert
    should(absent).be.instanceOf(UnprovableHarnessError);
    should((absent as UnprovableHarnessError).why).equal('no-path');
    should(blank).be.instanceOf(UnprovableHarnessError);
  });
});
