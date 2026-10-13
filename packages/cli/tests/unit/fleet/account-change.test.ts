import { describe, it } from 'bun:test';
import should from 'should';
import { WriteAuthority } from '../../../src/lib/fleet/account-authority.ts';
import { confirmStep, runChange } from '../../../src/lib/fleet/account-change.ts';
import { CHANGE_ID, changeView, credential, fakeWorld, permissions } from './account-fakes.ts';

const removeRuntime = { kind: 'runtime.remove', name: 'old' } as const;

describe('WriteAuthority', () => {
  it('should owe nothing on this machine and never ask', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    const authority = await WriteAuthority.open(world.deps);

    // Assert
    should(authority.current).eql({});
    should(await authority.forApply()).eql({});
    should(world.prompt.secrets).be.empty();
  });

  it('should unlock a locked caller before staging and send the password once for the apply', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: {
        permissions: () => permissions({ mayApply: false, applyRefusal: 'locked', confirmation: 'operator-password' }),
      },
    });

    // Act
    const authority = await WriteAuthority.open(world.deps);
    const applied = await authority.forApply();

    // Assert
    should(world.gateway.called('unlock')[0]?.args).eql(['operator-password-1']);
    should(authority.current).eql({ unlock: 'unlock-token' });
    should(applied).eql({ unlock: 'unlock-token', password: 'operator-password-1' });
    should(world.prompt.secrets).have.length(1);
  });

  it('should ask for the password only at the apply when the caller is not locked', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { permissions: () => permissions({ confirmation: 'operator-password' }) } });
    const authority = await WriteAuthority.open(world.deps);

    // Act
    should(world.prompt.secrets).be.empty();
    const applied = await authority.forApply();

    // Assert
    should(applied).eql({ password: 'operator-password-1' });
  });

  it('should read the password from standard input off a terminal', async () => {
    // Arrange
    const world = fakeWorld({
      interactive: false,
      stdinPassword: 'piped-password-1',
      gateway: { permissions: () => permissions({ confirmation: 'operator-password' }) },
    });

    // Act
    const applied = await (await WriteAuthority.open(world.deps)).forApply();

    // Assert
    should(applied).eql({ password: 'piped-password-1' });
  });

  it('should say how to pipe the password when standard input has none', async () => {
    // Arrange
    const world = fakeWorld({
      interactive: false,
      gateway: { permissions: () => permissions({ confirmation: 'operator-password' }) },
    });
    const authority = await WriteAuthority.open(world.deps);

    // Act + Assert
    await should(authority.forApply()).be.rejectedWith(/standard input/);
  });

  it('should refuse a caller the operator has not granted, in words', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: { permissions: () => permissions({ mayApply: false, applyRefusal: 'not-granted' }) },
    });

    // Act + Assert
    await should(WriteAuthority.open(world.deps)).be.rejectedWith(/has not granted it/);
  });
});

describe('confirmStep', () => {
  it('should go ahead without asking under --yes', async () => {
    const world = fakeWorld();
    should(await confirmStep(world.deps, 'Go?', true)).be.true();
    should(world.prompt.questions).be.empty();
  });

  it('should refuse off a terminal without --yes and exit non-zero', async () => {
    const world = fakeWorld({ interactive: false });
    should(await confirmStep(world.deps, 'Go?', undefined)).be.false();
    should(world.out.exitCode).equal(1);
    should(world.out.text('error')).match(/--yes/);
  });

  it('should go ahead on "y" and stop on anything else', async () => {
    const yes = fakeWorld({ answers: ['Y'] });
    should(await confirmStep(yes.deps, 'Go?', undefined)).be.true();
    should(yes.prompt.questions).eql(['Go? [y/N]']);

    const no = fakeWorld({ answers: ['nope'] });
    should(await confirmStep(no.deps, 'Go?', undefined)).be.false();
    should(no.out.exitCode).equal(1);
    should(no.out.text('warn')).equal('Nothing was changed.');
  });
});

describe('runChange', () => {
  it('should show the preview and apply a non-destructive change without asking', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    const outcome = await runChange(world.deps, { change: removeRuntime, destructive: false, options: {} });

    // Assert
    should(outcome?.outcome).equal('applied');
    should(world.prompt.questions).be.empty();
    should(world.gateway.called('apply')[0]?.args).eql([CHANGE_ID, {}]);
    should(world.out.text('report'))
      .match(/Add runtime claude-work/)
      .and.match(/config\.yaml/)
      .and.match(/claude-work \(Claude Code, agent\) — ready to launch/);
    should(world.out.text('success')).equal('Done.');
    should(world.out.exitCode).be.undefined();
  });

  it('should stop after the preview on a dry run', async () => {
    const world = fakeWorld();
    should(
      await runChange(world.deps, { change: removeRuntime, destructive: true, options: { dryRun: true } }),
    ).be.undefined();
    should(world.gateway.called('apply')).be.empty();
    should(world.out.text('report')).match(/Dry run: nothing was changed\./);
  });

  it('should print the staged change as JSON on a dry run with --json', async () => {
    const world = fakeWorld();
    await runChange(world.deps, { change: removeRuntime, destructive: false, options: { dryRun: true, json: true } });
    should(JSON.parse(world.out.text('report')).change.id).equal(CHANGE_ID);
  });

  it('should ask before a destructive change and apply nothing on "no"', async () => {
    const world = fakeWorld({ answers: ['n'] });
    should(await runChange(world.deps, { change: removeRuntime, destructive: true, options: {} })).be.undefined();
    should(world.gateway.called('apply')).be.empty();
    should(world.out.exitCode).equal(1);
  });

  it('should print the change and its outcome as JSON', async () => {
    const world = fakeWorld();
    await runChange(world.deps, { change: removeRuntime, destructive: true, options: { yes: true, json: true } });
    const printed = JSON.parse(world.out.text('report'));
    should(printed.outcome.outcome).equal('applied');
  });

  it('should exit non-zero when the apply was undone', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: {
        apply: () => ({
          outcome: 'applied',
          apply: { outcome: 'rolled-back', failedOperation: 'write config.yaml', reason: 'disk full' },
        }),
      },
    });

    // Act
    await runChange(world.deps, { change: removeRuntime, destructive: false, options: {} });

    // Assert
    should(world.out.text('error')).equal('Nothing changed. write config.yaml failed: disk full');
    should(world.out.exitCode).equal(1);
  });

  it('should describe a sign-out and an executor preview in words', async () => {
    const signOut = fakeWorld({
      gateway: {
        stage: change =>
          changeView(change, {
            preview: { kind: 'sign-out', credential: 'claude-you', runtimesAffected: 2, signsOutTerminal: true },
          }),
        apply: () => ({ outcome: 'sign-out-failed', reason: 'logout exited 1', credential: credential() }),
      },
    });
    await runChange(signOut.deps, {
      change: { kind: 'credential.signout', id: 'claude-you' },
      destructive: true,
      options: { yes: true },
    });
    should(signOut.out.text('report'))
      .match(/Signs out claude-you: 2 runtimes will need sign-in/)
      .and.match(/your own terminal/);
    should(signOut.out.text('error')).equal('Could not sign out claude-you: logout exited 1');
    should(signOut.out.exitCode).equal(1);

    const executor = fakeWorld({
      gateway: {
        stage: change =>
          changeView(change, {
            consequences: [],
            preview: { kind: 'executor', executor: 'setup', description: 'Imports Claude Code.' },
          }),
        apply: () => ({ outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime.' }),
      },
    });
    await runChange(executor.deps, { change: { kind: 'setup.import' }, destructive: false, options: {} });
    should(executor.out.text('report')).match(/Imports Claude Code\./);
    should(executor.out.text('success')).equal('Imported 1 runtime.');
  });
});
