import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import type { IBrowserRunner } from '../../../src/lib/browser/controller';
import type { BrowserCommand } from '../../../src/lib/browser/types';

function harness() {
  const calls: BrowserCommand[] = [];
  const runner: IBrowserRunner = {
    run: async command => {
      calls.push(command);
      return 0;
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program, runner);
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { calls, run };
}

describe('plain verbs', () => {
  it('should map the lifecycle and history verbs onto their commands', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    for (const verb of ['status', 'start', 'stop', 'back', 'forward', 'reload']) {
      await run('browser', verb, '--session', 'sess-1');
    }

    // Assert
    should(calls.map(call => call.command)).deepEqual(['status', 'start', 'stop', 'back', 'forward', 'reload']);
    should(calls.every(call => 'session' in call && call.session === 'sess-1')).be.true();
  });

  it('should accept close as an alias for stop and goto as an alias for navigate', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'close');
    await run('browser', 'goto', 'https://a.test');

    // Assert
    should(calls.map(call => call.command)).deepEqual(['stop', 'navigate']);
  });
});

describe('session targeting', () => {
  it('should accept --session before the verb', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', '--session', 'parent', 'status');

    // Assert
    should(calls[0]).deepEqual({ command: 'status', session: 'parent' });
  });

  it('should let --session on the verb win over one written before it', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', '--session', 'parent', 'status', '--session', 'verb');

    // Assert
    should(calls[0]).deepEqual({ command: 'status', session: 'verb' });
  });

  it('should omit the session entirely when none was given', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'status');

    // Assert
    should(calls[0]).deepEqual({ command: 'status' });
  });
});

describe('verbs with arguments', () => {
  it('should treat a url as optional for open and new-page', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'open');
    await run('browser', 'open', 'https://a.test');
    await run('browser', 'new-page');
    await run('browser', 'new-page', 'https://b.test');

    // Assert
    should(calls).deepEqual([
      { command: 'open' },
      { command: 'open', url: 'https://a.test' },
      { command: 'new-page' },
      { command: 'new-page', url: 'https://b.test' },
    ]);
  });

  it('should carry page ids for tab management', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'activate-page', 'p1');
    await run('browser', 'close-page', 'p2');

    // Assert
    should(calls).deepEqual([
      { command: 'activate-page', pageId: 'p1' },
      { command: 'close-page', pageId: 'p2' },
    ]);
  });

  it('should join variadic text so a typed phrase survives the shell', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'type', '#q', 'hello', 'there');

    // Assert
    should(calls[0]).deepEqual({ command: 'type', selector: '#q', text: 'hello there' });
  });

  it('should let -- introduce text that starts with a dash', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'type', '#q', '--', '--not-a-flag');

    // Assert
    should(calls[0]).deepEqual({ command: 'type', selector: '#q', text: '--not-a-flag' });
  });

  it('should allow typing an empty string to clear a field', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'type', '#q');

    // Assert
    should(calls[0]).deepEqual({ command: 'type', selector: '#q', text: '' });
  });

  it('should read the body by default and a selector when named', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'read');
    await run('browser', 'read', 'main');

    // Assert
    should(calls).deepEqual([{ command: 'read' }, { command: 'read', selector: 'main' }]);
  });

  it('should carry the screenshot output path', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'screenshot', 'shot.png');

    // Assert
    should(calls[0]).deepEqual({ command: 'screenshot', output: 'shot.png' });
  });

  it('should parse a viewport and reject one the daemon would refuse', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'resize', '800', '600');

    // Assert
    should(calls[0]).deepEqual({ command: 'resize', width: 800, height: 600 });
    await should(run('browser', 'resize', '10', '10')).be.rejected();
    should(calls).have.length(1);
  });

  it('should refuse a blank required argument', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act + Assert
    await should(run('browser', 'click', '   ')).be.rejected();
    await should(run('browser', 'navigate', ' ')).be.rejected();
    await should(run('browser', 'activate-page', ' ')).be.rejected();
    await should(run('browser', 'close-page', ' ')).be.rejected();
    await should(run('browser', 'screenshot', ' ')).be.rejected();
    should(calls).be.empty();
  });

  it('should refuse a verb it does not know', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act + Assert
    await should(run('browser', 'teleport')).be.rejected();
    should(calls).be.empty();
  });
});

describe('the login window', () => {
  it('should expose status, start, confirm, and stop', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'login', 'status');
    await run('browser', 'login', 'start');
    await run('browser', 'login', 'confirm');
    await run('browser', 'login', 'stop');
    await run('browser', 'login', 'close');

    // Assert
    should(calls).deepEqual([
      { command: 'login', action: 'status' },
      { command: 'login', action: 'start' },
      { command: 'login', action: 'confirm' },
      { command: 'login', action: 'stop' },
      { command: 'login', action: 'stop' },
    ]);
  });

  it('should carry a requested duration and reject a malformed one', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'login', 'start', '--minutes', '20');

    // Assert
    should(calls[0]).deepEqual({ command: 'login', action: 'start', minutes: 20 });
    await should(run('browser', 'login', 'start', '--minutes', 'soon')).be.rejected();
    should(calls).have.length(1);
  });

  it('should carry --primed only on stop', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('browser', 'login', 'stop', '--primed');

    // Assert — kteam accepted --primed anywhere and silently ignored it.
    should(calls[0]).deepEqual({ command: 'login', action: 'stop', primed: true });
    await should(run('browser', 'login', 'start', '--primed')).be.rejected();
    await should(run('browser', 'status', '--minutes', '5')).be.rejected();
    should(calls).have.length(1);
  });

  it('should refuse a bare "browser login" rather than guess show-me or open-it', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act + Assert
    await should(run('browser', 'login')).be.rejected();
    should(calls).be.empty();
  });
});
