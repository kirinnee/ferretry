import { describe, expect, it } from 'bun:test';
import { loginFromHash, signInsHash, useSignInsLogin } from '../../../app/lib/sign-ins-route.ts';
import { interact, mount, must } from '../support/dom.ts';

describe('loginFromHash', () => {
  it('reads the login a sign-ins link names, encoded or not', () => {
    expect(loginFromHash('#machines/box/sign-ins/claude-you')).toBe('claude-you');
    expect(loginFromHash('#machines/studio%20mac/sign-ins/claude%2Dyou')).toBe('claude-you');
  });

  it('a bare sign-ins hash, another tab’s hash and no hash at all name no login', () => {
    expect(loginFromHash('#machines/box/sign-ins')).toBeNull();
    expect(loginFromHash('#machines/box/sign-ins/')).toBeNull();
    expect(loginFromHash('#machines/box/runtimes/claude-you')).toBeNull();
    expect(loginFromHash('#warden')).toBeNull();
    expect(loginFromHash('')).toBeNull();
  });

  it('an item that does not decode names no login', () => {
    expect(loginFromHash('#machines/box/sign-ins/%')).toBeNull();
  });

  it('an item that is not a login id names no login, so a crafted link cannot put its own words in a notice', () => {
    expect(
      loginFromHash('#machines/x/sign-ins/Your%20session%20expired%2C%20sign%20in%20at%20evil.example'),
    ).toBeNull();
    expect(loginFromHash('#machines/x/sign-ins/Claude-You')).toBeNull();
    expect(loginFromHash(`#machines/x/sign-ins/${'a'.repeat(65)}`)).toBeNull();
    expect(loginFromHash(`#machines/x/sign-ins/${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });
});

describe('signInsHash', () => {
  it('names the tab, and one page on it', () => {
    expect(signInsHash('box')).toBe('#machines/box/sign-ins');
    expect(signInsHash('studio mac', 'claude you')).toBe('#machines/studio%20mac/sign-ins/claude%20you');
  });
});

interface FakeBrowser {
  readonly browser: Window;
  readonly location: { hash: string };
  readonly listeners: Map<string, Set<() => void>>;
  readonly fire: (type: string) => void;
}

const fakeBrowser = (hash: string): FakeBrowser => {
  const location = { hash };
  const listeners = new Map<string, Set<() => void>>();
  const fake = {
    location,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    browser: fake as unknown as Window,
    location,
    listeners,
    fire: type => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
};

/** The hook under a probe, so a test can call its open directly. */
interface Probe {
  current: readonly [string | null, (loginId: string | null) => void] | null;
}

function HookHost({
  machine,
  browser,
  probe,
}: {
  readonly machine: string | null;
  readonly browser: Window;
  readonly probe: Probe;
}) {
  const hooks = useSignInsLogin(machine, browser);
  probe.current = hooks;
  return <p data-detail={hooks[0] ?? 'none'}>{hooks[0] ?? 'none'}</p>;
}

describe('useSignInsLogin', () => {
  it('opens on the page the link names, from a browser it is handed', async () => {
    const fake = fakeBrowser('#machines/box/sign-ins/claude-you');
    const probe: Probe = { current: null };
    const view = await mount(<HookHost machine="box" browser={fake.browser} probe={probe} />);
    expect(must(view.container.querySelector('p'), 'the probe').getAttribute('data-detail')).toBe('claude-you');
    expect(fake.listeners.get('hashchange')?.size).toBe(1);
    await view.unmount();
    expect(fake.listeners.get('hashchange')?.size).toBe(0);
  });

  it('follows Back and Forward through hashchange, and another tab’s hash opens the list', async () => {
    const fake = fakeBrowser('#machines/box/sign-ins/claude-you');
    const probe: Probe = { current: null };
    const view = await mount(<HookHost machine="box" browser={fake.browser} probe={probe} />);
    fake.location.hash = '#machines/box/sign-ins/codex-you';
    await interact(() => fake.fire('hashchange'));
    expect(must(view.container.querySelector('p'), 'the probe').getAttribute('data-detail')).toBe('codex-you');
    fake.location.hash = '#machines/box/sign-ins';
    await interact(() => fake.fire('hashchange'));
    expect(must(view.container.querySelector('p'), 'the probe').textContent).toBe('none');
    fake.location.hash = '#machines/box/runtimes/claude-default';
    await interact(() => fake.fire('hashchange'));
    expect(must(view.container.querySelector('p'), 'the probe').textContent).toBe('none');
    await view.unmount();
  });

  it('opens a page by writing the link, and closes it back to the tab', async () => {
    const fake = fakeBrowser('#machines/box/sign-ins');
    const probe: Probe = { current: null };
    const view = await mount(<HookHost machine="box" browser={fake.browser} probe={probe} />);
    await interact(() => must(probe.current, 'hook')[1]('claude-you'));
    expect(fake.location.hash).toBe('#machines/box/sign-ins/claude-you');
    expect(must(view.container.querySelector('p'), 'the probe').getAttribute('data-detail')).toBe('claude-you');
    await interact(() => must(probe.current, 'hook')[1](null));
    expect(fake.location.hash).toBe('#machines/box/sign-ins');
    expect(must(view.container.querySelector('p'), 'the probe').textContent).toBe('none');
    await view.unmount();
  });

  it('opens a page without writing the link while the machine is not known yet', async () => {
    const fake = fakeBrowser('#machines/box/sign-ins');
    const probe: Probe = { current: null };
    const view = await mount(<HookHost machine={null} browser={fake.browser} probe={probe} />);
    await interact(() => must(probe.current, 'hook')[1]('claude-you'));
    expect(fake.location.hash).toBe('#machines/box/sign-ins');
    expect(must(view.container.querySelector('p'), 'the probe').getAttribute('data-detail')).toBe('claude-you');
    await view.unmount();
  });
});
