import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';
import { IDENTITY_WAITS_WORDS } from '../../../../app/features/settings/browser-identities-section.tsx';
import { newIdentityProblem } from '../../../../app/lib/browsers-config.ts';
import type { RecordedCall } from '../../../support/app/client.ts';
import { recordingClient } from '../../../support/app/client.ts';

/** A secret reference exactly as a file holds one. */
const secretRef = (name: string): string => `\${secret:${name}}`;

const CONFIG_GET = 'GET /v1/config/file';
const CONFIG_PUT = 'PUT /v1/config/file';
const IDENTITIES = 'GET /v1/browser/identities';
const STOP = 'POST /v1/browser/identities/:identity/stop';

/** Synthetic identities as the daemon would say them: `agent` stopped, `work` running behind a proxy of its own. */
const REAL = {
  maxRunning: 4,
  identities: [
    { identity: 'agent', builtIn: true, engine: 'chromium', running: false, lastUsedAt: '2026-11-20T10:00:00.000Z' },
    {
      identity: 'work',
      builtIn: false,
      engine: 'chromium',
      running: true,
      startedAt: '2026-11-27T09:00:00.000Z',
      proxy: { name: 'work-proxy.example.test:8080', own: true },
    },
  ],
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};
const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};
const typeInto = async (element: Element | null, value: string): Promise<void> => {
  const field = must(element as HTMLInputElement | null, 'the field');
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const body = (calls: readonly RecordedCall[], route: string): unknown =>
  calls.filter(call => call.route === route).at(-1)?.init?.body;

interface Script {
  readonly text?: string;
  readonly identities?: unknown;
  readonly put?: unknown;
  readonly stopped?: unknown;
  readonly readsBackWhatWasWritten?: boolean;
}

const tab = async (script: Script = {}) => {
  let text = script.text ?? 'mode: headless\nidentities:\n  work: {}\n';
  let state: 'ok' | 'pending' = 'ok';
  const recorded = recordingClient((route, init) => {
    if (route === CONFIG_GET) return { path: 'browsers.yaml', exists: true, text, etag: 'etag-1', state };
    if (route === CONFIG_PUT) {
      if (script.readsBackWhatWasWritten === true) {
        text = (init as { body: { text: string } }).body.text;
        state = 'pending';
      }
      return script.put ?? { path: 'browsers.yaml', etag: 'etag-2', outcome: 'applied' };
    }
    if (route === 'GET /v1/config/status') return { directory: '/x', files: [], issues: [], pending: [] };
    if (route === IDENTITIES) return script.identities ?? REAL;
    if (route === STOP) return script.stopped ?? { ...REAL.identities[1], running: false, startedAt: undefined };
    if (route === 'GET /v1/browser/state') return { state: 'running' };
    if (route === 'GET /v1/grants')
      return { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };
    if (route === 'GET /v1/secrets') return { health: 'ready', secrets: [] };
    return new Error(`no route ${route}`);
  });
  const view = await mount(<BrowserTab client={recorded.client} />);
  await settle();
  return { ...recorded, view };
};

const rows = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-browser-identity]')].map(
    row => row.getAttribute('data-browser-identity') ?? '',
  );

describe('Settings › Browser › Identities', () => {
  it('lists the daemon’s real identities, running or not, with the proxy by name and no placeholder row', async () => {
    const { calls, view } = await tab({
      identities: {
        maxRunning: 2,
        identities: [
          { identity: 'agent', builtIn: true, engine: 'chromium', running: false },
          {
            identity: 'zeta',
            builtIn: false,
            engine: 'chromium',
            running: false,
            proxy: { name: 'p.example.test:1080', own: false },
          },
        ],
      },
    });
    expect(calls.some(call => call.route === IDENTITIES)).toBe(true);
    // Exactly what the daemon said, in its order: the file's own `work` is not invented into the list.
    expect(rows(view.container)).toEqual(['agent', 'zeta']);
    const zeta = view.container.querySelector('[data-browser-identity="zeta"]')?.textContent ?? '';
    expect(zeta).toContain('Chromium');
    expect(zeta).toContain('Via p.example.test:1080 (the machine’s proxy)');
    expect(zeta).toContain('Never opened');
    expect(view.container.querySelector('[data-browser-identity="agent"]')?.textContent).toContain('Direct, no proxy');
    await view.unmount();
  });

  it('shows which identity runs and offers Stop only on a running one', async () => {
    const { view } = await tab();
    const agent = view.container.querySelector('[data-browser-identity="agent"]');
    const work = view.container.querySelector('[data-browser-identity="work"]');
    expect(agent?.querySelector('[data-browser-identity-running]')?.getAttribute('data-browser-identity-running')).toBe(
      'false',
    );
    expect(work?.querySelector('[data-browser-identity-running]')?.getAttribute('data-browser-identity-running')).toBe(
      'true',
    );
    expect(agent?.querySelector('[data-browser-identity-stop]')).toBeNull();
    expect(work?.querySelector('[data-browser-identity-stop]')).not.toBeNull();
    expect(work?.textContent).toContain('Via work-proxy.example.test:8080');
    await view.unmount();
  });

  it('stops only the identity whose Stop was pressed, then reads the list again', async () => {
    const { calls, view } = await tab();
    await click(view.container.querySelector('[data-browser-identity-stop="work"]'), 'Stop work');
    const stops = calls.filter(call => call.route === STOP);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.init?.params).toEqual({ identity: 'work' });
    expect(calls.filter(call => call.route === IDENTITIES)).toHaveLength(2);
    await view.unmount();
  });

  it('says why a stop did not happen', async () => {
    const recorded = await tab({ stopped: new Error('there is no browser identity named work') });
    await click(recorded.view.container.querySelector('[data-browser-identity-stop="work"]'), 'Stop work');
    expect(
      recorded.view.container.querySelector('[data-setup-note="browser-identities-stop-refused"]')?.textContent,
    ).toContain('no browser identity named work');
    await recorded.view.unmount();
  });

  it('adds an identity by writing browsers.yaml against the digest it was read at, keeping the file as it was', async () => {
    const { calls, view } = await tab({ text: '# my browsers\nmode: headless\nidentities:\n  work: {}\n' });
    await typeInto(view.container.querySelector('[data-browser-identity-key]'), 'docs');
    await click(view.container.querySelector('[data-browser-identity-submit]'), 'Add identity');
    const sent = body(calls, CONFIG_PUT) as { path: string; text: string; etag: string };
    expect(sent.path).toBe('browsers.yaml');
    expect(sent.etag).toBe('etag-1');
    expect(sent.text).toContain('# my browsers');
    expect(sent.text).toContain('work: {}');
    expect(sent.text).toMatch(/docs: \{\}/u);
    // The write is the config proposal path's: nothing else on the daemon was asked to make the identity.
    expect(calls.map(call => call.route).filter(route => route.startsWith('POST'))).toEqual([]);
    await view.unmount();
  });

  it('keeps a proxy already in the file as the file spells it when another identity is added', async () => {
    const text = `identities:\n  work:\n    proxy:\n      url: http://work-proxy.example.test:8080\n      username: ${secretRef('WORK_USER')}\n      password: ${secretRef('WORK_PASS')}\n`;
    const { calls, view } = await tab({ text });
    await typeInto(view.container.querySelector('[data-browser-identity-key]'), 'docs');
    await click(view.container.querySelector('[data-browser-identity-submit]'), 'Add identity');
    const sent = (body(calls, CONFIG_PUT) as { text: string }).text;
    expect(sent).toContain(`username: ${secretRef('WORK_USER')}`);
    expect(sent).not.toContain('bypass');
    await view.unmount();
  });

  it('keeps comments inside the identities map when adding another identity', async () => {
    const text =
      '# browser notes\nidentities: # separate accounts\n  # work account\n  work: # keep this profile\n    proxy:\n      url: http://work-proxy.example.test:8080 # office exit\n  # personal account\n  personal: {} # keep sign-ins\n';
    const { calls, view } = await tab({ text });
    await typeInto(view.container.querySelector('[data-browser-identity-key]'), 'docs');
    await click(view.container.querySelector('[data-browser-identity-submit]'), 'Add identity');
    const sent = (body(calls, CONFIG_PUT) as { text: string }).text;
    for (const comment of [
      'browser notes',
      'separate accounts',
      'work account',
      'keep this profile',
      'office exit',
      'personal account',
      'keep sign-ins',
    ])
      expect(sent).toContain(`# ${comment}`);
    expect(sent).toContain('docs: {}');
    await view.unmount();
  });

  it('shows the live direct connection and a changed proxy only for the next launch', async () => {
    const { view } = await tab({
      identities: {
        maxRunning: 4,
        identities: [{ ...REAL.identities[1], liveProxy: null }],
      },
    });
    const work = view.container.querySelector('[data-browser-identity="work"]')?.textContent ?? '';
    expect(work).toContain('Now: direct');
    expect(work).toContain('Next launch: work-proxy.example.test:8080');
    expect(work).not.toContain('Via work-proxy');
    await view.unmount();
  });

  it('a per-identity proxy that loosens shows as waiting for the owner, and the held identity is listed as such', async () => {
    const { calls, view } = await tab({
      put: { path: 'browsers.yaml', etag: 'etag-2', outcome: 'pending' },
      readsBackWhatWasWritten: true,
    });
    await typeInto(view.container.querySelector('[data-browser-identity-key]'), 'docs');
    await typeInto(
      view.container.querySelector('[data-browser-identity-proxy]'),
      'http://docs-proxy.example.test:8080',
    );
    await click(view.container.querySelector('[data-browser-identity-submit]'), 'Add identity');
    const sent = (body(calls, CONFIG_PUT) as { text: string }).text;
    expect(sent).toContain('url: http://docs-proxy.example.test:8080');
    expect(view.container.querySelector('[data-setup-note="browser-identities-held"]')?.textContent).toBe(
      IDENTITY_WAITS_WORDS,
    );
    // Read back from the file on disk: the identity is there, marked as waiting, with its proxy by name only.
    const held = view.container.querySelector('[data-browser-identity="docs"][data-browser-identity-waits]');
    expect(held?.textContent).toContain('Waits for you');
    expect(held?.textContent).toContain('Via docs-proxy.example.test:8080');
    await view.unmount();
  });

  it('refuses a name the daemon would not read, and one that is taken, before anything is sent', async () => {
    const { calls, view } = await tab();
    for (const [typed, said] of [
      ['Docs', 'lowercase letters'],
      ['agent', 'already an identity named agent'],
      ['work', 'already an identity named work'],
    ] as const) {
      await typeInto(view.container.querySelector('[data-browser-identity-key]'), typed);
      expect(view.container.querySelector('[data-browser-identity-problem]')?.textContent).toContain(said);
      expect((view.container.querySelector('[data-browser-identity-submit]') as HTMLButtonElement).disabled).toBe(true);
    }
    expect(calls.some(call => call.route === CONFIG_PUT)).toBe(false);
    await view.unmount();
  });

  it('puts a refused write in front of the person', async () => {
    const { view } = await tab({ put: new Error('browsers.yaml changed since you read it') });
    await typeInto(view.container.querySelector('[data-browser-identity-key]'), 'docs');
    await click(view.container.querySelector('[data-browser-identity-submit]'), 'Add identity');
    expect(view.container.querySelector('[data-setup-note="browser-identities-refusal"]')?.textContent).toContain(
      'changed since you read it',
    );
    await view.unmount();
  });

  it('says why the identities did not load, and keeps the rest of the tab', async () => {
    const { view } = await tab({ identities: new Error('this machine does not list identities') });
    expect(view.container.querySelector('[data-browser-identities-reason]')?.textContent).toContain(
      'does not list identities',
    );
    expect(view.container.querySelector('[data-browser-identity]')).toBeNull();
    expect(view.container.querySelector('[data-browser-user-agent]')).not.toBeNull();
    await view.unmount();
  });

  it('judges a new name by the grammar and the names taken', () => {
    expect(newIdentityProblem('', 'docs', '')).toBeUndefined();
    expect(newIdentityProblem('', '1docs', '')).toContain('lowercase');
    expect(newIdentityProblem('identities:\n  docs: {}\n', 'docs', '')).toContain('already');
    expect(newIdentityProblem('', 'docs', 'http://user:pw@proxy.example.test:8080')).toContain(
      'never carries a user name',
    );
    expect(newIdentityProblem('', 'docs', 'not a url')).toContain('proxy address');
  });
});
