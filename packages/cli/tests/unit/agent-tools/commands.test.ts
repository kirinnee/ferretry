import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import {
  registerBrowserPageCommands,
  registerTerminalCommands,
  targetArgument,
  wholeNumber,
} from '../../../src/lib/agent-tools/commands';
import type { AgentToolsCommand } from '../../../src/lib/agent-tools/controller';

function harness() {
  const calls: AgentToolsCommand[] = [];
  const runner = {
    run: async (command: AgentToolsCommand) => {
      calls.push(command);
      return 0;
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program, { run: async () => 0 });
  registerTerminalCommands(program, runner);
  registerBrowserPageCommands(program, runner);
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { calls, run };
}

describe('fy terminal', () => {
  it('should turn every verb into the matching tool call', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('terminal', 'list');
    await run('terminal', 'open', 'dev', '--folder', 'web', '--', 'bun', 'dev');
    await run('terminal', 'open', 'logs');
    await run('terminal', 'send', 'dev', '--key', 'enter', '--', 'ls', '-la');
    await run('terminal', 'send', 'dev', '--key', 'ctrl-c', 'enter');
    await run('terminal', 'send', 'dev', 'echo hi');
    await run('terminal', 'read', 'dev', '--lines', '20');
    await run('terminal', 'read', 'dev');
    await run('terminal', 'close', 'dev');
    await run('terminal', 'open', 'login', '--ask', 'Type your sudo password.', '--', 'sudo', 'true');
    await run('terminal', 'open', 'gh', '--ask');
    await run('terminal', 'ask', 'dev', 'Press', 'Enter.');
    await run('terminal', 'ask', 'dev');

    // Assert
    should(calls.map(call => (call.kind === 'call' ? call.call : call))).deepEqual([
      { tool: 'terminal.list' },
      { tool: 'terminal.open', name: 'dev', folder: 'web', command: 'bun dev' },
      { tool: 'terminal.open', name: 'logs' },
      { tool: 'terminal.send', name: 'dev', text: 'ls -la', keys: ['enter'] },
      { tool: 'terminal.send', name: 'dev', keys: ['ctrl-c', 'enter'] },
      { tool: 'terminal.send', name: 'dev', text: 'echo hi' },
      { tool: 'terminal.read', name: 'dev', lines: 20 },
      { tool: 'terminal.read', name: 'dev' },
      { tool: 'terminal.close', name: 'dev' },
      { tool: 'terminal.open', name: 'login', command: 'sudo true', askOwner: 'Type your sudo password.' },
      { tool: 'terminal.open', name: 'gh', askOwner: true },
      { tool: 'terminal.ask_owner', name: 'dev', message: 'Press Enter.' },
      { tool: 'terminal.ask_owner', name: 'dev' },
    ]);
  });

  it('should wait for text or for exit, never both, within a total budget', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('terminal', 'wait', 'dev', '--text', 'ready', '--timeout', '30000');
    await run('terminal', 'wait', 'dev', '--exit');
    const neither = await run('terminal', 'wait', 'dev').catch((error: unknown) => error);
    const both = await run('terminal', 'wait', 'dev', '--exit', '--text', 'x').catch((error: unknown) => error);

    // Assert
    should(calls).deepEqual([
      { kind: 'wait', wait: { name: 'dev', text: 'ready', totalMs: 30_000 } },
      { kind: 'wait', wait: { name: 'dev', exit: true, totalMs: 10_000 } },
    ]);
    should((neither as Error).message).equal('wait for one thing: pass --text <text> or --exit');
    should((both as Error).message).equal('wait for one thing: pass --text <text> or --exit');
  });

  it('should take the session from the verb before the group', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('terminal', '--session', 'parent', 'list');
    await run('terminal', '--session', 'parent', 'list', '--session', 'child');
    await run('terminal', 'takeover', 'dev', '-s', 's1');
    await run('terminal', 'handback', 'dev');
    await run('terminal', 'control', '--session', 's1');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'terminal.list' }, session: 'parent' },
      { kind: 'call', call: { tool: 'terminal.list' }, session: 'child' },
      { kind: 'control', surface: 'terminal', action: 'takeover', key: 'dev', session: 's1' },
      { kind: 'control', surface: 'terminal', action: 'handback', key: 'dev' },
      { kind: 'view', surface: 'terminal', session: 's1' },
    ]);
  });
});

describe('fy browser page', () => {
  it('should turn every verb into the matching tool call', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'page', 'list');
    await run('browser', 'page', 'open', 'app', 'http://localhost:5173/');
    await run('browser', 'page', 'open', 'docs', '--incognito');
    await run('browser', 'page', 'navigate', 'app', 'https://example.test/');
    await run('browser', 'page', 'click', 'app', 'button[type=submit]');
    await run('browser', 'page', 'type', 'app', '#q', 'hello', 'world');
    await run('browser', 'page', 'read', 'app');
    await run('browser', 'page', 'read', 'app', '--a11y', '--selector', 'main');
    await run('browser', 'page', 'screenshot', 'app', 'shot.png');
    await run('browser', 'page', 'close', 'app');
    await run('browser', 'page', 'open', 'bank', 'https://example.test/', '--ask', 'Sign in.');
    await run('browser', 'page', 'open', 'cap', '--ask');
    await run('browser', 'page', 'ask', 'bank', 'Solve', 'the', 'captcha.');
    await run('browser', 'page', 'ask', 'bank');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'browser.list' } },
      { kind: 'call', call: { tool: 'browser.open', name: 'app', url: 'http://localhost:5173/' } },
      { kind: 'call', call: { tool: 'browser.open', name: 'docs', incognito: true } },
      { kind: 'call', call: { tool: 'browser.navigate', name: 'app', url: 'https://example.test/' } },
      { kind: 'call', call: { tool: 'browser.click', name: 'app', selector: 'button[type=submit]' } },
      { kind: 'call', call: { tool: 'browser.type', name: 'app', selector: '#q', text: 'hello world' } },
      { kind: 'call', call: { tool: 'browser.read', name: 'app' } },
      { kind: 'call', call: { tool: 'browser.read', name: 'app', mode: 'a11y', selector: 'main' } },
      { kind: 'call', call: { tool: 'browser.screenshot', name: 'app' }, screenshotTo: 'shot.png' },
      { kind: 'call', call: { tool: 'browser.close', name: 'app' } },
      {
        kind: 'call',
        call: { tool: 'browser.open', name: 'bank', url: 'https://example.test/', askOwner: 'Sign in.' },
      },
      { kind: 'call', call: { tool: 'browser.open', name: 'cap', askOwner: true } },
      { kind: 'call', call: { tool: 'browser.ask_owner', name: 'bank', message: 'Solve the captcha.' } },
      { kind: 'call', call: { tool: 'browser.ask_owner', name: 'bank' } },
    ]);
  });

  it('should take a ref, a point or a selector wherever a page act names its target', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'page', 'click', 'app', 'e12', '--double');
    await run('browser', 'page', 'click', 'app', '120,340', '--right');
    await run('browser', 'page', 'type', 'app', 'f1e3', 'hi', '--submit', '--slowly');
    await run('browser', 'page', 'read', 'app', '--snapshot');
    await run('browser', 'page', 'read', 'app', '--find', 'Sign in', '--selector', 'e3');
    await run('browser', 'page', 'navigate', 'app', 'back');
    await run('browser', 'page', 'screenshot', 'app', 'shot.jpg', '--jpeg', '--full-page');
    await run('browser', 'page', 'screenshot', 'app', 'button.png', '--of', 'e4');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'browser.click', name: 'app', ref: 'e12', double: true } },
      { kind: 'call', call: { tool: 'browser.click', name: 'app', x: 120, y: 340, button: 'right' } },
      {
        kind: 'call',
        call: { tool: 'browser.type', name: 'app', ref: 'f1e3', text: 'hi', submit: true, slowly: true },
      },
      { kind: 'call', call: { tool: 'browser.read', name: 'app', mode: 'snapshot' } },
      { kind: 'call', call: { tool: 'browser.read', name: 'app', mode: 'snapshot', find: 'Sign in', ref: 'e3' } },
      { kind: 'call', call: { tool: 'browser.navigate', name: 'app', history: 'back' } },
      {
        kind: 'call',
        call: { tool: 'browser.screenshot', name: 'app', fullPage: true, format: 'jpeg' },
        screenshotTo: 'shot.jpg',
      },
      { kind: 'call', call: { tool: 'browser.screenshot', name: 'app', ref: 'e4' }, screenshotTo: 'button.png' },
    ]);
  });

  it('should refuse a point where only an element will do, before calling anything', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    const failure = await run('browser', 'page', 'type', 'app', '1,2', 'hi').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((failure as Error).message).containEql('not a point');
    should(calls).deepEqual([]);
  });

  it('should tell a ref and a point from a selector by their shape alone', () => {
    should(targetArgument('e12')).deepEqual({ ref: 'e12' });
    should(targetArgument('f2e7')).deepEqual({ ref: 'f2e7' });
    should(targetArgument('10.5,20')).deepEqual({ x: 10.5, y: 20 });
    should(targetArgument('button.e12')).deepEqual({ selector: 'button.e12' });
    should(targetArgument('#e12')).deepEqual({ selector: '#e12' });
    should(targetArgument('text=Sign in')).deepEqual({ selector: 'text=Sign in' });
  });

  it('should read --session from the verb, the page group or the browser group', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', '--session', 'outer', 'page', 'list');
    await run('browser', 'page', '--session', 'middle', 'takeover', 'app');
    await run('browser', 'page', 'handback', 'app', '--session', 'inner');
    await run('browser', 'page', 'handover', 'app', '--session', 'inner');
    await run('browser', 'page', 'control', '--session', 'inner');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'browser.list' }, session: 'outer' },
      { kind: 'control', surface: 'browser', action: 'takeover', key: 'app', session: 'middle' },
      { kind: 'control', surface: 'browser', action: 'handback', key: 'app', session: 'inner' },
      { kind: 'control', surface: 'browser', action: 'handover', key: 'app', session: 'inner' },
      { kind: 'view', surface: 'browser', session: 'inner' },
    ]);
  });

  it('should refuse to mount before the browser group exists', () => {
    should(() => registerBrowserPageCommands(new Command(), { run: async () => 0 })).throw(
      'the browser command group must be registered before its page verbs',
    );
  });
});

describe('wholeNumber', () => {
  it('should read a whole number and refuse anything else, naming the option', () => {
    should(wholeNumber('20', '--lines')).equal(20);
    should(() => wholeNumber('2.5', '--lines')).throw('--lines must be a whole number, not "2.5"');
    should(() => wholeNumber('-1', '--timeout')).throw(/--timeout must be a whole number/u);
    should(() => wholeNumber('9'.repeat(20), '--lines')).throw(/whole number/u);
  });
});
