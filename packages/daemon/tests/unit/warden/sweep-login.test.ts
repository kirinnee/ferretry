import { describe, it } from 'bun:test';
import should from 'should';
import { WardenRequestError } from '../../../src/lib/warden/index.ts';
import { enabled, harness, journalTypes, session, triageable, unattended } from './sweep-harness.ts';

/**
 * Which login an investigation runs on. No name is compiled in: the owner's own order, else the
 * machine's default runtime read fresh, else "not set" — and a name this machine does not have is
 * shown as unknown and never used.
 */

const noDefault = async (): Promise<string | undefined> => undefined;

describe('the investigation login when the owner chose none', () => {
  it('should run on the machine default runtime and never write it back', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-default']);
    should(subject.storedConfig()).have.property('accounts', []);
  });

  it('should say where the login came from on the status and the configuration read', async () => {
    // Arrange
    const subject = harness({ config: enabled() });

    // Act
    const status = await subject.service.status();
    const view = await subject.service.view();

    // Assert
    should(status.login).deepEqual({ source: 'machine_default', unknown: [], available: ['claude-default'] });
    should(status.failover?.accounts.map(account => account.agent)).deepEqual(['claude-default']);
    should(view.accounts).deepEqual([{ agent: 'claude-default' }]);
    should(view.login?.source).equal('machine_default');
  });

  it('should read an unreadable default runtime as none', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      defaultRuntime: async () => {
        throw new Error('machine.yaml is unreadable');
      },
    });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.login?.source).equal('not_set');
  });
});

describe('a machine with no investigation login at all', () => {
  it('should turn investigations off and say why, spawning nothing', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')], defaultRuntime: noDefault });

    // Act
    const actual = await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(actual.message).equal(
      'no investigation login exists on this machine: 1 flag waits for you until one is chosen in Settings › Warden',
    );
    should(subject.spawns).be.empty();
    should(status.triage.llm).deepEqual({ configured: true, active: false, reason: 'no_login' });
    should(status.login).deepEqual({ source: 'not_set', unknown: [], available: ['claude-default'] });
  });

  it('should keep a queued flag in its place until a login is chosen', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      defaultRuntime: noDefault,
      state: {
        assignedQueue: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'asked' }],
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue?.map(item => item.sessionId)).deepEqual(['s1']);
  });

  it('should not call a forced sweep with no login an exhausted one', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')], defaultRuntime: noDefault });

    // Act
    await subject.service.run({ force: true });

    // Assert: nothing failed, so nothing is journalled or recorded as exhaustion.
    should(subject.spawns).be.empty();
    should(journalTypes(subject)).not.containEql('fleet.warden_exhausted');
    should(subject.state().failover?.exhaustedSince).be.undefined();
  });

  it('should refuse the owner’s request with the way out', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })], defaultRuntime: noDefault });

    // Act
    const error: unknown = await subject.service.requestInvestigation('s1').catch((cause: unknown) => cause);

    // Assert
    should(error).be.instanceOf(WardenRequestError).and.match({
      failure: 'no_login',
      message:
        'No investigation login is set and this machine has no default runtime. Choose one in Settings › Warden.',
    });
  });
});

describe('a login this machine does not have', () => {
  const legacy = enabled({ accounts: [{ agent: 'legacy-wrapper' }] });

  it('should name it unknown, leave the file alone and never spawn on it', async () => {
    // Arrange
    const subject = harness({ config: legacy, fleet: [triageable('s1')] });

    // Act
    const actual = await subject.service.view();
    await subject.service.run({ force: false });

    // Assert
    should(actual.login).deepEqual({
      source: 'configured',
      unknown: ['legacy-wrapper'],
      available: ['claude-default'],
    });
    should(actual.warnings).matchAny(/^unknown login 'legacy-wrapper' — choose one/u);
    should(subject.spawns).be.empty();
    should(subject.storedConfig()).have.property('accounts', [{ agent: 'legacy-wrapper' }]);
  });

  it('should refuse the owner’s request by naming it', async () => {
    // Arrange
    const subject = harness({ config: legacy, fleet: [session({ id: 's1' })] });

    // Act
    const error: unknown = await subject.service.requestInvestigation('s1').catch((cause: unknown) => cause);

    // Assert
    should(error).match({
      failure: 'no_login',
      message: "Unknown login 'legacy-wrapper' — choose one in Settings › Warden.",
    });
  });

  it('should report the login on the configuration it just saved', async () => {
    // Arrange
    const subject = harness({ config: legacy });

    // Act
    const actual = await subject.service.updateConfig({ accounts: [] });

    // Assert: emptying the order hands the choice back to the machine default.
    should(actual.accounts).deepEqual([{ agent: 'claude-default' }]);
    should(actual.login?.source).equal('machine_default');
  });
});

describe('a warden.yaml that stored a runtime id as the login', () => {
  const ID = '0b6f6b5e-5d7c-4f4e-9d0a-1d1f2a3b4c5d';
  const stored = enabled({ accounts: [{ agent: ID, model: 'opus' }] });
  const resolveId = async (reference: string): Promise<string | undefined> =>
    reference === ID ? 'claude-default' : reference === 'claude-default' ? reference : undefined;

  it('should validate a login written by name, with nothing unknown', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: 'claude-default' }] }),
      installed: async () => ['claude-default'],
      currentName: resolveId,
    });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.login).deepEqual({ source: 'configured', unknown: [], available: ['claude-default'] });
    should(actual.warnings).be.empty();
  });

  it('should read the id as the runtime’s name, so it is neither unknown nor shown as an id', async () => {
    // Arrange
    const subject = harness({ config: stored, currentName: resolveId, fleet: [triageable('s1')] });

    // Act
    const actual = await subject.service.view();
    await subject.service.run({ force: false });

    // Assert: the model rides along, the file is untouched until a save, and the spawn runs on the name.
    should(actual.config.accounts).deepEqual([{ agent: 'claude-default', model: 'opus' }]);
    should(actual.login?.unknown).deepEqual([]);
    should(actual.warnings).be.empty();
    should(subject.storedConfig()).have.property('accounts', [{ agent: ID, model: 'opus' }]);
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-default']);
  });

  it('should write the name back on the next save', async () => {
    // Arrange
    const subject = harness({ config: stored, currentName: resolveId });

    // Act
    await subject.service.updateConfig({ blessMinutes: 5 });

    // Assert
    should(subject.storedConfig()).have.property('accounts', [{ agent: 'claude-default', model: 'opus' }]);
  });

  it('should keep an id nothing answers to, and call it unknown', async () => {
    // Arrange
    const subject = harness({ config: stored });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.login?.unknown).deepEqual([ID]);
  });

  it('should collapse an id and its own name into one login', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ accounts: [{ agent: ID }, { agent: 'claude-default', model: 'sonnet' }] }),
      currentName: resolveId,
    });

    // Act
    const actual = await subject.service.view();

    // Assert
    should(actual.config.accounts).deepEqual([{ agent: 'claude-default' }]);
  });
});
