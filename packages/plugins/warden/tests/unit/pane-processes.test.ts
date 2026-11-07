import { describe, it } from 'bun:test';
import should from 'should';
import { isBrowserProcess, isShellProcess } from '../../daemon/lib/index.ts';

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
