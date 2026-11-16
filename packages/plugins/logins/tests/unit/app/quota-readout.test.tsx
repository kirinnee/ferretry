import { describe, expect, it } from 'bun:test';
import { LoginQuota, QuotaReadout, quotaOf } from '../../../app/features/quota-readout.tsx';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount } from '../support/dom.ts';
import { scripted } from './support/client.ts';

const NOW = Date.parse('2026-11-01T10:00:00.000Z');
const word = (word: string, extra: Record<string, unknown> = {}) =>
  login({
    id: word.replaceAll('_', '-'),
    status: { word, label: word, reason: 'access_current', explanation: 'x', lastCheckInconclusive: false },
    ...extra,
  });

const settle = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
};

const render = async (element: React.ReactElement) => {
  const view = await mount(element);
  return { view, text: () => view.container.textContent ?? '' };
};

describe('LoginQuota', () => {
  it('shows percent USED for each window, with the time to reset in the title', async () => {
    const { view, text } = await render(
      <LoginQuota now={NOW} quota={{ fiveHourPercent: 12, weeklyPercent: 80, fiveHourResetAt: NOW + 90 * 60_000 }} />,
    );
    expect(text()).toBe('5h 12%·wk 80%');
    expect(view.container.querySelector('span[title]')?.getAttribute('title')).toContain(
      '5-hour window 12% used · resets in 1h 30m',
    );
    await view.unmount();
  });

  it('says "quota —" for unknown, never 0%, and nothing at all when the caller does not want the dash', async () => {
    const dash = await render(<LoginQuota quota={null} showUnknown />);
    expect(dash.text()).toBe('quota —');
    await dash.view.unmount();
    const none = await render(<LoginQuota quota={null} />);
    expect(none.text()).toBe('');
    await none.view.unmount();
  });

  it('says a login needing sign-in is an auth problem, not a quota', async () => {
    const { view, text } = await render(<LoginQuota quota={{ authOk: false }} />);
    expect(text()).toBe('quota auth!');
    await view.unmount();
  });

  it('marks AT LIMIT even with no percentages, and shows money for a credit-billed login', async () => {
    const limit = await render(<LoginQuota quota={{ atLimit: true }} />);
    expect(limit.text()).toBe('at limit');
    await limit.view.unmount();
    const money = await render(<LoginQuota quota={{ balance: { amount: 12.34, currency: 'USD' } }} />);
    expect(money.text()).toBe('$12.34 left');
    await money.view.unmount();
  });
});

describe('quotaOf', () => {
  it('leaves out what nobody measured, so an unmeasured login is unknown rather than zero', () => {
    expect(quotaOf(word('ready', { usage: { fiveHour: {}, weekly: {} } }))).toBeNull();
    expect(quotaOf(word('ready'))).toMatchObject({ fiveHourPercent: 12 });
    expect(quotaOf(word('needs_sign_in'))).toEqual({ authOk: false });
  });

  it('takes a provider’s windows, its balance and an exhausted flag', () => {
    const provider = {
      source: 'zai-coding-plan',
      via: 'endpoint',
      windows: [{ label: '5h', usedPercent: 100 }],
      balance: { amount: 3, currency: 'USD' },
      exhausted: true,
      unverified: false,
      at: '2026-11-01T10:00:00.000Z',
    };
    expect(quotaOf(word('ready', { usage: { fiveHour: {}, weekly: {}, provider } }))).toMatchObject({
      fiveHourPercent: 100,
      atLimit: true,
      balance: { amount: 3, currency: 'USD' },
    });
  });
});

describe('the status-area readout', () => {
  it('draws one line per login and never calls a login that nobody checked ready', async () => {
    const client = scripted({
      'GET /v1/logins': loginList(word('checking'), word('refresh_due'), word('needs_sign_in'), login({ id: 'ok' })),
    });
    const view = await mount(<QuotaReadout client={client} now={NOW} />);
    await settle();
    const root = view.container;
    expect(root.querySelector('[data-quota-login="checking"]')?.textContent).toContain('checking');
    expect(root.querySelector('[data-quota-login="refresh-due"]')?.textContent).toContain('refresh due');
    expect(root.querySelector('[data-quota-login="needs-sign-in"]')?.textContent).toContain('quota auth!');
    expect(root.querySelector('[data-quota-login="ok"]')?.textContent).toContain('5h 12%');
    expect(root.textContent).not.toContain('0 logins ready');
    await view.unmount();
  });

  it('says there are no logins, and draws nothing until the list is read', async () => {
    const empty = await mount(<QuotaReadout client={scripted({ 'GET /v1/logins': loginList() })} />);
    await settle();
    expect(empty.container.textContent).toBe('No logins');
    await empty.unmount();
    const failing = await mount(<QuotaReadout client={scripted({})} />);
    expect(failing.container.textContent).toBe('');
    await failing.unmount();
  });
});
