import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import { identifyKnownProcesses } from '../../../src/lib/migrate/harness-provenance.ts';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../../src/lib/migrate/process-table.ts';
import {
  classifyPaneProcesses,
  isBrowserProcess,
  isShellProcess,
  type PaneProcess,
  paneWorkSummary,
} from '../../../src/lib/warden/index.ts';

const fixture = (name: string): string => readFileSync(`${import.meta.dir}/../../fixtures/ps/${name}`, 'utf8');

/** The pane's processes exactly as the inventory hands them to the liveness look. */
function paneOf(name: string, rootPid: number, listening: readonly number[] = []): readonly PaneProcess[] {
  const rows = descendantsOf(rootPid, parseProcessTable(fixture(name)));
  const known = identifyKnownProcesses(rows, { rootPid, binaryName: 'fy', configuredServers: [] });
  return inventoryProcesses(rows, new Map(), known, new Set(listening));
}

const proc = (pid: number, ppid: number | undefined, argv: string, extra: Partial<PaneProcess> = {}): PaneProcess => ({
  pid,
  ...(ppid === undefined ? {} : { ppid }),
  argv,
  ...extra,
});

describe('which processes under a pane are work', () => {
  it('should not count the owner’s case — a 2-day-old fy mcp serve as the only child — as a tool command', () => {
    // Act
    const work = paneWorkSummary(paneOf('linux-owner-case.txt', 3_887_833));

    // Assert
    should(work).deepEqual({ toolCommand: false, leftoverBrowser: false });
  });

  it('should count the agent’s shell commands and not the harness’s tools or language servers, from a real Claude pane', () => {
    // Act
    const view = classifyPaneProcesses(paneOf('linux-claude-pane.txt', 66_601));

    // Assert — `sleep 600` and the agent's own `fy mcp serve` run through zsh; the rest are helpers.
    should(view.toolCommands.map(process => process.pid)).deepEqual([66_901, 67_011]);
    should(view.roles.get(66_728)).equal('helper');
    should(view.roles.get(66_734)).equal('helper');
    should(view.roles.get(66_740)).equal('helper');
    should(view.roles.get(66_902)).equal('command');
  });

  it('should name the oldest running command as the episode’s key', () => {
    // Act
    const work = paneWorkSummary(paneOf('linux-claude-pane.txt', 66_601));

    // Assert
    should(work).deepEqual({ toolCommand: true, commandKey: 'pid:66901', leftoverBrowser: false });
  });

  it('should treat Codex’s app server as its own and its bash -c as work, from a real Codex pane', () => {
    // Act
    const view = classifyPaneProcesses(paneOf('linux-codex-pane.txt', 678_503));

    // Assert
    should(view.toolCommands.map(process => process.pid)).deepEqual([710_800]);
    should(view.roles.get(710_513)).equal('harness');
    should(view.roles.get(710_700)).equal('helper');
  });

  it('should read an MCP server the harness started, and the Chrome it drives, as helpers', () => {
    // Arrange
    const processes = [
      proc(10, undefined, 'npm exec @playwright/mcp@latest'),
      proc(11, 10, 'node /home/u/.npm/_npx/playwright-mcp/cli.js'),
      proc(12, 11, '/opt/google/chrome/chrome --headless --remote-debugging-port=9333'),
    ];

    // Act
    const view = classifyPaneProcesses(processes);

    // Assert
    should(view.toolCommands).have.length(0);
    should(view.leftoverBrowsers).have.length(0);
    should([...view.roles.values()]).deepEqual(['helper', 'helper', 'helper']);
  });

  it('should read a server the agent left listening as a service, and its shell as only its wrapper', () => {
    // Arrange — `bun board/server.ts` behind Claude's zsh wrapper, holding a listening socket.
    const processes = [
      proc(20, undefined, "/usr/bin/zsh -c source snapshot.sh && eval 'bun board/server.ts'"),
      proc(21, 20, 'bun board/server.ts', { listening: true }),
    ];

    // Act
    const view = classifyPaneProcesses(processes);

    // Assert
    should(view.toolCommands).have.length(0);
    should(view.services.map(process => process.pid)).deepEqual([21]);
  });

  it('should read a browser the agent launched from its shell as a leftover, and the shell as its wrapper', () => {
    // Arrange
    const processes = [
      proc(30, undefined, '/bin/bash -c chromium --headless --remote-debugging-port=9333 &'),
      proc(31, 30, '/usr/lib/chromium/chromium --headless --remote-debugging-port=9333'),
      proc(32, 31, '/usr/lib/chromium/chromium --type=renderer'),
    ];

    // Act
    const view = classifyPaneProcesses(processes);

    // Assert
    should(view.toolCommands).have.length(0);
    should(view.leftoverBrowsers.map(process => process.pid)).deepEqual([31]);
    should(paneWorkSummary(processes)).deepEqual({ toolCommand: false, leftoverBrowser: true });
  });

  it('should still count a CI poll loop as a running tool command', () => {
    // Arrange — the one real case: an `until` loop polling PR checks that can never finish.
    const processes = [
      proc(
        40,
        undefined,
        '/usr/bin/zsh -c eval \'until [ "$(gh pr checks | grep -c pending)" = 0 ]; do sleep 40; done\'',
      ),
      proc(41, 40, 'sleep 40'),
    ];

    // Act
    const work = paneWorkSummary(processes);

    // Assert
    should(work).deepEqual({ toolCommand: true, commandKey: 'pid:40', leftoverBrowser: false });
  });

  it('should keep a command that ALSO runs something besides the server it started as work', () => {
    // Arrange
    const processes = [
      proc(50, undefined, 'bash -c ./run-e2e.sh'),
      proc(51, 50, 'bun dev-server.ts', { listening: true }),
      proc(52, 50, 'bash ./run-e2e.sh'),
      proc(53, 52, 'bun test e2e'),
    ];

    // Act
    const view = classifyPaneProcesses(processes);

    // Assert
    should(view.toolCommands.map(process => process.pid)).deepEqual([50]);
  });
});

describe('the shapes the classifier recognises', () => {
  it.each([
    ['/usr/bin/zsh -c ls', true],
    ['-zsh', true],
    ['/nix/store/bash-5.3/bin/bash -c git push', true],
    ['fy mcp serve', false],
    ['node server.js', false],
  ])('should read %s as a shell: %s', (argv, expected) => {
    // Act / Assert
    should(isShellProcess(argv)).equal(expected);
  });

  it.each([
    ['/opt/google/chrome/chrome --headless', true],
    ['/usr/lib/chromium/chromium --type=renderer', true],
    ['/root/.cache/ms-playwright/chromium-1105/chrome-linux/headless_shell --remote-debugging-pipe', true],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless', true],
    ['chromedriver --port=9515', false],
    ['bun board/server.ts', false],
  ])('should read %s as a browser: %s', (argv, expected) => {
    // Act / Assert
    should(isBrowserProcess(argv)).equal(expected);
  });
});
