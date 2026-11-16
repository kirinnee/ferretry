import { describe, it } from 'bun:test';
import should from 'should';
import { isBrowserProcess, isShellProcess } from '../../daemon/lib/index.ts';
import { type PaneProcess, paneWorkSummary } from '../../daemon/lib/pane-processes.ts';

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

describe('what runs under a pane', () => {
  const harness: PaneProcess = { pid: 1, argv: 'claude', known: { kind: 'harness' } };
  const shell = (pid: number, startedSecondsAgo: number, ppid = 1): PaneProcess => ({
    pid,
    ppid,
    argv: '/bin/bash -c work',
    startedSecondsAgo,
  });

  it('should see nothing running in an empty pane', () => {
    should(paneWorkSummary([])).eql({ toolCommand: false, leftoverBrowser: false });
  });

  it('should see a tool command as work, keyed by the youngest one', () => {
    const summary = paneWorkSummary([harness, shell(2, 300), shell(3, 5), { pid: 4, ppid: 3, argv: 'sleep 60' }]);
    should(summary).eql({ toolCommand: true, commandKey: 'pid:3', leftoverBrowser: false });
  });

  it('should not count a command that only waits on the server it started', () => {
    const summary = paneWorkSummary([
      harness,
      shell(2, 30),
      { pid: 3, ppid: 2, argv: 'bun run dev', listening: true },
      { pid: 4, ppid: 3, argv: 'node watcher.js' },
    ]);
    should(summary.toolCommand).be.false();
  });

  it('should see a browser the agent left behind, and not one a helper keeps', () => {
    const left = paneWorkSummary([
      harness,
      shell(2, 30),
      { pid: 3, ppid: 2, argv: '/opt/google/chrome/chrome --headless' },
      { pid: 4, ppid: 3, argv: '/opt/google/chrome/chrome --type=renderer' },
    ]);
    should(left).eql({ toolCommand: false, leftoverBrowser: true });
    const helper = paneWorkSummary([
      harness,
      { pid: 2, ppid: 1, argv: 'fy mcp serve', known: { kind: 'tools' } },
      { pid: 3, ppid: 2, argv: 'bash -c x' },
      { pid: 4, ppid: 3, argv: '/opt/google/chrome/chrome --headless' },
    ]);
    should(helper).eql({ toolCommand: false, leftoverBrowser: false });
  });

  it('should read a process whose parent is not listed as started by the pane itself', () => {
    const summary = paneWorkSummary([
      { pid: 5, ppid: 99, argv: '-zsh', startedSecondsAgo: 1 },
      { pid: 6, ppid: 99, argv: 'node app.js' },
    ]);
    should(summary).eql({ toolCommand: true, commandKey: 'pid:5', leftoverBrowser: false });
  });
});
