import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetRuntimeCatalog } from '@ferretry/protocol';
import { CredentialsTab } from '../../../../../src/features/fleet/credentials/credentials-tab.tsx';
import { RuntimesTab } from '../../../../../src/features/fleet/runtimes/runtimes-tab.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  credential,
  DATA,
  machineWith,
  NOW,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const PROPOSE = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  window.location.hash = '';
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const fill = async (field: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

const proposed = (calls: readonly Call[]): unknown[] =>
  calls.filter(call => call.path === '/v1/fleet/proposals').map(call => (call.body as { change: unknown }).change);

const OFF = { reason: 'Spend limit reached', until: '2026-11-01T00:00:00.000Z' } as const;

const credentialsWith = (disabledId?: string): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials: CREDENTIALS.credentials.map(item =>
    item.id === disabledId ? { ...item, disabled: { ...OFF, source: 'login' as const } } : item,
  ),
});

const runtimesWith = (disabled: Readonly<Record<string, 'login' | 'runtime'>>): FleetRuntimeCatalog => ({
  ...RUNTIMES,
  runtimes: RUNTIMES.runtimes.map(item =>
    item.name in disabled
      ? {
          ...item,
          disabled: { ...OFF, source: disabled[item.name] ?? 'runtime' },
          launch: { available: false as const, reason: `${item.name} is disabled.` },
        }
      : item,
  ),
});

const routes = (extra: Record<string, unknown> = {}) => ({
  ...READS(),
  [PROPOSE]: stagedFrom,
  [APPLY]: APPLIED,
  ...extra,
});

const openCredentials = async (hash: string, extra: Record<string, unknown> = {}, calls: Call[] = []) => {
  window.location.hash = hash;
  const view = await mount(
    <CredentialsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={null}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => scripted(routes(extra), calls)}
      now={() => NOW}
      pollMs={5}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

const openRuntimes = async (hash: string, extra: Record<string, unknown> = {}, calls: Call[] = []) => {
  window.location.hash = hash;
  const view = await mount(
    <RuntimesTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={null}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => scripted(routes(extra), calls)}
      pollMs={5}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

const switchOf = (container: ParentNode, name: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-disable-switch="${name}"] [role="switch"]`), `switch ${name}`);

describe('the switch on a login', () => {
  it('should be on in the list, and ask for a reason and a length before switching off', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openCredentials('#machines/studio-mac/credentials', {}, calls);
    const toggle = switchOf(view.container, 'codex');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // Act
    await click(toggle, 'switch');

    // Assert — nothing was sent: the form comes first.
    expect(proposed(calls)).toEqual([]);
    const form = must(view.container.querySelector('[data-disable-form]'), 'form');
    expect(form.textContent).toContain('Nothing is stopped');
    expect(form.textContent).toContain('fy migrate <id> -a <other runtime>');
  });

  it('should send the reason and the end, then read the machine again', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openCredentials('#machines/studio-mac/credentials', {}, calls);
    await click(switchOf(view.container, 'codex'), 'switch');

    // Act
    await fill(
      must(view.container.querySelector<HTMLInputElement>('[data-disable-reason]'), 'reason'),
      'Out of credit',
    );
    await fill(must(view.container.querySelector<HTMLSelectElement>('[data-disable-until]'), 'until'), 'date');
    await fill(must(view.container.querySelector<HTMLInputElement>('[data-disable-date]'), 'date'), '2026-11-01');
    const reads = calls.filter(call => call.path === '/v1/fleet/credentials').length;
    await click(view.container.querySelector('[data-disable-form] [data-change-submit]'), 'submit');

    // Assert
    expect(proposed(calls)).toEqual([
      { kind: 'credential.disable', id: 'codex', reason: 'Out of credit', until: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(calls.filter(call => call.path === '/v1/fleet/credentials').length).toBeGreaterThan(reads);
    expect(view.container.querySelector('[data-disable-form]')).toBeNull();
  });

  it('should hold the submit while the day is not after today', async () => {
    // Arrange
    const view = await openCredentials('#machines/studio-mac/credentials');
    await click(switchOf(view.container, 'codex'), 'switch');

    // Act
    await fill(must(view.container.querySelector<HTMLSelectElement>('[data-disable-until]'), 'until'), 'date');
    await fill(must(view.container.querySelector<HTMLInputElement>('[data-disable-date]'), 'date'), '2026-10-13');

    // Assert
    expect(must(view.container.querySelector('[data-disable-until-problem]'), 'problem').textContent).toBe(
      'Pick a day after today.',
    );
    expect(
      must(view.container.querySelector<HTMLButtonElement>('[data-disable-form] [data-change-submit]'), 'submit')
        .disabled,
    ).toBe(true);
  });

  it('should close the form on Cancel without sending anything', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openCredentials('#machines/studio-mac/credentials', {}, calls);
    await click(switchOf(view.container, 'codex'), 'switch');

    // Act
    await click(view.container.querySelector('[data-disable-cancel]'), 'cancel');

    // Assert
    expect(view.container.querySelector('[data-disable-form]')).toBeNull();
    expect(proposed(calls)).toEqual([]);
  });

  it('should show a disabled login off, with its reason and end, and switch it on with one tap', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openCredentials(
      '#machines/studio-mac/credentials',
      { 'GET /v1/fleet/credentials': credentialsWith('codex') },
      calls,
    );
    const toggle = switchOf(view.container, 'codex');
    const card = must(view.container.querySelector('[data-credential-card="codex"]'), 'card');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(card.querySelector('[data-credential-disabled-badge]')?.textContent).toBe('Disabled');
    expect(card.querySelector('[data-disable-headline]')?.textContent).toBe(
      'Off: new starts won’t use it; running ferrets keep going',
    );
    expect(card.querySelector('[data-disable-detail]')?.textContent).toBe('Spend limit reached. Back on 1 Nov 2026.');

    // Act
    await click(toggle, 'switch');

    // Assert — no form, no confirm: a single enable.
    expect(proposed(calls)).toEqual([{ kind: 'credential.enable', id: 'codex' }]);
  });

  it('should also sit on the login’s own page', async () => {
    // Act
    const view = await openCredentials('#machines/studio-mac/credentials/claude-work');

    // Assert
    expect(
      must(view.container.querySelector('[data-credential-page] [data-credential-switch]'), 'section').textContent,
    ).toContain('Use for new starts');
    expect(switchOf(view.container, 'claude-work').getAttribute('aria-checked')).toBe('true');
  });

  it('should lock the switch, with the reason, when this device may not change the fleet', async () => {
    // Act
    const view = await openCredentials('#machines/studio-mac/credentials/claude-work', {
      'GET /v1/fleet/machine': machineWith({ mayApply: false, applyRefusal: 'not-granted' }),
    });

    // Assert
    expect(switchOf(view.container, 'claude-work').disabled).toBe(true);
    expect(view.container.querySelector('[data-disable-refused]')?.textContent).toStartWith(
      'The switch is locked here: ',
    );
  });

  it('should say why when a switch-on is refused', async () => {
    // Arrange
    const view = await openCredentials('#machines/studio-mac/credentials', {
      'GET /v1/fleet/credentials': credentialsWith('codex'),
      [PROPOSE]: new Error('nope'),
    });

    // Act
    await click(switchOf(view.container, 'codex'), 'switch');

    // Assert
    expect(view.container.querySelector('[data-disable-error]')).not.toBeNull();
  });
});

describe('the inline switch in a card header', () => {
  it('should sit in the header row beside the runtime name, with no box, no On label and no helper while on', async () => {
    // Act
    const view = await openRuntimes('#machines/studio-mac/runtimes');

    // Assert
    const card = must(view.container.querySelector('[data-runtime-card="claude-agent"]'), 'card');
    const toggle = switchOf(view.container, 'claude-agent');
    expect(toggle.getAttribute('aria-label')).toBe('claude-agent: on for new starts');
    expect(toggle.textContent).toBe('');
    expect(card.querySelector('[data-disable-note]')).toBeNull();
    expect(card.textContent).not.toContain('New starts can use it.');
    const header = must(toggle.closest('[data-disable-switch]')?.parentElement ?? null, 'header row');
    expect(header.querySelector('[data-runtime-row="claude-agent"]')).not.toBeNull();
  });

  it('should word an off runtime as a small muted note, and name the state in the label', async () => {
    // Act
    const view = await openRuntimes('#machines/studio-mac/runtimes', {
      'GET /v1/fleet/runtimes': runtimesWith({ 'claude-review': 'runtime' }),
    });

    // Assert
    expect(switchOf(view.container, 'claude-review').getAttribute('aria-label')).toBe(
      'claude-review: off for new starts',
    );
    expect(
      view.container.querySelector('[data-runtime-card="claude-review"] [data-disable-headline]')?.textContent,
    ).toBe('Off: new starts won’t use it; running ferrets keep going');
  });
});

describe('the switch on a runtime', () => {
  it('should switch its own block off and on from the list', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openRuntimes(
      '#machines/studio-mac/runtimes',
      { 'GET /v1/fleet/runtimes': runtimesWith({ 'claude-review': 'runtime' }) },
      calls,
    );
    expect(switchOf(view.container, 'claude-review').getAttribute('aria-checked')).toBe('false');
    expect(
      view.container.querySelector('[data-runtime-card="claude-review"] [data-runtime-disabled-badge]'),
    ).not.toBeNull();

    // Act
    await click(switchOf(view.container, 'claude-review'), 'switch');

    // Assert
    expect(proposed(calls)).toEqual([{ kind: 'runtime.enable', name: 'claude-review' }]);
  });

  it('should ask first when switching off, and send a runtime change', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openRuntimes('#machines/studio-mac/runtimes/claude-agent', {}, calls);
    await click(switchOf(view.container, 'claude-agent'), 'switch');

    // Act
    await fill(must(view.container.querySelector<HTMLSelectElement>('[data-disable-until]'), 'until'), 'week');
    await click(view.container.querySelector('[data-disable-form] [data-change-submit]'), 'submit');

    // Assert
    const [change] = proposed(calls) as { kind: string; name: string; until: string }[];
    expect(change?.kind).toBe('runtime.disable');
    expect(change?.name).toBe('claude-agent');
    expect(Date.parse(change?.until ?? '')).toBeGreaterThan(Date.now());
  });

  it('should leave a runtime held off by its login to that login, with a link', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await openRuntimes(
      '#machines/studio-mac/runtimes/claude-default',
      { 'GET /v1/fleet/runtimes': runtimesWith({ 'claude-default': 'login' }) },
      calls,
    );
    const toggle = switchOf(view.container, 'claude-default');

    // Assert
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.disabled).toBe(true);
    expect(view.container.querySelector('[data-disable-headline]')?.textContent).toBe(
      'Off because its login claude-personal is disabled',
    );
    const link = must(view.container.querySelector<HTMLAnchorElement>('[data-disable-login-link]'), 'link');
    expect(link.getAttribute('href')).toBe('#machines/studio-mac/credentials/claude-personal');
    expect(proposed(calls)).toEqual([]);
  });

  it('should show the launch button off, with the daemon’s own reason, while disabled', async () => {
    // Act
    const view = await openRuntimes('#machines/studio-mac/runtimes/claude-review', {
      'GET /v1/fleet/runtimes': runtimesWith({ 'claude-review': 'runtime' }),
    });

    // Assert
    const launch = must(view.container.querySelector<HTMLButtonElement>('[data-runtime-launch]'), 'launch');
    expect(launch.disabled).toBe(true);
    expect(launch.textContent).toBe('claude-review is disabled.');
  });
});

void DATA;
void credential;
void runtime;
