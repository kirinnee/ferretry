import { describe, it } from 'bun:test';
import { BROWSER_PROXY_ERROR_CLASSES } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import type { z } from 'zod';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import { BrowserController, type IBrowserRunner } from '../../../src/lib/browser/controller';
import { parseProxyTestFlags } from '../../../src/lib/browser/parse';
import { renderProxyTest } from '../../../src/lib/browser/render';
import { BROWSER_PROXY_TEST_PATH, browserRequest } from '../../../src/lib/browser/request';
import { type BrowserCommand, BrowserCommandError } from '../../../src/lib/browser/types';
import { failedProxyTest, proxyTestResult } from './fixtures';

const UNSAVED = {
  url: 'http://proxy.example:8080',
  bypass: ['*.internal.example'],
  username: `\${secret:PROXY_USER}`,
  password: `\${secret:PROXY_PASSWORD}`,
};

function commandHarness() {
  const calls: BrowserCommand[] = [];
  const runner: IBrowserRunner = {
    run: async command => {
      calls.push(command);
      return 0;
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program, runner);
  return { calls, run: (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]) };
}

function controllerHarness(payload: unknown, rejectWith?: unknown) {
  const sent: Array<{ path: string; method: string | undefined; body: unknown }> = [];
  const out: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const gateway = {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      sent.push({
        path,
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (rejectWith !== undefined) throw rejectWith;
      return schema.parse(payload);
    },
  };
  const io = {
    success: (message: string) => out.push(message),
    warn: (message: string) => out.push(message),
    error: (message: string) => errors.push(message),
    setExitCode: (code: number) => exitCodes.push(code),
  };
  const controller = new BrowserController(gateway, io, { write: async () => {} }, {});
  return { sent, out, errors, exitCodes, run: (command: BrowserCommand) => controller.run(command) };
}

describe('proxy test request', () => {
  it('should POST an empty body for the saved proxy, with no session in scope', () => {
    // Act
    const actual = browserRequest({ command: 'proxy', action: 'test' });

    // Assert
    should(actual).deepEqual({ method: 'POST', path: BROWSER_PROXY_TEST_PATH, body: {} });
  });

  it('should ignore an enclosing session: the route is machine-wide', () => {
    // Act
    const actual = browserRequest({ command: 'proxy', action: 'test' }, 'sess-1');

    // Assert
    should(actual.path).equal('/v1/browser/proxy/test');
  });

  it('should carry an unsaved proxy under the proxy key', () => {
    // Act
    const actual = browserRequest({ command: 'proxy', action: 'test', proxy: UNSAVED });

    // Assert
    should(actual.body).deepEqual({ proxy: UNSAVED });
  });
});

describe('proxy test flags', () => {
  it('should mean the saved proxy when no flag is given', () => {
    // Act + Assert
    should(parseProxyTestFlags({})).be.undefined();
    should(parseProxyTestFlags({ url: '   ' })).be.undefined();
  });

  it('should build the setting from the flags, wrapping secret names as references', () => {
    // Act
    const actual = parseProxyTestFlags({
      url: ' http://proxy.example:8080 ',
      bypass: '*.internal.example, 10.0.0.0/8,',
      usernameSecret: 'PROXY_USER',
      passwordSecret: 'PROXY_PASSWORD',
    });

    // Assert
    should(actual).deepEqual({ ...UNSAVED, bypass: ['*.internal.example', '10.0.0.0/8'] });
  });

  it('should default the bypass list to empty', () => {
    // Act
    const actual = parseProxyTestFlags({ url: 'socks5://proxy.example:1080' });

    // Assert
    should(actual).deepEqual({ url: 'socks5://proxy.example:1080', bypass: [] });
  });

  it('should refuse a bad address locally with the schema sentence', () => {
    // Act + Assert
    should(() => parseProxyTestFlags({ url: 'proxy.example:8080' })).throw(BrowserCommandError);
    should(() => parseProxyTestFlags({ url: 'ftp://proxy.example' })).throw(/starts with http/u);
  });

  it('should refuse a user:pass@ address without echoing the credential', () => {
    // Act
    const act = () => parseProxyTestFlags({ url: 'http://alice:hunter2@proxy.example:8080' });

    // Assert
    should(act).throw(/never carries a user name or password/u);
    try {
      act();
    } catch (error) {
      should((error as Error).message).not.containEql('hunter2');
      should((error as Error).message).not.containEql('alice');
    }
  });

  it('should refuse a credential value that is not a secret name, without echoing it', () => {
    // Act
    const act = () =>
      parseProxyTestFlags({ url: 'http://proxy.example:8080', usernameSecret: 'alice', passwordSecret: 'hunter2' });

    // Assert
    should(act).throw(/--username-secret: .*never as the value/u);
    try {
      act();
    } catch (error) {
      should((error as Error).message).not.containEql('hunter2');
    }
  });

  it('should refuse one credential without the other', () => {
    // Act + Assert
    should(() => parseProxyTestFlags({ url: 'http://proxy.example:8080', usernameSecret: 'PROXY_USER' })).throw(
      /needs both username and password/u,
    );
  });

  it('should refuse the other flags without an address', () => {
    // Act + Assert
    should(() => parseProxyTestFlags({ bypass: 'a.example' })).throw(/need --url/u);
    should(() => parseProxyTestFlags({ passwordSecret: 'PROXY_PASSWORD' })).throw(/need --url/u);
  });
});

describe('proxy test command surface', () => {
  it('should map the bare verb onto the saved-proxy test, taking no --session', async () => {
    // Arrange
    const { calls, run } = commandHarness();

    // Act
    await run('browser', 'proxy', 'test');

    // Assert
    should(calls).deepEqual([{ command: 'proxy', action: 'test' }]);
  });

  it('should carry the flags as an unsaved setting', async () => {
    // Arrange
    const { calls, run } = commandHarness();

    // Act
    await run(
      'browser',
      'proxy',
      'test',
      '--url',
      'http://proxy.example:8080',
      '--bypass',
      '*.internal.example',
      '--username-secret',
      'PROXY_USER',
      '--password-secret',
      'PROXY_PASSWORD',
    );

    // Assert
    should(calls).deepEqual([{ command: 'proxy', action: 'test', proxy: UNSAVED }]);
  });

  it('should reject a bad address before the runner is reached', async () => {
    // Arrange
    const { calls, run } = commandHarness();

    // Act + Assert
    await should(run('browser', 'proxy', 'test', '--url', 'http://alice:hunter2@proxy.example')).rejectedWith(
      BrowserCommandError,
    );
    should(calls).deepEqual([]);
  });

  it('should have no flag that accepts a credential value', async () => {
    // Arrange
    const { run } = commandHarness();

    // Act + Assert
    await should(run('browser', 'proxy', 'test', '--password', 'hunter2')).rejected();
  });
});

describe('proxy test rendering', () => {
  it('should say reachable, saved or unsaved, the round trip and the egress IP', () => {
    // Act + Assert
    should(renderProxyTest(proxyTestResult())).startWith(
      'Proxy reachable via saved proxy in 312 ms; egress IP 203.0.113.7',
    );
    should(renderProxyTest(proxyTestResult({ tested: 'unsaved', egressIp: '2001:db8::1' }))).startWith(
      'Proxy reachable via unsaved proxy in 312 ms; egress IP 2001:db8::1',
    );
  });

  for (const errorClass of BROWSER_PROXY_ERROR_CLASSES) {
    it(`should name the ${errorClass} error class and carry the daemon's sentence`, () => {
      // Act
      const actual = renderProxyTest(failedProxyTest({ errorClass, message: 'No answer.' }));

      // Assert
      should(actual).startWith(`Proxy test failed (${errorClass}): No answer.`);
    });
  }

  it('should include the time spent when the daemon reports one', () => {
    // Act
    const actual = renderProxyTest(
      failedProxyTest({ errorClass: 'timeout', roundTripMs: 8_000, tested: 'unsaved', message: 'Too slow.' }),
    );

    // Assert
    should(actual).equal('Proxy test failed (timeout): Too slow. [unsaved proxy after 8000 ms]');
  });
});

describe('proxy test controller', () => {
  it('should POST to the machine-wide route and exit 0 on a reachable proxy', async () => {
    // Arrange
    const { sent, out, errors, exitCodes, run } = controllerHarness(proxyTestResult());

    // Act
    const actual = await run({ command: 'proxy', action: 'test' });

    // Assert
    should(actual).equal(0);
    should(sent).deepEqual([{ path: BROWSER_PROXY_TEST_PATH, method: 'POST', body: {} }]);
    should(out[0]).containEql('egress IP 203.0.113.7');
    should(errors).deepEqual([]);
    should(exitCodes).deepEqual([]);
  });

  it('should send the unsaved proxy as names only', async () => {
    // Arrange
    const { sent, run } = controllerHarness(proxyTestResult({ tested: 'unsaved' }));

    // Act
    await run({ command: 'proxy', action: 'test', proxy: UNSAVED });

    // Assert
    should(sent[0]?.body).deepEqual({ proxy: UNSAVED });
  });

  it('should report an unreachable proxy on stderr and exit 1, without a stack', async () => {
    // Arrange
    const failed = failedProxyTest({
      errorClass: 'auth',
      message: 'The proxy refused the user name and password (407).',
    });
    const { out, errors, exitCodes, run } = controllerHarness(failed);

    // Act
    const actual = await run({ command: 'proxy', action: 'test' });

    // Assert
    should(actual).equal(1);
    should(out).deepEqual([]);
    should(errors).have.length(1);
    should(errors[0]).startWith('Proxy test failed (auth): The proxy refused');
    should(errors[0]).not.containEql('    at ');
    should(exitCodes).deepEqual([1]);
  });

  it("should surface the daemon's sentence on a refusal and exit 1", async () => {
    // Arrange
    const refusal = new Error('Only the owner may test the browser proxy.');
    const { out, errors, exitCodes, run } = controllerHarness(undefined, refusal);

    // Act
    const actual = await run({ command: 'proxy', action: 'test' });

    // Assert
    should(actual).equal(1);
    should(out).deepEqual([]);
    should(errors).deepEqual(['Only the owner may test the browser proxy.']);
    should(exitCodes).deepEqual([1]);
  });

  it('should report a malformed daemon answer rather than render it', async () => {
    // Arrange
    const { errors, exitCodes, run } = controllerHarness({ reachable: 'maybe' });

    // Act
    const actual = await run({ command: 'proxy', action: 'test' });

    // Assert
    should(actual).equal(1);
    should(errors).have.length(1);
    should(exitCodes).deepEqual([1]);
  });
});
