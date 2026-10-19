import { afterEach, describe, it, setDefaultTimeout } from 'bun:test';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import childProcess from 'node:child_process';
import should from 'should';
import { assertNoLiveStatePath, E2eEnvironment, type FakeHarnessScenario, withE2eEnvironment } from './fixture';
import { closeChromeBounded, launchChromiumWithRetry } from './support/relay-harness';

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

/**
 * A stand-in for what Playwright's `launch()` hands back: a browser whose calls are never answered,
 * because the DevTools pipe to the process launched with it no longer carries anything.
 */
function silentBrowser(
  script: string,
  browserProcess?: { send(method: string): Promise<unknown> },
): () => Promise<{ newContext(): Promise<never>; close(): Promise<void> }> {
  return async () => {
    // Through the module object, at call time: the stdio guard wraps `spawn` there, as Playwright calls it.
    childProcess.spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      _guid: 'browser@silent',
      newContext: () => new Promise<never>(() => undefined),
      close: async () => undefined,
      ...(browserProcess === undefined ? {} : { newBrowserCDPSession: async () => browserProcess }),
    };
  };
}

describe('a browser whose DevTools pipe goes silent', () => {
  it('should fail a pending call at once when Chrome reports the pipe broken', async () => {
    // Arrange
    const browser = await launchChromiumWithRetry(
      silentBrowser(
        'sleep 0.5; echo "[1:2:ERROR:content/browser/devtools/devtools_pipe_handler.cc:274] Could not write into pipe" >&2; sleep 30',
      ),
    );
    const started = Date.now();

    try {
      // Act
      const actual = await browser.newContext().then(
        () => 'answered',
        (error: Error) => error.message,
      );

      // Assert
      should(actual).match(/^browser has disconnected: Chrome pid \d+ reported "Could not write into pipe"/u);
      should(Date.now() - started).be.below(10_000);
    } finally {
      await closeChromeBounded(browser);
    }
  });

  it('should fail a pending call at once when Chrome exits on its own', async () => {
    // Arrange
    const browser = await launchChromiumWithRetry(silentBrowser('sleep 0.5'));
    const started = Date.now();

    try {
      // Act
      const actual = await browser.newContext().then(
        () => 'answered',
        (error: Error) => error.message,
      );

      // Assert
      should(actual).match(/^browser has disconnected: Chrome pid \d+ exited on its own \(code=0/u);
      should(Date.now() - started).be.below(10_000);
    } finally {
      await closeChromeBounded(browser);
    }
  });
});

describe('a browser whose DevTools pipe stops carrying commands', () => {
  it('should fail a pending call once Chrome stops answering a probe, though it logs nothing', async () => {
    // Arrange — Chrome stays up and silent; its browser process never answers.
    const browser = await launchChromiumWithRetry(
      silentBrowser('sleep 60', { send: () => new Promise<never>(() => undefined) }),
    );
    const started = Date.now();

    try {
      // Act
      const actual = await browser.newContext().then(
        () => 'answered',
        (error: Error) => error.message,
      );

      // Assert — one probe after ten seconds, five seconds for its reply.
      should(actual).match(/^browser has disconnected: .*did not answer Browser\.getVersion within 5000ms/u);
      should(Date.now() - started).be.below(25_000);
    } finally {
      await closeChromeBounded(browser);
    }
  });

  it('should keep waiting on a slow call while Chrome still answers the probe', async () => {
    // Arrange — Chrome's browser process answers at once; only the call itself is slow.
    const browser = await launchChromiumWithRetry(silentBrowser('sleep 60', { send: async () => ({}) }));

    try {
      // Act
      const actual = await Promise.race([
        browser.newContext().then(
          () => 'answered',
          (error: Error) => error.message,
        ),
        Bun.sleep(17_000).then(() => 'still waiting'),
      ]);

      // Assert
      should(actual).equal('still waiting');
    } finally {
      await closeChromeBounded(browser);
    }
  });
});
