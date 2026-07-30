import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetLoginSpawn, ProcessFleetLoginPort } from '../../src/adapters/process-login.ts';
import type { FleetManifestAccount } from '../../src/lib/manifest.ts';

const account = (kind: FleetManifestAccount['kind']): FleetManifestAccount => ({
  id: kind === 'claude' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002',
  kind,
  mode: 'auto',
  wrapper: `/tmp/fy-test/bin/alias-${kind}-with-hyphens`,
  home: `/tmp/fy-test/homes/${kind}`,
  displayName: `Placeholder ${kind}`,
  defaultModel: 'model-one',
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  available: true,
  unavailableReason: null,
});

describe('ProcessFleetLoginPort', () => {
  it('should execute the manifest wrapper attribute without parsing its filename', async () => {
    // Arrange
    const calls: Array<{ command: readonly string[]; cwd?: string }> = [];
    const spawn: FleetLoginSpawn = (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(spawn, { FY_TEST_TOKEN: 'placeholder' }, () => true, '/tmp/fy-test');
    const target = account('claude');

    // Act
    const actual = await subject.login(target);

    // Assert
    should(calls).deepEqual([{ command: [target.wrapper, '/login'], cwd: '/tmp/fy-test' }]);
    should(actual).deepEqual({ status: 'logged-in' });
  });

  it('should use the Codex login subcommand and report a non-zero exit', async () => {
    // Arrange
    const commands: string[][] = [];
    const spawn: FleetLoginSpawn = command => {
      commands.push([...command]);
      return { exited: Promise.resolve(7) };
    };
    const subject = new ProcessFleetLoginPort(spawn, {}, () => true);
    const target = account('codex');

    // Act
    const actual = await subject.login(target);

    // Assert
    should(commands).deepEqual([[target.wrapper, 'login']]);
    should(actual).deepEqual({ status: 'failed', message: 'login process exited with code 7' });
  });

  it('should skip accounts whose configured authentication does not require login', async () => {
    // Arrange
    let spawned = false;
    const spawn: FleetLoginSpawn = () => {
      spawned = true;
      return { exited: Promise.resolve(0) };
    };
    const subject = new ProcessFleetLoginPort(spawn, {}, () => false);

    // Act
    const actual = await subject.login(account('claude'));

    // Assert
    should(spawned).be.false();
    should(actual).deepEqual({ status: 'not-required' });
  });
});
