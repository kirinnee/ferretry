import { describe, expect, it } from 'bun:test';
import { ensureDom, interact, mount, must, RouterProvider, ShellContext, WithViewPlace } from '@ferretry/app/testing';
import type { ReactNode } from 'react';

ensureDom();
import { CiTab } from '../../../app/features/pr-page/ci-tab.tsx';
import { SafeProse } from '../../../app/features/pr-page/safe-prose.tsx';

/**
 * PR page text is from strangers (E4): a hidden control character is drawn as a visible chip, and every link it draws
 * follows the "Open links in" setting like any other link in the app.
 */
const URL = 'https://github.com/octo/demo/pull/7';

describe('hidden control characters in a PR body', () => {
  it('draws U+202E as a visible chip, never passing it on', async () => {
    const mounted = await mount(<SafeProse sourceUrl={URL} text={'looks fine ‮evil.exe and **bold​here**'} />);
    const root = mounted.container;
    const chips = [...root.querySelectorAll('[data-diff-control]')].map(chip => chip.getAttribute('data-diff-control'));
    expect(chips).toEqual(['U+202E', 'U+200B']);
    expect(must(root.querySelector('[data-diff-control="U+202E"]'), 'the chip').textContent).toBe('<U+202E>');
    expect(root.textContent).not.toContain('‮');
    expect(root.textContent).not.toContain('​');
    await mounted.unmount();
  });
});

describe('links in a PR page follow the "Open links in" setting', () => {
  const taken: string[] = [];
  const provision = {
    activate: (click: Event, target: { readonly href: string | undefined }): boolean => {
      click.preventDefault();
      taken.push(target.href ?? '');
      return true;
    },
    open: () => undefined,
    sheet: null,
    destination: () => 'in-app',
  };
  const shell = {
    runtime: {
      linkProvision: () => provision,
      subscribe: () => () => undefined,
      version: () => 0,
    },
  };
  const placed = (child: ReactNode) => (
    <ShellContext.Provider value={shell as never}>
      <WithViewPlace place={{ daemon: 'desk', machine: 'Desk' } as never}>{child}</WithViewPlace>
    </ShellContext.Provider>
  );

  it('hands a tap on a body link to the setting', async () => {
    taken.length = 0;
    const mounted = await mount(placed(<SafeProse sourceUrl={URL} text="see [the doc](https://example.com/doc)" />));
    const link = must(mounted.container.querySelector('[data-gh-link]'), 'the link');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(taken).toEqual(['https://example.com/doc']);
    await mounted.unmount();
  });

  it('hands a tap on a check link to the setting', async () => {
    taken.length = 0;
    const checks = {
      state: 'passing',
      total: 1,
      passed: 1,
      failed: 0,
      running: 0,
      queued: 0,
      items: [{ name: 'build', status: 'passed', url: 'https://github.com/octo/demo/runs/1' }],
    } as never;
    const pull = { url: URL } as never;
    const mounted = await mount(<RouterProvider>{placed(<CiTab checks={checks} pull={pull} />)}</RouterProvider>);
    const link = must(mounted.container.querySelector('a[href$="/runs/1"]'), 'the check link');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(taken).toEqual(['https://github.com/octo/demo/runs/1']);
    await mounted.unmount();
  });
});
