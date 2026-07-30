import { afterEach, describe, it, setDefaultTimeout } from 'bun:test';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import should from 'should';
import { assertNoLiveStatePath, E2eEnvironment, type FakeHarnessScenario, withE2eEnvironment } from './fixture';

let subject: E2eEnvironment | undefined;

setDefaultTimeout(120_000);

afterEach(async () => {
  await subject?.dispose();
  subject = undefined;
});

describe('isolated E2E harness', () => {
  it('should run a declarative fake agent in isolated tmux and drive the compiled CLI', async () => {
    // Arrange
    subject = await E2eEnvironment.create();
    const scenario = (await Bun.file(
      join(import.meta.dir, 'fixtures', 'proving-agent.json'),
    ).json()) as FakeHarnessScenario;
    await subject.setFakeHarnessScenario(scenario);

    // Act
    const fake = await subject.runFakeHarnessInTmux(['--session', 'proving-journey'], ['yes']);
    const actual = await subject.runFy(['--version']);
    const invocations = await subject.readFakeHarnessInvocations();

    // Assert
    should(fake).deepEqual({
      code: 0,
      out: 'agent says hello\ncontinue?\n',
      err: 'scripted diagnostic\n',
    });
    should(actual.code).equal(0);
    should(actual.out.trim()).match(/^\d+\.\d+\.\d+/);
    should(actual.err).equal('');
    should(invocations).have.length(1);
    should(invocations[0]).deepEqual({
      wrapper: subject.fakeHarnessName,
      argv: ['--session', 'proving-journey'],
      cwd: subject.repositoryRoot,
    });
    should(subject.ports.api).not.equal(subject.ports.webSocket);
    should(await subject.tmuxServerIsRunning()).be.true();
  });

  it('should start and stop a daemon stub and await a WebSocket event', async () => {
    // Arrange
    subject = await E2eEnvironment.create();
    const expected = { type: 'fixture-ready', sessionId: 'e2e' };
    const daemon = join(subject.repositoryRoot, 'scripts', 'test', 'fake-daemon.ts');
    await access(daemon, fsConstants.X_OK);

    // Act
    await subject.startDaemon({
      command: [daemon],
      env: { FY_E2E_DAEMON_EVENT: JSON.stringify(expected) },
      readyUrl: subject.httpUrl('/healthz', subject.ports.webSocket),
    });
    const actual = await subject.awaitWebSocketEvent<typeof expected>({
      predicate: event => event.type === expected.type,
    });
    const stopped = await subject.stopDaemon();

    // Assert
    should(actual).deepEqual(expected);
    should(stopped).not.be.undefined();
    should(stopped?.code).equal(0);
  });

  it.each(['.kteam', '.ferretry'])('should reject the live %s state path before setup IO', async directory => {
    // Arrange
    const forbidden = join(userInfo().homedir, directory, 'e2e-must-not-exist');

    // Act
    const actual = E2eEnvironment.create({ runRoot: forbidden });

    // Assert
    await should(actual).be.rejectedWith(/E2E safety assertion refused/);
  });

  it('should tear down tmux when a scoped journey fails', async () => {
    // Arrange
    let captured: E2eEnvironment | undefined;
    const expected = new Error('deliberate journey failure');

    // Act
    const actual = withE2eEnvironment(async environment => {
      captured = environment;
      throw expected;
    });

    // Assert
    await should(actual).be.rejectedWith(expected);
    should(captured).not.be.undefined();
    should(await captured?.tmuxServerIsRunning()).be.false();
  });

  it('should allocate collision-free state, sockets, and ports for parallel journeys', async () => {
    // Arrange + Act
    const [first, second] = await Promise.all([E2eEnvironment.create(), E2eEnvironment.create()]);

    try {
      // Assert
      should(first.paths.root).not.equal(second.paths.root);
      should(first.paths.tmuxSocket).not.equal(second.paths.tmuxSocket);
      should(first.ports.api).not.equal(second.ports.api);
      should(first.ports.api).not.equal(second.ports.webSocket);
      should(first.ports.webSocket).not.equal(second.ports.api);
      should(first.ports.webSocket).not.equal(second.ports.webSocket);
      should(await first.tmuxServerIsRunning()).be.true();
      should(await second.tmuxServerIsRunning()).be.true();
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it('should accept safe relative and missing paths after resolving them', async () => {
    // Arrange
    const input = join('tests', 'e2e', 'not-created', '..', 'future-state');

    // Act
    const actual = await assertNoLiveStatePath(input);

    // Assert
    should(actual).equal(join(process.cwd(), 'tests', 'e2e', 'future-state'));
  });
});
