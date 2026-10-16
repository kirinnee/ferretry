import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import {
  registerBrowserPageCommands,
  registerTerminalCommands,
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
      { kind: 'view', session: 's1' },
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
    await run('browser', 'page', 'open', 'docs');
    await run('browser', 'page', 'navigate', 'app', 'https://example.test/');
    await run('browser', 'page', 'click', 'app', 'button[type=submit]');
    await run('browser', 'page', 'type', 'app', '#q', 'hello', 'world');
    await run('browser', 'page', 'read', 'app');
    await run('browser', 'page', 'read', 'app', '--a11y', '--selector', 'main');
    await run('browser', 'page', 'screenshot', 'app', 'shot.png');
    await run('browser', 'page', 'close', 'app');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'browser.list' } },
      { kind: 'call', call: { tool: 'browser.open', name: 'app', url: 'http://localhost:5173/' } },
      { kind: 'call', call: { tool: 'browser.open', name: 'docs' } },
      { kind: 'call', call: { tool: 'browser.navigate', name: 'app', url: 'https://example.test/' } },
      { kind: 'call', call: { tool: 'browser.click', name: 'app', selector: 'button[type=submit]' } },
      { kind: 'call', call: { tool: 'browser.type', name: 'app', selector: '#q', text: 'hello world' } },
      { kind: 'call', call: { tool: 'browser.read', name: 'app' } },
      { kind: 'call', call: { tool: 'browser.read', name: 'app', mode: 'a11y', selector: 'main' } },
      { kind: 'call', call: { tool: 'browser.screenshot', name: 'app' }, screenshotTo: 'shot.png' },
      { kind: 'call', call: { tool: 'browser.close', name: 'app' } },
    ]);
  });

  it('should read --session from the verb, the page group or the browser group', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', '--session', 'outer', 'page', 'list');
    await run('browser', 'page', '--session', 'middle', 'takeover', 'app');
    await run('browser', 'page', 'handback', 'app', '--session', 'inner');

    // Assert
    should(calls).deepEqual([
      { kind: 'call', call: { tool: 'browser.list' }, session: 'outer' },
      { kind: 'control', surface: 'browser', action: 'takeover', key: 'app', session: 'middle' },
      { kind: 'control', surface: 'browser', action: 'handback', key: 'app', session: 'inner' },
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
