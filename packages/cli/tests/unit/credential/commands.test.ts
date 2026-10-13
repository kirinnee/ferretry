import { describe, it } from 'bun:test';
import should from 'should';
import { registerCredentialCommands, suggestCredentialId } from '../../../src/lib/credential/commands.ts';
import { renderCredentialList } from '../../../src/lib/credential/render.ts';
import { authorityOf, credential, fakeWorld, flow, machine, runCommand } from '../fleet/account-fakes.ts';

const needsSignIn = credential({
  id: 'codex-work',
  harness: 'codex',
  store: 'ferretry',
  email: undefined,
  label: 'work',
  sharedWithTerminal: false,
  needsLabel: true,
  status: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'not_signed_in',
    explanation: 'Nobody has signed in yet.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: { usedPercent: 50 } },
  usedBy: [],
});

describe('suggestCredentialId', () => {
  it('should make an id from the tool and label, and add a number until it is free', () => {
    should(suggestCredentialId('claude', 'Work Mac!', new Set())).equal('claude-work-mac');
    should(suggestCredentialId('codex', undefined, new Set(['codex-login', 'codex-login-2']))).equal('codex-login-3');
  });
});

describe('renderCredentialList', () => {
  it('should show each login, where it lives and the sign-in command for one that needs it', () => {
    // Arrange
    const list = {
      format: 2 as const,
      machine: 'studio',
      credentials: [
        credential(),
        needsSignIn,
        credential({ id: 'env', store: 'environment', sharedWithTerminal: false, email: undefined }),
        credential({ id: 'slot', store: 'ferretry', sharedWithTerminal: false, clonedFrom: 'laptop' }),
      ],
    };

    // Act
    const text = renderCredentialList(list, 'fz');

    // Assert
    should(text).match(/claude-you {2}Claude Code {2}you@example\.com {2}— Ready/);
    should(text).match(/5-hour 12% used · weekly not measured yet/);
    should(text).match(/shared with claude in your terminal/);
    should(text).match(/codex-work {2}Codex {2}work {2}— Needs sign-in/);
    should(text)
      .match(/Used by: no runtime yet/)
      .and.match(/give one a label/)
      .and.match(/kept by Ferretry/);
    should(text)
      .match(/read from the environment/)
      .and.match(/copied from laptop/);
    should(text).match(/Needs sign-in:\n {2}fz credential signin codex-work$/);
  });

  it('should say how to add the first login', () => {
    should(renderCredentialList({ format: 2, machine: 'studio', credentials: [] }, 'fz')).match(
      /fz credential add claude/,
    );
  });
});

describe('registerCredentialCommands', () => {
  it('should ask a caller off this machine for the operator password once, for the add and the sign-in', async () => {
    const world = fakeWorld({
      gateway: { machine: () => machine({ authority: authorityOf({ confirmation: 'operator-password' }) }) },
    });
    await runCommand(registerCredentialCommands, world, ['credential', 'add', 'claude']);
    should(world.prompt.secrets).have.length(1);
    should(world.gateway.called('startSignIn')[0]?.args[1]).eql({ password: 'operator-password-1' });
  });

  it('should list the logins, or print them as JSON', async () => {
    const world = fakeWorld({
      gateway: { credentials: () => ({ format: 2, machine: 'studio', credentials: [credential()] }) },
    });
    await runCommand(registerCredentialCommands, world, ['credentials']);
    should(world.out.text('report')).match(/Logins on studio/);

    const json = fakeWorld();
    await runCommand(registerCredentialCommands, json, ['credentials', '--json']);
    should(JSON.parse(json.out.text('report')).machine).equal('studio');
  });

  it('should add a login with a free id and then sign it in', async () => {
    // Arrange
    const world = fakeWorld({
      gateway: {
        credentials: () => ({ format: 2, machine: 'studio', credentials: [credential({ id: 'claude-work' })] }),
      },
    });

    // Act
    await runCommand(registerCredentialCommands, world, ['credential', 'add', 'Claude', '--label', 'work']);

    // Assert
    should(world.gateway.called('stage')[0]?.args[0]).eql({
      kind: 'credential.add',
      id: 'claude-work-2',
      harness: 'claude',
      label: 'work',
    });
    should(world.gateway.called('startSignIn')[0]?.args[0]).equal('claude-work-2');
    should(world.out.text('success')).match(/Signed in\. claude-work-2/);
  });

  it('should add without signing in when asked, and not sign in after a dry run', async () => {
    const later = fakeWorld();
    await runCommand(registerCredentialCommands, later, [
      'credential',
      'add',
      'codex',
      '--id',
      'codex-x',
      '--no-sign-in',
    ]);
    should(later.gateway.called('startSignIn')).be.empty();
    should(later.out.text('report')).match(/fz credential signin codex-x/);

    const dry = fakeWorld();
    await runCommand(registerCredentialCommands, dry, ['credential', 'add', 'codex', '--dry-run']);
    should(dry.gateway.called('startSignIn')).be.empty();
  });

  it('should refuse a tool it does not know', async () => {
    const world = fakeWorld();
    await should(runCommand(registerCredentialCommands, world, ['credential', 'add', 'gemini'])).be.rejectedWith(
      /use claude or codex/,
    );
  });

  it('should exit non-zero when a check finds the login needs sign-in', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { check: () => needsSignIn } });

    // Act
    await runCommand(registerCredentialCommands, world, ['credential', 'check', 'codex-work']);

    // Assert
    should(world.out.text('report')).match(/Needs sign-in/);
    should(world.out.text('error')).equal('codex-work needs sign-in: fz credential signin codex-work');
    should(world.out.exitCode).equal(1);
  });

  it('should pass a check that is fine, and print it as JSON', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, ['credential', 'check', 'claude-you']);
    should(world.out.exitCode).be.undefined();

    const json = fakeWorld({ gateway: { check: () => needsSignIn } });
    await runCommand(registerCredentialCommands, json, ['credential', 'check', 'codex-work', '--json']);
    should(JSON.parse(json.out.text('report')).id).equal('codex-work');
    should(json.out.text('error')).equal('');
    should(json.out.exitCode).equal(1);
  });

  it('should sign in, and exit non-zero when it fails', async () => {
    const world = fakeWorld({
      gateway: { startSignIn: () => flow({ state: 'failed', reason: 'no', remedy: 'retry' }) },
    });
    await runCommand(registerCredentialCommands, world, ['credential', 'signin', 'claude-you']);
    should(world.out.exitCode).equal(1);
  });

  it('should sign out and remove only after a yes', async () => {
    const world = fakeWorld({ answers: ['y', 'n'] });
    await runCommand(registerCredentialCommands, world, ['credential', 'signout', 'claude-you']);
    await runCommand(registerCredentialCommands, world, ['credential', 'rm', 'claude-you']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'credential.signout', id: 'claude-you' },
      { kind: 'credential.remove', id: 'claude-you' },
    ]);
    should(world.gateway.called('apply')).have.length(1);
  });

  it('should label a login, clear a label, and refuse an empty one', async () => {
    const world = fakeWorld();
    await runCommand(registerCredentialCommands, world, ['credential', 'label', 'claude-you', ' work ']);
    await runCommand(registerCredentialCommands, world, ['credential', 'label', 'claude-you', '--clear']);
    should(world.gateway.called('stage').map(call => call.args[0])).eql([
      { kind: 'credential.label', id: 'claude-you', label: 'work' },
      { kind: 'credential.label', id: 'claude-you', label: null },
    ]);
    await should(
      runCommand(registerCredentialCommands, fakeWorld(), ['credential', 'label', 'claude-you']),
    ).be.rejectedWith(/--clear/);
  });
});
