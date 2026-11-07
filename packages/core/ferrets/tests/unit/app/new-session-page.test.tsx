import { afterEach, describe, expect, it } from 'bun:test';
import { IMPORT_NAMES, importedRuntimeName } from '@ferretry/fleet';
import type { SessionView, StartSessionRequest, UsageFeedView } from '@ferretry/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { pickerHealth } from './picker-support.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'device-token',
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
    // The example is a runtime a first run really makes — the import's own naming, not a guess.
    expect(input(view, 'fy-new-session-agent').props.placeholder).toBe(
      `e.g. ${importedRuntimeName('claude', IMPORT_NAMES.defaultProfile)}`,
    );
    expect(input(view, 'fy-new-session-cwd').props.placeholder).toBe('Full path, e.g. /home/you/my-project');
    expect(input(view, 'fy-new-session-prompt').props.placeholder).toBe('Describe what you want the agent to do…');
    expect(button(view, 'Create session').props.disabled).toBeTrue();

    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port the page');

    expect(button(view, 'Create session').props.disabled).toBeFalse();
  });

  it('starts in fast mode only when the switch was pressed, and says what it costs on the form', async () => {
    const { view, starts } = page();
    const fast = (): ReactTestInstance => view.root.findByProps({ 'data-fast-switch': 'off' });
    expect(JSON.stringify(view.toJSON())).toContain('Fast mode can cost more.');
    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port the page');

    run(() => fast().props.onClick());
    expect(view.root.findByProps({ 'data-fast-switch': 'on' }).props['aria-pressed']).toBeTrue();
    await runAsync(() => button(view, 'Create session').props.onClick());
    expect(starts[0]?.request).toMatchObject({ fast: true });

    const untouched = page();
    change(untouched.view, 'fy-new-session-agent', 'claude-auto-loge');
    change(untouched.view, 'fy-new-session-prompt', 'Port the page');
    await runAsync(() => button(untouched.view, 'Create session').props.onClick());
    expect(untouched.starts[0]?.request).not.toHaveProperty('fast');
  });

  it('starts with Remote Control off, and sends it only when the Advanced options box was ticked', async () => {
    const { view, starts } = page();
    const box = (): ReactTestInstance => view.root.findByProps({ id: 'fy-new-session-remote-control' });
    expect(box().props.checked).toBeFalse();
    expect(box().props.disabled).toBeFalse();
    change(view, 'fy-new-session-agent', 'claude-auto-loge');
    change(view, 'fy-new-session-prompt', 'Port the page');
    await runAsync(() => button(view, 'Create session').props.onClick());
    expect(starts[0]?.request).not.toHaveProperty('remoteControl');

    const ticked = page();
    change(ticked.view, 'fy-new-session-agent', 'claude-auto-loge');
    change(ticked.view, 'fy-new-session-prompt', 'Port the page');
    run(() => ticked.view.root.findByProps({ id: 'fy-new-session-remote-control' }).props.onChange());
    expect(ticked.view.root.findByProps({ id: 'fy-new-session-remote-control' }).props.checked).toBeTrue();
    await runAsync(() => button(ticked.view, 'Create session').props.onClick());
    expect(ticked.starts[0]?.request).toMatchObject({ remoteControl: true });
  });

  it('speaks the product, not the tool it replaced, and says what each mode means', () => {
    const { view } = page();
    const text = JSON.stringify(view.toJSON());

    // The old internal tool's name, and its word for an agent, were on screen.
    expect(text).not.toMatch(/kteam|teammate|TUI/u);
    expect(input(view, 'fy-new-session-label').props.placeholder).toBe('e.g. website-redesign');
    expect(text).toContain('what you want the agent to do');
    expect(view.root.findByProps({ 'data-new-session-mode-meaning': '' }).findAllByType('dt')).toHaveLength(2);
    expect(text).toContain('the agent works through your request on its own');
    expect(text).toContain('opens a live terminal you type into, like a chat');
  });

  it('names no model in the override box when no account has been chosen', () => {
    const { view } = page();
    // It used to be a fixed `e.g. gpt-5.6-sol`, a Codex model, over any account.
    expect(input(view, 'fy-new-session-model').props.placeholder).toBe('');
  });

  it('says why Create is unavailable, and wears the outline look until it is not', () => {
    const { view } = page();
    const reason = (): string => view.root.findByProps({ id: 'fy-new-session-create-blocker' }).children.join('');

    expect(reason()).toBe('Choose a runtime first.');
    expect(button(view, 'Create session').props['data-variant']).toBeUndefined();
    expect(button(view, 'Create session').props['aria-describedby']).toBe('fy-new-session-create-blocker');

    change(view, 'fy-new-session-agent', 'claude-auto-default');
    expect(reason()).toBe('Say what you want the agent to do first.');

    change(view, 'fy-new-session-prompt', 'Tidy the README');
    expect(view.root.findAllByProps({ id: 'fy-new-session-create-blocker' })).toHaveLength(0);
    expect(button(view, 'Create session').props['data-variant']).toBe('primary');
    expect(button(view, 'Create session').props['aria-describedby']).toBeUndefined();
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

  it('returns to the current daemon home for both back and cancel', () => {
    const { navigated, view } = page();

    run(() => button(view, '← Home').props.onClick());
    run(() => button(view, 'Cancel').props.onClick());

    expect(navigated).toEqual(['/d/daemon%2Fa', '/d/daemon%2Fa']);
  });

  it('sends the back button through onBack when the host gives one, and Cancel through onNavigate', () => {
    // Arrange
    const backed: string[] = [];
    const { navigated, view } = page({ onBack: path => backed.push(path) });

    // Act
    run(() => button(view, '← Home').props.onClick());
    run(() => button(view, 'Cancel').props.onClick());

    // Assert
    expect(backed).toEqual(['/d/daemon%2Fa']);
    expect(navigated).toEqual(['/d/daemon%2Fa']);
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
// fake PORTS, so what a test proves about traffic -- one manifest read, one FREE
// stored-health read, no COLLECTING check and no project registration -- is a claim
// about the wiring rather than about a stub that agreed with it.

const workstation = daemonConnection({
  daemonId: 'daemon/b',
  baseUrl: 'https://workstation.example.test',
  deviceId: 'token-workstation',
});

const studio: PickerAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'claude',
  agent: true,
  credentialId: 'login-claude-auto-studio',
  wrapper: 'claude-auto-studio',
  displayName: 'Studio Claude',
  defaultModel: 'claude-opus-5',
  models: [
    { id: 'claude-opus-5', available: true },
    { id: 'claude-haiku-4-5', available: false },
  ],
  available: true,
  unavailableReason: null,
};

const atelier: PickerAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'codex',
  agent: true,
  credentialId: 'login-codex-auto-atelier',
  wrapper: 'codex-auto-atelier',
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
  agent: true,
  credentialId: 'login-claude-auto-warehouse',
  wrapper: 'claude-auto-warehouse',
  displayName: 'Warehouse Claude',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5', available: true }],
  available: true,
  unavailableReason: null,
};

/**
 * The fleet's terminal account: the one a person runs by hand. Published with
 * `mode: 'interactive'`, and the daemon refuses to run a session on it.
 */
const terminal: PickerAccount = {
  id: '77777777-7777-4777-8777-777777777777',
  kind: 'claude',
  agent: false,
  credentialId: 'login-claude-default',
  wrapper: 'claude-default',
  displayName: 'Claude (default)',
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
  agent: true,
  credentialId: 'login-claude-auto-studio',
  wrapper: 'claude-auto-studio',
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
  /** `pending` never answers; `degrades` answers once and then refuses, so a refresh fails over good rows. */
  readonly accounts?: ReadOutcome<readonly PickerAccount[]> | 'pending' | 'degrades';
  /** Hands the roster one stored verdict, for `studio`'s login. */
  readonly health?: 'ready';
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
  /** Collecting calls -- the button. A page load reaching this is the regression. */
  probes: number;
  /** Stored-snapshot reads. Free, and the page hydrates one on mount. */
  snapshots: number;
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
  const recorder: Recorder = { requests: [], starts: [], navigated: [], probes: 0, snapshots: 0, manifests: 0 };

  const accountsPort: DaemonAccountPickerPort = {
    catalog: async daemon => {
      recorder.manifests += 1;
      const outcome = options.accounts ?? rosters[daemon.daemonId] ?? [];
      if (outcome === 'pending') return await new Promise<never>(() => undefined);
      if (outcome === 'unreadable' || (outcome === 'degrades' && recorder.manifests > 1)) {
        throw new Error('this daemon refused its account manifest');
      }
      return { accounts: outcome === 'degrades' ? [studio, atelier] : outcome };
    },
    // The stored snapshot: free, and the page hydrates it. Answering empty keeps every row
    // never-checked until the control below is pressed, so the two are told apart by what is on screen.
    health: async () => {
      recorder.snapshots += 1;
      return {
        health:
          options.health === 'ready'
            ? new Map([[studio.credentialId, pickerHealth(studio.credentialId, 'ready')]])
            : new Map(),
        error: null,
      };
    },
    // The collecting call. `recorder.probes` counts THIS, so a page load reaching it fails a test.
    checkHealth: async () => {
      recorder.probes += 1;
      return {
        health: new Map([
          [
            studio.credentialId,
            pickerHealth(studio.credentialId, 'ready', { lastCheckedAt: new Date(5).toISOString() }),
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

const NO_ACCOUNTS_SENTENCE =
  'No runtime on this machine can run sessions yet. Add an agent runtime in Settings › Machines.';

const noAccountsText = (): string =>
  must(root().querySelector('[data-new-session-no-accounts] p'), 'the no-accounts sentence').textContent ?? '';

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

/** Every runtime button, in document order, across both harness groups. */
const radios = (): readonly HTMLInputElement[] => [
  ...root().querySelectorAll<HTMLInputElement>('input[name="fy-new-session-runtime"]'),
];

const radio = (wrapper: string): HTMLInputElement =>
  must(
    radios().find(candidate => candidate.value === wrapper),
    `a runtime button for ${wrapper}`,
  );

/** The one wrapper selected across BOTH groups, or `null` when none is. */
const checkedWrapper = (): string | null => radios().find(candidate => candidate.checked)?.value ?? null;

const chip = (wrapper: string): HTMLElement =>
  must(root().querySelector<HTMLElement>(`[data-runtime-option="${wrapper}"]`), `the chip for ${wrapper}`);

const chipText = (wrapper: string): string => chip(wrapper).textContent ?? '';

/** Taps a runtime button, as a reader does. */
const chooseRuntime = (wrapper: string): Promise<void> => interact(() => radio(wrapper).click());

/** The harness groups as drawn: their title, and the wrappers under each. */
const groups = (): readonly { readonly kind: string | null; readonly title: string; readonly wrappers: string[] }[] =>
  [...root().querySelectorAll('[data-runtime-group]')].map(group => ({
    kind: group.getAttribute('data-runtime-group'),
    title: group.querySelector('legend')?.textContent ?? '',
    wrappers: [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value),
  }));

const modelOptions = (): readonly (string | null)[] =>
  [...root().querySelectorAll('#fy-new-session-model-options option')].map(option => option.getAttribute('value'));

/** Presses Create and lets the start promise and the navigation settle. */
const create = async (): Promise<void> => {
  await press(namedButton('Create session'));
  await interact(async () => {
    await Promise.resolve();
  });
};

describe('NewSessionPage with the daemon pickers', () => {
  it('starts the session a chosen runtime and a chosen registered project describe', async () => {
    const { props, recorder } = wire();
    await show(props);

    // The machine's first usable runtime is already chosen; a tap moves the answer.
    expect(checkedWrapper()).toBe('claude-auto-studio');
    await chooseRuntime('codex-auto-atelier');
    expect(checkedWrapper()).toBe('codex-auto-atelier');

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
          agent: 'codex-auto-atelier',
          cwd: '/work/ferretry',
          mode: 'auto',
          prompt: 'Wire the pickers',
        },
      },
    ]);
    expect(recorder.navigated).toEqual(['/d/daemon%2Fa/session/new%2Fsession']);
  });

  it('draws one radio group named Runtime, split Claude then Codex, with a single choice across both', async () => {
    // The roster lists Codex first; the groups do not follow it.
    const { props } = wire({ accounts: [atelier, studio] });
    await show(props);

    expect(groups()).toEqual([
      { kind: 'claude', title: 'Claude', wrappers: ['claude-auto-studio'] },
      { kind: 'codex', title: 'Codex', wrappers: ['codex-auto-atelier'] },
    ]);
    const group = must(root().querySelector('[role="radiogroup"]'), 'the radio group');
    const labelId = must(group.getAttribute('aria-labelledby'), 'its label');
    expect(root().querySelector(`#${labelId}`)?.textContent).toBe('Runtime');
    // One shared name is what makes the browser keep a single choice and walk arrows across both groups.
    expect(new Set(radios().map(candidate => candidate.name)).size).toBe(1);
    // The daemon's own order decides the first usable runtime, not the group order.
    expect(checkedWrapper()).toBe('codex-auto-atelier');

    await chooseRuntime('claude-auto-studio');
    expect(radios().filter(candidate => candidate.checked)).toHaveLength(1);
    expect(radio('codex-auto-atelier').checked).toBeFalse();
    await chooseRuntime('codex-auto-atelier');
    expect(checkedWrapper()).toBe('codex-auto-atelier');
  });

  it('draws no group for a harness with nothing to run, and never a typed box beside the buttons', async () => {
    const { props } = wire({ accounts: [studio, warehouse] });
    await show(props);

    expect(groups().map(group => group.title)).toEqual(['Claude']);
    expect(groups()[0]?.wrappers).toEqual(['claude-auto-studio', 'claude-auto-warehouse']);
    expect(root().querySelector('#fy-new-session-agent')).toBeNull();
  });

  it('names each runtime and what it runs on, and the wrapper only when the name differs', async () => {
    const glm: PickerAccount = {
      ...warehouse,
      defaultModel: 'glm-5.3',
      modelCatalog: { id: 'zai', label: 'GLM / Z.ai', customIds: false },
    };
    const bare: PickerAccount = { ...atelier, wrapper: 'codex-bare', displayName: 'codex-bare', defaultModel: null };
    const { props } = wire({ accounts: [studio, glm, bare], quota: 'absent' });
    await show(props);

    expect(chipText('claude-auto-studio')).toBe('Studio Claudeclaude-auto-studio · claude-opus-5');
    expect(chipText('claude-auto-warehouse')).toBe('Warehouse Claudeclaude-auto-warehouse · GLM / Z.ai · glm-5.3');
    // The name IS the wrapper, so it is not printed twice, and no model is claimed.
    expect(chipText('codex-bare')).toBe('codex-baredefault model');
  });

  it('reads a chosen runtime’s models as SUGGESTIONS and leaves the model unset', async () => {
    const { props, recorder } = wire();
    await show(props);

    expect(modelOptions()).toEqual(['claude-opus-5']);
    expect(box('fy-new-session-model').getAttribute('list')).toBe('fy-new-session-model-options');
    // Declared unavailable by the manifest, so it is not offered.
    expect(modelOptions()).not.toContain('claude-haiku-4-5');
    // The point of the whole callback: the box the daemon reads stays empty.
    expect(box('fy-new-session-model').value).toBe('');

    await typeInto(promptBox(), 'Use whatever this runtime defaults to');
    await create();

    const request = must(recorder.starts.at(0), 'a start').request;
    expect(Object.hasOwn(request, 'model')).toBeFalse();
    expect(request.agent).toBe('claude-auto-studio');
  });

  it("lists a catalog login's models by tier in a select, and starts on the one chosen", async () => {
    const glm: PickerAccount = {
      ...studio,
      defaultModel: 'glm-5.3',
      models: [
        { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', available: true, efforts: ['low', 'high', 'max'] },
        { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', available: true, efforts: [] },
      ],
      modelCatalog: { id: 'zai', label: 'GLM / Z.ai', customIds: false },
    };
    const { props, recorder } = wire({ accounts: [glm] });
    await show(props);

    const select = must(root().querySelector<HTMLSelectElement>('select#fy-new-session-model'), 'the model select');
    expect([...select.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Most capable', 'Fast']);
    expect(root().querySelector('#fy-new-session-model-options')).toBeNull();
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'glm-5.3-flash');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await typeInto(promptBox(), 'Quick one');
    await create();

    expect(must(recorder.starts.at(0), 'a start').request.model).toBe('glm-5.3-flash');
  });

  it('disables the fast switch for a model the catalog says has none, says why, and never sends it', async () => {
    const opus: PickerAccount = {
      ...studio,
      defaultModel: 'claude-opus-5-5',
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'best', available: true, efforts: [], fast: true },
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'balanced', available: true, efforts: [], fast: false },
      ],
      modelCatalog: { id: 'anthropic', label: 'Anthropic', customIds: false },
    };
    const { props, recorder } = wire({ accounts: [opus] });
    await show(props);
    const fastSwitch = () =>
      must(root().querySelector<HTMLButtonElement>('[data-new-session-fast] button'), 'the switch');
    const chooseModel = async (id: string) => {
      const select = must(root().querySelector<HTMLSelectElement>('select#fy-new-session-model'), 'the select');
      await interact(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, id);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };

    // The account default has it: pressable, and pressed.
    expect(fastSwitch().disabled).toBeFalse();
    await interact(() => fastSwitch().click());
    expect(fastSwitch().getAttribute('aria-pressed')).toBe('true');

    // Choosing a model without it takes the switch away, with the reason, and un-presses it.
    await chooseModel('claude-sonnet-5-5');
    expect(fastSwitch().disabled).toBeTrue();
    expect(fastSwitch().getAttribute('aria-pressed')).toBe('false');
    expect(root().querySelector('#fy-new-session-fast-reason')?.textContent).toBe('Sonnet 5.5 has no fast mode.');
    await typeInto(promptBox(), 'Quick one');
    await create();

    expect(Object.hasOwn(must(recorder.starts.at(0), 'a start').request, 'fast')).toBeFalse();
  });

  it('takes the Remote Control box away from a Codex runtime, says why, and never sends it', async () => {
    const { props, recorder } = wire({ accounts: [terminal, studio, atelier] });
    await show(props);
    const remoteControl = () =>
      must(root().querySelector<HTMLInputElement>('#fy-new-session-remote-control'), 'the Remote Control box');

    expect(remoteControl().disabled).toBeFalse();
    await interact(() => remoteControl().click());
    expect(remoteControl().checked).toBeTrue();

    await chooseRuntime('codex-auto-atelier');
    expect(remoteControl().disabled).toBeTrue();
    expect(remoteControl().checked).toBeFalse();
    expect(root().querySelector('#fy-new-session-remote-control-reason')?.textContent).toBe(
      'Codex has no Remote Control.',
    );
    await typeInto(promptBox(), 'Quick one');
    await create();

    expect(Object.hasOwn(must(recorder.starts.at(0), 'a start').request, 'remoteControl')).toBeFalse();
  });

  it('moves the model suggestions and the default hint to the runtime the reader taps', async () => {
    const { props } = wire({ accounts: [terminal, studio, atelier] });
    await show(props);

    expect(box('fy-new-session-model').placeholder).toBe('default: claude-opus-5');
    expect(box('fy-new-session-model').value).toBe('');

    await chooseRuntime('codex-auto-atelier');
    expect(modelOptions()).toEqual(['gpt-5.6-terra']);
    expect(box('fy-new-session-model').placeholder).toBe('default: gpt-5.6-terra');
  });

  it('shows no default model hint for a runtime that declares none', async () => {
    const { props } = wire({ accounts: [{ ...studio, defaultModel: null }] });
    await show(props);

    expect(checkedWrapper()).toBe('claude-auto-studio');
    expect(box('fy-new-session-model').placeholder).toBe('');
  });

  it('types the runtime where the roster cannot be read, and starts from the typed text', async () => {
    const { props, recorder } = wire({ accounts: 'unreadable', registered: 'unreadable', sessions: 'unreadable' });
    await show(props);

    expect(radios()).toHaveLength(0);
    expect(must(root().querySelector('[role="alert"]'), 'the reason').textContent).toBe(
      'this daemon refused its account manifest Type a runtime name instead.',
    );
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

  it('claims nothing while the roster is still being read', async () => {
    const { props } = wire({ accounts: 'pending' });
    await show(props);

    expect(must(root().querySelector('[role="status"]'), 'the status').textContent).toBe(
      'Reading this machine’s runtimes…',
    );
    expect(radios()).toHaveLength(0);
    expect(root().querySelector('#fy-new-session-agent')).toBeNull();
    expect(namedButton('Create session').disabled).toBeTrue();
  });

  it('keeps the buttons and says they may be out of date when a later refresh fails', async () => {
    const { props } = wire({ accounts: 'degrades' });
    await show(props);
    expect(radios()).toHaveLength(2);

    await interact(async () => {
      await props.accounts?.refresh(props.connection).catch(() => undefined);
    });

    expect(radios()).toHaveLength(2);
    expect(checkedWrapper()).toBe('claude-auto-studio');
    const notices = [...root().querySelectorAll('[role="status"]')].map(notice => notice.textContent);
    expect(notices).toContain('this daemon refused its account manifest The runtimes shown may be out of date.');
  });

  it('says a positively empty roster and an empty folder list are empty, in their own words', async () => {
    const { props, recorder } = wire({ accounts: [], registered: [], sessions: [] });
    await show(props);

    // No buttons: the Runtime field's place says why and where to go instead.
    expect(radios()).toHaveLength(0);
    expect(root().querySelector('#fy-new-session-agent') === null).toBeTrue();
    expect(noAccountsText()).toBe(NO_ACCOUNTS_SENTENCE);
    expect(namedButton('Create a runtime').getAttribute('data-variant')).toBe('primary');
    await press(namedButton('Create a runtime'));
    // No machine name was handed in, so the link names the machine the way the switcher does.
    expect(recorder.navigated).toEqual(['/d/daemon%2Fa/settings#machines/https%3A%2F%2Fdaemon.example.test/runtimes']);

    await openList('fy-new-session-cwd');
    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('registers no projects');
  });

  it('joins the cached quota feed onto the buttons and never asks a fleet usage route', async () => {
    const { props, recorder } = wire();
    await show(props);

    expect(chipText('claude-auto-studio')).toContain('5h 37%');
    expect(chipText('claude-auto-studio')).toContain('wk 61%');
    // No reading is no claim: not a percentage, and not a made-up "0%".
    expect(chipText('codex-auto-atelier')).not.toMatch(/%|quota/u);
    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(recorder.requests.map(request => request.path).sort()).toEqual(['/v1/projects', '/v1/usage']);
  });

  it('reports a refused quota feed beside the buttons instead of failing the roster', async () => {
    const { props } = wire({ quota: 'unreadable' });
    await show(props);

    expect(radios()).toHaveLength(2);
    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the usage feed is unavailable',
    );
    expect(chipText('claude-auto-studio')).not.toContain('%');
  });

  it('offers the roster with no quota at all when this surface has no feed to join', async () => {
    const { props, recorder } = wire({ quota: 'absent' });
    await show(props);

    expect(radios()).toHaveLength(2);
    expect(chipText('claude-auto-studio')).not.toContain('%');
    // No feed was asked for, so nothing is claimed about quota either way.
    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(recorder.requests.map(request => request.path)).toEqual(['/v1/projects']);
  });

  it('registers nothing and probes nothing while a reader fills the whole form in', async () => {
    const { props, recorder } = wire();
    await show(props);

    await chooseRuntime('codex-auto-atelier');
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

  /**
   * COLLECTS ONLY FROM THE CONTROL, and the control is not on this form.
   *
   * The page hydrates the free stored snapshot on mount and the property is about the COLLECTING
   * call. WHAT THIS CANNOT PROVE: it counts port calls. It cannot see a process spawn, so it is not the
   * guard against a spend regression — `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts`
   * ("what an unattended fleet pass may spend") is, because it boots a real `fyd`.
   */
  it('hydrates the stored snapshot on mount, offers no re-check here, and collects nothing', async () => {
    const { props, recorder } = wire();
    await show(props);

    expect(recorder.snapshots).toBe(1);
    expect(recorder.probes).toBe(0);
    expect(
      [...root().querySelectorAll('button')].some(button => button.textContent?.includes('Check now')),
    ).toBeFalse();
    expect(root().querySelector('[data-picker-health]')).toBeNull();
    // Nobody has checked, and the button does not pretend either way.
    expect(chipText('claude-auto-studio')).not.toMatch(/never checked|ready/iu);
    expect(recorder.probes).toBe(0);
  });

  it('renders its form from the stored snapshot without a browser, and asks nothing while doing so', () => {
    const { props, recorder } = wire();
    const markup = renderToStaticMarkup(<NewSessionPage {...props} />);
    expect(markup).toContain('fy-new-session-cwd');
    expect(recorder.probes).toBe(0);
  });

  it('renders the machine’s continue list without a browser too', () => {
    const { props } = wire();
    const markup = renderToStaticMarkup(
      <NewSessionPage
        {...props}
        continuing
        createFleetClient={async () => ({}) as never}
        resumeSession={async () => undefined}
      />,
    );
    expect(markup).toContain('data-continue-conversation');
  });

  it('prints a login’s stored verdict on its button once the host has one', async () => {
    const { props } = wire({ health: 'ready' });
    await show(props);

    expect(chipText('claude-auto-studio')).toContain('ready');
    expect(chip('claude-auto-studio').querySelector('.text-ok')?.getAttribute('title')).toContain('provider accepted');
    expect(chipText('codex-auto-atelier')).not.toContain('ready');
  });

  it('offers the known folders in the Project box with typing a path as the fallback', async () => {
    const { props } = wire();
    await show(props);

    expect(box('fy-new-session-cwd').placeholder).toBe('Choose a folder, or type its full path');
    await openList('fy-new-session-cwd');
    expect(rows()).toHaveLength(2);
  });

  it('never offers the previous daemon’s runtimes or folders after the connection changes', async () => {
    const { props } = wire();
    const mounted = await show(props);
    expect(chipText('claude-auto-studio')).toContain('Studio Claude');

    await mounted.render(<NewSessionPage {...props} connection={workstation} />);
    const text = radios()
      .map(candidate => chipText(candidate.value))
      .join(' ');
    expect(text).not.toContain('Studio Claude');
    expect(text).toContain('Warehouse Claude');

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

    // Both facts at once: a failed refresh must not silently pass off old
    // percentages as current ones, and must not hide them either.
    expect(chipText('claude-auto-studio')).toContain('5h 37%');
    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the daemon stopped answering',
    );
  });

  it('still says something when a quota read fails without a sentence', async () => {
    const { props } = wire();
    await show({ ...props, usage: stubUsage({ feed: null, status: 'error', error: null }) });

    expect(must(root().querySelector('[data-picker-advisory]'), 'the advisory').textContent).toContain(
      'the cached quota feed could not be read',
    );
  });

  it('claims nothing about quota while the feed is still being read', async () => {
    const { props } = wire();
    await show({ ...props, usage: stubUsage({ feed: null, status: 'loading', error: null }) });

    expect(root().querySelector('[data-picker-advisory]')).toBeNull();
    expect(chipText('claude-auto-studio')).not.toContain('%');
  });

  it('takes the model suggestions from THIS daemon’s runtime when the connection changes, even on a shared wrapper name', async () => {
    const { props } = wire();
    const mounted = await show(props);
    expect(checkedWrapper()).toBe('claude-auto-studio');
    expect(modelOptions()).toEqual(['claude-opus-5']);

    await mounted.render(<NewSessionPage {...props} connection={workstation} />);

    // The workstation publishes its own `claude-auto-studio`. The text still names a real button there,
    // and the suggestions are that button's — never the laptop's.
    expect(checkedWrapper()).toBe('claude-auto-studio');
    expect(chipText('claude-auto-studio')).toContain('Warehouse Studio');
    expect(modelOptions()).toEqual(['claude-sonnet-5']);
  });

  it('keeps the chosen runtime and its suggestions when the same daemon id is re-paired', async () => {
    const { props } = wire();
    const mounted = await show(props);
    expect(modelOptions()).toEqual(['claude-opus-5']);

    await mounted.render(
      <NewSessionPage
        {...props}
        connection={daemonConnection({
          daemonId: connection.daemonId,
          baseUrl: connection.baseUrl,
          deviceId: 'device-token-2',
        })}
      />,
    );

    expect(checkedWrapper()).toBe('claude-auto-studio');
    expect(modelOptions()).toEqual(['claude-opus-5']);
  });

  it('replaces a draft that names no runtime on this machine with the first usable one', async () => {
    const { props } = wire();
    const mounted = await show(props);
    expect(checkedWrapper()).toBe('claude-auto-studio');

    // Another machine's roster: nothing it offers is the wrapper the draft still holds.
    const elsewhere = wire({ accounts: [warehouse] });
    await mounted.render(<NewSessionPage {...props} accounts={elsewhere.props.accounts} />);

    expect(checkedWrapper()).toBe('claude-auto-warehouse');
  });

  it('never offers the terminal runtime, and chooses the first runtime that can run a session', async () => {
    // The default fleet's shape: the terminal runtime is published FIRST, and the daemon refuses a
    // session on it in either mode.
    const { props, recorder } = wire({ accounts: [terminal, studio, atelier] });
    await show(props);

    expect(checkedWrapper()).toBe('claude-auto-studio');
    expect(radios().map(candidate => candidate.value)).toEqual(['claude-auto-studio', 'codex-auto-atelier']);
    expect(root().textContent).not.toContain('Claude (default)');
    // The choice counts, so the model box suggests that runtime's models.
    expect(modelOptions()).toEqual(['claude-opus-5']);

    await chooseRuntime('codex-auto-atelier');
    await typeInto(promptBox(), 'Run on the codex runtime');
    await create();
    expect(recorder.starts.at(0)?.request.agent).toBe('codex-auto-atelier');
  });

  it('shows a runtime the daemon says is unavailable disabled, with its reason, and chooses past it', async () => {
    const down: PickerAccount = { ...studio, available: false, unavailableReason: 'its login needs signing in' };
    const { props } = wire({ accounts: [terminal, down, atelier] });
    await show(props);

    expect(radio('claude-auto-studio').disabled).toBeTrue();
    expect(chipText('claude-auto-studio')).toContain('its login needs signing in');
    expect(checkedWrapper()).toBe('codex-auto-atelier');
  });

  it('leaves the runtime unchosen, and says so, when every runtime is unavailable', async () => {
    const down: PickerAccount = { ...studio, available: false, unavailableReason: 'its login needs signing in' };
    const { props } = wire({ accounts: [down] });
    await show(props);

    expect(radios()).toHaveLength(1);
    expect(checkedWrapper()).toBeNull();
    expect(namedButton('Create session').disabled).toBeTrue();
    expect(must(root().querySelector('#fy-new-session-create-blocker'), 'the reason').textContent).toBe(
      'Choose a runtime first.',
    );
  });

  it('says in one sentence that no runtime can run a session when the only one is the terminal runtime', async () => {
    const { props, recorder } = wire({ accounts: [terminal] });
    await show({ ...props, machineName: 'studio-mac' });

    // Not an empty list: the buttons are replaced by the sentence and a way forward.
    expect(radios()).toHaveLength(0);
    expect(root().querySelector('#fy-new-session-agent') === null).toBeTrue();
    expect(root().querySelectorAll('[role="combobox"]')).toHaveLength(1); // the Project box only
    expect(noAccountsText()).toBe(NO_ACCOUNTS_SENTENCE);
    expect(noAccountsText()).not.toMatch(/lane|wrapper|interactive/iu);
    expect(namedButton('Create session').disabled).toBeTrue();
    // Disabled WITH a reason, and no longer drawn as a filled primary button.
    const blocker = must(root().querySelector('#fy-new-session-create-blocker'), 'the reason').textContent;
    expect(blocker).toBe('No runtime can run a session yet — add one first.');
    expect(namedButton('Create session').getAttribute('aria-describedby')).toBe('fy-new-session-create-blocker');
    expect(namedButton('Create session').hasAttribute('data-variant')).toBeFalse();

    await press(namedButton('Create a runtime'));
    // Straight to this machine's Runtimes tab, where an agent runtime is added.
    expect(recorder.navigated).toEqual(['/d/daemon%2Fa/settings#machines/studio-mac/runtimes']);
    expect(recorder.starts).toEqual([]);
  });
});

describe('NewSessionPage initialAgent', () => {
  it('chooses the runtime a Launch button named, over the first usable one', async () => {
    const { props, recorder } = wire({ accounts: [terminal, studio, atelier] });
    await show({ ...props, initialAgent: 'codex-auto-atelier' });

    expect(checkedWrapper()).toBe('codex-auto-atelier');
    // It is a hint, not a start: nothing was sent, and the model box suggests that runtime's models.
    expect(recorder.starts).toEqual([]);
    expect(modelOptions()).toEqual(['gpt-5.6-terra']);
  });

  it('does the same on a surface that has no quota feed', async () => {
    const { props } = wire({ accounts: [terminal, studio, atelier], quota: 'absent' });
    await show({ ...props, initialAgent: 'codex-auto-atelier' });

    expect(checkedWrapper()).toBe('codex-auto-atelier');
  });

  it('ignores a runtime the roster does not offer, an unavailable one, and the terminal runtime', async () => {
    const down: PickerAccount = { ...atelier, available: false };
    for (const [accounts, hint] of [
      [[terminal, studio, atelier], 'claude-auto-nobody'],
      [[terminal, studio, down], 'codex-auto-atelier'],
      [[terminal, studio, atelier], 'claude-default'],
    ] as const) {
      const { props } = wire({ accounts: [...accounts] });
      await show({ ...props, initialAgent: hint });
      expect(checkedWrapper()).toBe('claude-auto-studio');
      await live?.unmount();
      live = undefined;
    }
  });
});

describe('NewSessionPage › Continue a conversation', () => {
  it('offers no switch without a fleet client', async () => {
    await show({ connection, startSession: async () => ({ config: { id: 'x' } }), onNavigate: () => undefined });
    expect(root().querySelector('[data-segmented="new-session-kind"]')).toBeNull();
  });

  it('swaps the form for the conversation search and back, keeping the draft', async () => {
    const paths: string[] = [];
    const client = {
      request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
        paths.push(path);
        if (path.startsWith('/v1/imports/conversations'))
          return schema.parse({ conversations: [], matched: 0, skipped: 0 });
        throw new Error(`no route ${path}`);
      },
    };
    await show({
      connection,
      startSession: async () => ({ config: { id: 'x' } }),
      onNavigate: () => undefined,
      createFleetClient: async () => client as never,
    });
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(box('fy-new-session-agent'), 'claude-default');
      box('fy-new-session-agent').dispatchEvent(new Event('input', { bubbles: true }));
    });
    const kind = (id: string): HTMLElement =>
      must(root().querySelector<HTMLElement>(`[data-segmented="new-session-kind"] [data-segment="${id}"]`), id);
    expect(kind('new').getAttribute('aria-pressed')).toBe('true');
    await interact(() => kind('continue').click());
    await interact(async () => {
      for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(root().querySelector('[data-continue-conversation]')).not.toBeNull();
    expect(box('fy-new-session-agent').closest('[hidden]')).not.toBeNull();
    expect(paths.some(path => path.startsWith('/v1/imports/conversations'))).toBe(true);
    await interact(() => kind('new').click());
    expect(root().querySelector('[data-continue-conversation]')).toBeNull();
    expect(box('fy-new-session-agent').closest('[hidden]')).toBeNull();
    expect(box('fy-new-session-agent').value).toBe('claude-default');
  });

  it('lets the host own which choice is open: the switch reports it and the page shows what the host says', async () => {
    // Arrange
    const reported: boolean[] = [];
    const client = {
      request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
        if (path.startsWith('/v1/imports/conversations'))
          return schema.parse({ conversations: [], matched: 0, skipped: 0 });
        throw new Error(`no route ${path}`);
      },
    };
    const kind = (id: string): HTMLElement =>
      must(root().querySelector<HTMLElement>(`[data-segmented="new-session-kind"] [data-segment="${id}"]`), id);
    const wired = (continuing: boolean) => ({
      connection,
      startSession: async () => ({ config: { id: 'x' } }),
      onNavigate: () => undefined,
      createFleetClient: async () => client as never,
      continuing,
      onContinuingChange: (next: boolean) => reported.push(next),
    });

    // Act
    await show(wired(true));
    const opensOnContinue = root().querySelector('[data-continue-conversation]') !== null;
    await interact(() => kind('new').click());
    const stillContinue = root().querySelector('[data-continue-conversation]') !== null;

    // Assert
    expect(opensOnContinue).toBe(true);
    expect(reported).toEqual([false]);
    expect(stillContinue).toBe(true);
  });

  it('lists the machine’s stopped ferrets first, and resumes one in place through the typed client', async () => {
    const stoppedFerret = sessionView('s-stop', { config: { name: 'shop' }, state: { status: 'stopped' } });
    const { props, recorder } = wire({ sessions: [stoppedFerret, sessionView('s-live')] });
    const resumed: { readonly daemon: DaemonConnection; readonly id: string }[] = [];
    const client = {
      request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
        if (path.startsWith('/v1/imports/conversations'))
          return schema.parse({ conversations: [], matched: 0, skipped: 0 });
        throw new Error(`no route ${path}`);
      },
    };
    await show({
      ...props,
      createFleetClient: async () => client as never,
      resumeSession: async (daemon, id) => {
        resumed.push({ daemon, id });
      },
    });
    const settle = async (): Promise<void> =>
      await interact(async () => {
        for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
      });
    await interact(() =>
      must(
        root().querySelector<HTMLElement>('[data-segmented="new-session-kind"] [data-segment="continue"]'),
        'continue',
      ).click(),
    );
    await settle();
    const rows = [...root().querySelectorAll('[data-continue-session]')].map(row =>
      row.getAttribute('data-continue-session'),
    );
    expect(rows).toEqual(['s-stop']);
    await interact(() => must(root().querySelector<HTMLElement>('[data-continue-session="s-stop"]'), 'row').click());
    await interact(() =>
      must(root().querySelector<HTMLElement>('[data-continue-action="session:s-stop"]'), 'resume').click(),
    );
    await settle();
    expect(resumed).toEqual([{ daemon: connection, id: 's-stop' }]);
    expect(recorder.navigated).toEqual(['/d/daemon%2Fa/session/s-stop']);
  });
});
