import type { SessionView, StartSessionRequest, UsageFeedView } from '@ferretry/protocol';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';

import { NewSessionPage, type NewSessionPageProps } from '../../src/components/new-session-page.tsx';
import type { PickerAccount } from '../../src/lib/account-picker-catalog.ts';
import { type DaemonAccountPickerPort, DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { DaemonProjectsStore, daemonProjectsPort } from '../../src/lib/projects-store.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { type DaemonUsageSlice, DaemonUsageStore, daemonUsagePort } from '../../src/lib/usage-store.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://daemon.example.test',
  deviceToken: 'device-token',
});

const page = (overrides: Partial<NewSessionPageProps> = {}) => {
  const navigated: string[] = [];
  const starts: Array<{ connection: typeof connection; request: StartSessionRequest }> = [];
  const props: NewSessionPageProps = {
    connection,
    startSession: async (target, request) => {
      starts.push({ connection: target, request });
      return { config: { id: 'new/session' } };
    },
    onNavigate: path => navigated.push(path),
    ...overrides,
  };
  return { navigated, starts, view: render(<NewSessionPage {...props} />) };
};

const input = (view: ReturnType<typeof render>, id: string): ReactTestInstance => view.root.findByProps({ id });

const change = (view: ReturnType<typeof render>, id: string, value: string): void => {
  run(() => input(view, id).props.onChange({ target: { value } }));
};

const button = (view: ReturnType<typeof render>, label: string): ReactTestInstance => {
  const found = view.root.findAll(node => node.type === 'button' && node.children.join('') === label).at(0);
  if (found === undefined) throw new Error(`missing button ${label}`);
  return found;
};

describe('NewSessionPage', () => {
  it('renders the original free-text fallback and keeps auto creation disabled until agent and prompt are present', () => {
    const { view } = page();

    expect(view.root.findByProps({ id: 'new-session-heading' }).children.join('')).toBe('New session');
    expect(input(view, 'fy-new-session-agent').props.placeholder).toBe('claude-auto-loge');
    expect(input(view, 'fy-new-session-cwd').props.placeholder).toBe('/absolute/path/to/project');
    expect(input(view, 'fy-new-session-prompt').props.placeholder).toBe('Describe the task…');
    expect(button(view, 'Create session').props.disabled).toBeTrue();

    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port the page');

    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('allows an interactive session without an opening message and changes the prompt copy with the mode', () => {
    const { view } = page();
    change(view, 'fy-new-session-agent', 'codex-auto-loge');

    run(() => button(view, 'interactive').props.onClick());

    expect(input(view, 'fy-new-session-prompt').props.placeholder).toBe('(optional) first message…');
    expect(JSON.stringify(view.toJSON())).toContain('Opening message (optional)');
    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('starts only through the explicit paired connection and navigates to the daemon-scoped session path', async () => {
    const { navigated, starts, view } = page();
    change(view, 'fy-new-session-agent', ' claude-auto-loge ');
    change(view, 'fy-new-session-cwd', ' /work/ferretry ');
    change(view, 'fy-new-session-prompt', ' Port PWA pages ');

    await runAsync(async () => {
      button(view, 'Create session').props.onClick();
      await Promise.resolve();
    });

    expect(starts).toEqual([
      {
        connection,
        request: {
          agent: 'claude-auto-loge',
          boardAccess: 'none',
          cwd: '/work/ferretry',
          mode: 'auto',
          prompt: 'Port PWA pages',
        },
      },
    ]);
    expect(navigated).toEqual(['/d/daemon%2Fa/session/new%2Fsession']);
  });

  it('shows a daemon failure and makes the form actionable again', async () => {
    const { view } = page({ startSession: async () => Promise.reject(new Error('daemon refused start')) });
    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port PWA pages');

    await runAsync(async () => {
      button(view, 'Create session').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('daemon refused start');
    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('returns to the current daemon sessions list for both back and cancel', () => {
    const { navigated, view } = page();

    run(() => button(view, '← Sessions').props.onClick());
    run(() => button(view, 'Cancel').props.onClick());

    expect(navigated).toEqual(['/d/daemon%2Fa', '/d/daemon%2Fa']);
  });
});

// ─── the connected pickers ───────────────────────────────────────────────────
//
// These run against a real DOM rather than the renderable tree, because the
// combobox is a document fact: focus reveals the list, `aria-activedescendant`
// points into it, and a row is activated on pointer-UP with the caret left in
// the text box. Asserting any of that against `toJSON()` would test the props
// this page passes and none of the behaviour a reader gets.
//
// Nothing below fakes a picker. The stores are the real daemon-scoped ones over
// fake PORTS, so what a test proves about traffic — one manifest read, no health
// probe, no project registration — is a claim about the wiring rather than about
// a stub that agreed with it.

const workstation = daemonConnection({
  daemonId: 'daemon/b',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const studio: PickerAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-studio',
  home: '/homes/claude-auto-studio',
  displayName: 'Studio Claude',
  defaultModel: 'claude-opus-5',
  models: [
    { id: 'claude-opus-5', available: true },
    { id: 'claude-haiku-4-5', available: false, unavailableReason: 'this account is not entitled to it' },
  ],
  available: true,
  unavailableReason: null,
};

const atelier: PickerAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'codex',
  mode: 'auto',
  wrapper: 'codex-auto-atelier',
  home: '/homes/codex-auto-atelier',
  displayName: 'Atelier Codex',
  defaultModel: 'gpt-5.6-terra',
  models: [{ id: 'gpt-5.6-terra', available: true }],
  available: true,
  unavailableReason: null,
};

/** The OTHER daemon's account, so a switched connection has something else to show. */
const warehouse: PickerAccount = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-warehouse',
  home: '/homes/claude-auto-warehouse',
  displayName: 'Warehouse Claude',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5', available: true }],
  available: true,
  unavailableReason: null,
};

/** One `/v1/projects` row, as the daemon publishes it. */
const projectRow = (id: string, name: string, path: string) => ({
  id,
  name,
  path,
  source: 'existing-folder' as const,
  createdAt: '2026-08-01T09:00:00.000Z',
});

/** Keyed by ORIGIN, because that is all a fetcher is told about who it is answering. */
const registeredRows = {
  [new URL(connection.baseUrl).origin]: [
    projectRow('44444444-4444-4444-8444-444444444444', 'ferretry', '/work/ferretry'),
  ],
  [new URL(workstation.baseUrl).origin]: [
    projectRow('55555555-5555-4555-8555-555555555555', 'warehouse-app', '/srv/warehouse-app'),
  ],
} as const;

/**
 * The workstation's OWN `claude-auto-studio`, which is a different account that
 * happens to share a string with the laptop's. Wrapper names are per-machine, so
 * this collision is the normal case rather than a contrived one.
 */
const warehouseStudio: PickerAccount = {
  id: '66666666-6666-4666-8666-666666666666',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-studio',
  home: '/homes/claude-auto-studio',
  displayName: 'Warehouse Studio',
  defaultModel: 'claude-sonnet-5',
  models: [{ id: 'claude-sonnet-5', available: true }],
  available: true,
  unavailableReason: null,
};

const rosters = {
  [connection.daemonId]: [studio, atelier],
  [workstation.daemonId]: [warehouse, warehouseStudio],
} as const;

/** A session in a folder NOBODY registered — the only evidence for a recent path. */
const scratchSession = sessionView('scratch', { config: { cwd: '/work/scratch' } });

type ReadOutcome<T> = T | 'unreadable';

interface WiredOptions {
  readonly connection?: DaemonConnection;
  readonly accounts?: ReadOutcome<readonly PickerAccount[]>;
  readonly registered?: ReadOutcome<readonly ReturnType<typeof projectRow>[]>;
  readonly sessions?: ReadOutcome<readonly SessionView[]>;
  /** `absent` hands the form no usage store at all, which is a legal wiring. */
  readonly quota?: 'feed' | 'unreadable' | 'absent';
  readonly startSession?: NewSessionPageProps['startSession'];
}

interface Recorder {
  /** Every HTTP call the folder and quota reads make, method included. */
  readonly requests: Array<{ readonly method: string; readonly path: string }>;
  readonly starts: Array<{ readonly connection: DaemonConnection; readonly request: StartSessionRequest }>;
  readonly navigated: string[];
  probes: number;
  manifests: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const feedBody: UsageFeedView = {
  at: '2026-08-01T09:00:00.000Z',
  stale: false,
  accounts: [{ agent: 'claude-auto-studio', fiveHourPercent: 37, weeklyPercent: 61, atLimit: false, authOk: true }],
};

/**
 * A usage store frozen in one slice.
 *
 * The real store never publishes some of these states — an `error` with no
 * sentence, or a failure over a feed it still holds without a poll in between —
 * and those are exactly the readings a surface must get right, so they are set
 * here rather than waited for.
 */
const stubUsage = (slice: DaemonUsageSlice): DaemonUsageStore =>
  ({
    subscribe: () => () => undefined,
    watch: () => () => undefined,
    usage: () => slice,
  }) as unknown as DaemonUsageStore;

const wire = (options: WiredOptions = {}) => {
  const target = options.connection ?? connection;
  const recorder: Recorder = { requests: [], starts: [], navigated: [], probes: 0, manifests: 0 };

  const accountsPort: DaemonAccountPickerPort = {
    catalog: async daemon => {
      recorder.manifests += 1;
      const roster = options.accounts ?? rosters[daemon.daemonId] ?? [];
      if (roster === 'unreadable') throw new Error('this daemon refused its account manifest');
      return { accounts: roster };
    },
    health: async () => {
      recorder.probes += 1;
      return {
        health: new Map([
          [
            studio.id,
            {
              accountId: studio.id,
              kind: 'claude' as const,
              state: 'healthy' as const,
              cached: false,
              checkedAt: 5,
              ms: 900,
            },
          ],
        ]),
        error: null,
      };
    },
  };

  const fleetPort: DaemonFleetPort = {
    list: async () => {
      const sessions = options.sessions ?? [scratchSession];
      if (sessions === 'unreadable') throw new Error('the session list could not be read');
      return sessions;
    },
    get: async () => {
      throw new Error('this form never reads a single session');
    },
  };

  const fetcher: DaemonFetch = async (resource, init) => {
    const url = new URL(String(resource));
    recorder.requests.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname });
    if (url.pathname === '/v1/projects') {
      const registry = options.registered ?? registeredRows[url.origin] ?? [];
      return registry === 'unreadable' ? json({ error: 'the project registry is damaged' }, 503) : json(registry);
    }
    if (url.pathname === '/v1/usage') {
      return options.quota === 'unreadable' ? json({ error: 'the usage feed is unavailable' }, 503) : json(feedBody);
    }
    return json({ error: `no test route for ${url.pathname}` }, 502);
  };

  const props: NewSessionPageProps = {
    connection: target,
    startSession:
      options.startSession ??
      (async (daemon, request) => {
        recorder.starts.push({ connection: daemon, request });
        return { config: { id: 'new/session' } };
      }),
    onNavigate: path => recorder.navigated.push(path),
    accounts: new DaemonAccountPickerStore(accountsPort),
    projects: new DaemonProjectsStore(daemonProjectsPort(fetcher)),
    fleet: new DaemonFleetStore(fleetPort),
    ...(options.quota === 'absent'
      ? {}
      : { usage: new DaemonUsageStore(daemonUsagePort(fetcher), { pollMs: 60_000, isHidden: () => true }) }),
  };

  return { props, recorder };
};

// ─── DOM helpers ─────────────────────────────────────────────────────────────

let live: Mounted | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

/** Mounts and remembers, so a failed assertion still tears its subtree down. */
const show = async (props: NewSessionPageProps): Promise<Mounted> => {
  const mounted = await mount(<NewSessionPage {...props} />);
  live = mounted;
  return mounted;
};

const root = (): HTMLElement => must(live, 'a mounted new-session form').container;

const box = (id: string): HTMLInputElement => {
  const element = root().querySelector(`#${id}`);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${id} is not a mounted input`);
  return element;
};

const promptBox = (): HTMLTextAreaElement => {
  const element = root().querySelector('#fy-new-session-prompt');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('the prompt is not a mounted textarea');
  return element;
};

/** Focus is what reveals a list, exactly as a reader's tap or Tab does. */
const openList = (id: string): Promise<void> => interact(() => box(id).focus());

/** Moves the caret to a plain box, so no picker panel is open. */
const closeLists = (): Promise<void> => interact(() => box('fy-new-session-label').focus());

const rows = (): readonly Element[] => [...root().querySelectorAll('[role="option"]')];

const rowText = (index: number): string => must(rows()[index], `row ${index}`).textContent ?? '';

const panelState = (): string | null =>
  root().querySelector('[data-picker-state]')?.getAttribute('data-picker-state') ?? null;

const panelText = (): string => root().querySelector('[data-picker-state]')?.textContent ?? '';

const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> =>
  interact(() => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

const pressRow = async (index: number): Promise<void> => {
  const row = must(rows()[index], `row ${index}`);
  await interact(() => {
    for (const kind of ['pointerdown', 'pointerup']) {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 7 });
      row.dispatchEvent(event);
    }
  });
};

const namedButton = (label: string): HTMLButtonElement => {
  const found = [...root().querySelectorAll('button')].find(candidate => (candidate.textContent ?? '').includes(label));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${label}`);
  return found;
};

const press = (element: Element): Promise<void> =>
  interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

/** Presses Create and lets the start promise and the navigation settle. */
const create = async (): Promise<void> => {
  await press(namedButton('Create session'));
  await interact(async () => {
    await Promise.resolve();
  });
};

describe('NewSessionPage with the daemon pickers', () => {
  it('starts the session a chosen account and a chosen registered project describe', async () => {
    const { props, recorder } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    expect(rowText(0)).toContain('Studio Claude');
    await pressRow(0);
    expect(box('fy-new-session-agent').value).toBe('claude-auto-studio');

    await openList('fy-new-session-cwd');
    expect(rowText(0)).toContain('Registered');
    await pressRow(0);
    expect(box('fy-new-session-cwd').value).toBe('/work/ferretry');

    await closeLists();
    await typeInto(promptBox(), 'Wire the pickers');
    await create();

    expect(recorder.starts).toEqual([
      {
        connection: props.connection,
        request: {
          agent: 'claude-auto-studio',
          boardAccess: 'none',
          cwd: '/work/ferretry',
          mode: 'auto',
          prompt: 'Wire the pickers',
        },
      },
    ]);
    expect(recorder.navigated).toEqual(['/d/daemon%2Fa/session/new%2Fsession']);
  });

  it('marks a folder a session merely used as recent, and starts there without registering it', async () => {
    const { props, recorder } = wire();
    await show(props);

    await openList('fy-new-session-cwd');
    expect(rowText(0)).toContain('Registered');
    expect(rowText(1)).toContain('/work/scratch');
    expect(rowText(1)).toContain('Recent');
    expect(rowText(1)).not.toContain('Registered');

    await pressRow(1);
    expect(box('fy-new-session-cwd').value).toBe('/work/scratch');

    await closeLists();
    await typeInto(box('fy-new-session-agent'), 'claude-auto-studio');
    await typeInto(promptBox(), 'Try something scratch');
    await create();

    expect(recorder.starts.at(0)?.request.cwd).toBe('/work/scratch');
    // The whole reason `Recent` is its own badge: choosing one declares nothing.
    expect(recorder.requests.filter(request => request.method !== 'GET')).toEqual([]);
  });

  it('reads a chosen account’s models as SUGGESTIONS and leaves the model unset', async () => {
    const { props, recorder } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    await pressRow(0);

    const suggestions = [...root().querySelectorAll('#fy-new-session-model-options option')].map(option =>
      option.getAttribute('value'),
    );
    expect(suggestions).toEqual(['claude-opus-5']);
    expect(box('fy-new-session-model').getAttribute('list')).toBe('fy-new-session-model-options');
    // Declared unavailable by the manifest, so it is not offered.
    expect(suggestions).not.toContain('claude-haiku-4-5');
    // The point of the whole callback: the box the daemon reads stays empty.
    expect(box('fy-new-session-model').value).toBe('');

    await closeLists();
    await typeInto(promptBox(), 'Use whatever this account defaults to');
    await create();

    const request = must(recorder.starts.at(0), 'a start').request;
    expect(Object.hasOwn(request, 'model')).toBeFalse();
    expect(request.agent).toBe('claude-auto-studio');
  });

  it('drops the suggestions when the box no longer names that account', async () => {
    const { props } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    await pressRow(0);
    expect(root().querySelector('#fy-new-session-model-options')).not.toBeNull();

    await typeInto(box('fy-new-session-agent'), 'claude-auto-elsewhere');

    expect(root().querySelector('#fy-new-session-model-options')).toBeNull();
    expect(box('fy-new-session-model').hasAttribute('list')).toBeFalse();
  });

  it('filters the roster from the field the reader actually types in', async () => {
    const { props } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    expect(rows()).toHaveLength(2);

    await typeInto(box('fy-new-session-agent'), 'atel');
    expect(rows()).toHaveLength(1);
    expect(rowText(0)).toContain('Atelier Codex');

    await typeInto(box('fy-new-session-agent'), 'glm-mass-chore');
    expect(panelState()).toBe('no-match');
    expect(box('fy-new-session-agent').value).toBe('glm-mass-chore');
  });

  it('keeps both boxes typeable when every catalogue read fails, and starts from the typed text', async () => {
    const { props, recorder } = wire({ accounts: 'unreadable', registered: 'unreadable', sessions: 'unreadable' });
    await show(props);

    await openList('fy-new-session-agent');
    expect(panelState()).toBe('failed');
    expect(panelText()).toContain('this daemon refused its account manifest');
    expect(box('fy-new-session-agent').hasAttribute('disabled')).toBeFalse();

    await openList('fy-new-session-cwd');
    expect(panelState()).toBe('failed');
    expect(panelText()).toContain('the project registry is damaged');

    await closeLists();
    await typeInto(box('fy-new-session-agent'), 'claude-auto-unpublished');
    await typeInto(box('fy-new-session-cwd'), '/work/brand-new');
    await typeInto(promptBox(), 'Start anyway');
    await create();

    expect(recorder.starts.at(0)?.request).toMatchObject({
      agent: 'claude-auto-unpublished',
      cwd: '/work/brand-new',
    });
  });

  it('says a positively empty roster and an empty folder list are empty, in their own words', async () => {
    const { props } = wire({ accounts: [], registered: [], sessions: [] });
    await show(props);

    await openList('fy-new-session-agent');
    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('publishes no accounts');

    await openList('fy-new-session-cwd');
    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('registers no projects');
  });

  it('joins the cached quota feed onto the rows and never asks a fleet usage route', async () => {
    const { props, recorder } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    expect(rowText(0)).toContain('5h 37%');
    expect(rowText(1)).toContain('quota —');
    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(recorder.requests.map(request => request.path).sort()).toEqual(['/v1/projects', '/v1/usage']);
  });

  it('reports a refused quota feed beside the rows instead of failing the roster', async () => {
    const { props } = wire({ quota: 'unreadable' });
    await show(props);

    await openList('fy-new-session-agent');
    expect(panelState()).toBe('options');
    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the usage feed is unavailable',
    );
    expect(rowText(0)).toContain('quota —');
  });

  it('offers the roster with no quota at all when this surface has no feed to join', async () => {
    const { props, recorder } = wire({ quota: 'absent' });
    await show(props);

    await openList('fy-new-session-agent');
    expect(rows()).toHaveLength(2);
    expect(rowText(0)).toContain('quota —');
    // No feed was asked for, so nothing is claimed about quota either way.
    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(recorder.requests.map(request => request.path)).toEqual(['/v1/projects']);
  });

  it('registers nothing and probes nothing while a reader fills the whole form in', async () => {
    const { props, recorder } = wire();
    await show(props);

    await openList('fy-new-session-agent');
    await pressRow(0);
    await openList('fy-new-session-cwd');
    await typeInto(box('fy-new-session-cwd'), '/work/scr');
    await pressRow(0);
    await closeLists();
    await typeInto(promptBox(), 'Everything above is a read');
    await create();

    expect(recorder.probes).toBe(0);
    expect(recorder.manifests).toBe(1);
    // One read each, and not one write: registration is a different screen's job.
    expect(recorder.requests).toEqual([
      { method: 'GET', path: '/v1/usage' },
      { method: 'GET', path: '/v1/projects' },
    ]);
    expect(recorder.starts).toHaveLength(1);
  });

  it('probes account health only from the control that says what it costs', async () => {
    const { props, recorder } = wire();
    await show(props);
    expect(recorder.probes).toBe(0);

    const check = namedButton('Check accounts');
    expect(root().textContent).toContain('starts each published account once');
    await press(check);

    expect(recorder.probes).toBe(1);
    await openList('fy-new-session-agent');
    expect(rowText(0)).toContain('healthy');
    expect(rowText(1)).toContain('unchecked');
  });

  it('never offers the previous daemon’s accounts or folders after the connection changes', async () => {
    const { props } = wire();
    const mounted = await show(props);

    await openList('fy-new-session-agent');
    expect(rowText(0)).toContain('Studio Claude');

    await mounted.render(<NewSessionPage {...props} connection={workstation} />);
    await openList('fy-new-session-agent');
    const accountRows = rows().map(row => row.textContent ?? '');
    expect(accountRows.join(' ')).not.toContain('Studio Claude');
    expect(accountRows.join(' ')).toContain('Warehouse Claude');

    await openList('fy-new-session-cwd');
    const folderRows = rows().map(row => row.textContent ?? '');
    expect(folderRows.join(' ')).not.toContain('/work/ferretry');
    expect(folderRows.join(' ')).toContain('/srv/warehouse-app');
  });

  it('keeps last-good percentages AND says the feed stopped answering', async () => {
    const { props } = wire();
    await show({
      ...props,
      usage: stubUsage({ feed: feedBody, status: 'error', error: 'the daemon stopped answering' }),
    });

    await openList('fy-new-session-agent');
    // Both facts at once: a failed refresh must not silently pass off old
    // percentages as current ones, and must not hide them either.
    expect(rowText(0)).toContain('5h 37%');
    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the daemon stopped answering',
    );
  });

  it('still says something when a quota read fails without a sentence', async () => {
    const { props } = wire();
    await show({ ...props, usage: stubUsage({ feed: null, status: 'error', error: null }) });

    await openList('fy-new-session-agent');
    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the cached quota feed could not be read',
    );
  });

  it('claims nothing about quota while the feed is still being read', async () => {
    const { props } = wire();
    await show({ ...props, usage: stubUsage({ feed: null, status: 'loading', error: null }) });

    await openList('fy-new-session-agent');
    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(rowText(0)).toContain('quota —');
  });

  it('drops model suggestions on a daemon switch even when the wrapper name matches on both hosts', async () => {
    const { props } = wire();
    const mounted = await show(props);

    await openList('fy-new-session-agent');
    await pressRow(0);
    expect(box('fy-new-session-agent').value).toBe('claude-auto-studio');
    expect(root().querySelector('#fy-new-session-model-options')).not.toBeNull();

    await mounted.render(<NewSessionPage {...props} connection={workstation} />);

    // The workstation publishes its own `claude-auto-studio`, so the TEXT still
    // matches a real row — and the choice was made on a host the reader has left,
    // so it is no longer evidence about anything on screen.
    expect(box('fy-new-session-agent').value).toBe('claude-auto-studio');
    expect(root().querySelector('#fy-new-session-model-options')).toBeNull();
    expect(box('fy-new-session-model').hasAttribute('list')).toBeFalse();

    // Choosing again on THIS daemon suggests this daemon's models, not the other's.
    // The typed text is also the query, so the workstation's own row is the match.
    // Choosing dismissed the list, so the caret leaves and comes back — which is
    // what a reader does too.
    await closeLists();
    await openList('fy-new-session-agent');
    expect(rowText(0)).toContain('Warehouse Studio');
    await pressRow(0);
    expect(
      [...root().querySelectorAll('#fy-new-session-model-options option')].map(option => option.getAttribute('value')),
    ).toEqual(['claude-sonnet-5']);
  });

  it('drops model suggestions when the same daemon id is re-paired', async () => {
    const { props } = wire();
    const mounted = await show(props);

    await openList('fy-new-session-agent');
    await pressRow(0);
    expect(root().querySelector('#fy-new-session-model-options')).not.toBeNull();

    // Same id, same address, a new grant: everything this browser proved about
    // the last pairing expired with it, including which account it chose.
    await mounted.render(
      <NewSessionPage
        {...props}
        connection={daemonConnection({
          daemonId: connection.daemonId,
          baseUrl: connection.baseUrl,
          deviceToken: 'device-token-2',
        })}
      />,
    );

    expect(box('fy-new-session-agent').value).toBe('claude-auto-studio');
    expect(root().querySelector('#fy-new-session-model-options')).toBeNull();
  });
});
