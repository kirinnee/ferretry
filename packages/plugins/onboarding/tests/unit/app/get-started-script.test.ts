import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../support/dom.ts';

// NEEDS-APP-SHELL: boots the page's own script in a DOM; `../support/dom.ts` (happy-dom) is the app shell's.
const pluginDir = join(import.meta.dir, '../../..');
const page = readFileSync(join(pluginDir, 'app/get-started/index.html'), 'utf8');
const goldenPrompt = readFileSync(join(pluginDir, 'tests/fixtures/agent-setup-prompt.txt'), 'utf8').replace(/\n$/, '');

describe('the page script', () => {
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1] ?? '';
  const markup = page
    .slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
    .replace(/<script>[\s\S]*?<\/script>/, '');
  let copied: string[] = [];

  /** Boot the page's own script against its own markup, the way a browser does. */
  const boot = (userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'): void => {
    document.documentElement.className = '';
    document.body.innerHTML = markup;
    copied = [];
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    new Function(script)();
  };
  const visible = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      .filter(panel => !panel.hidden)
      .map(panel => panel.getAttribute('data-method') ?? '');

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('picks Homebrew on a Mac and the installer on Linux', () => {
    boot();
    expect(visible()).toEqual(['brew']);
    boot('Mozilla/5.0 (X11; Linux x86_64)');
    expect(visible()).toEqual(['installer']);
  });

  it('shows one method at a time, by click or arrow key', () => {
    boot();
    (document.querySelector('[role="tab"][data-method="home-manager"]') as HTMLElement).click();
    expect(visible()).toEqual(['home-manager']);
    const selected = document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
    selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(visible()).toEqual(['installer']);
    (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(visible()).toEqual(['brew']);
  });

  it('copies exactly the prompt, and a command block line by line', async () => {
    boot();
    (document.querySelector('.agent .copy') as HTMLElement).click();
    (document.querySelector('#panel-brew .copy') as HTMLElement).click();
    await Promise.resolve();
    expect(copied).toEqual([
      goldenPrompt,
      'brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry\nbrew install --cask ferretry\nfy setup',
    ]);
  });
});
