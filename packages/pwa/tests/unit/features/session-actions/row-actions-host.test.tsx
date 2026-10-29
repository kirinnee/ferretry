import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DAEMON_CAPABILITIES, type GrantsView, type SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  SessionRowActionsHost,
  sessionRowMenuRenderer,
} from '../../../../src/features/session-actions/row-actions-host.tsx';
import { DaemonAccountPickerStore } from '../../../../src/lib/account-picker-store.ts';
import { DaemonConnectionStore } from '../../../../src/lib/connections.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../../../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../../../src/lib/projects-store.ts';
import { type AppStore, StoreProvider } from '../../../../src/lib/store.tsx';
import type { SessionMenuState } from '../../../../src/shell/session-menu-context.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const ALPHA = `fy_daemon_${'a'.repeat(43)}`;
const BETA = `fy_daemon_${'b'.repeat(43)}`;
const alpha: DaemonConnection = daemonConnection({
  daemonId: ALPHA,
  baseUrl: 'https://alpha.example.test',
  deviceId: 'token-a',
});

const RUNNING: SessionView = sessionView('s-run', { config: { teammate: 'hadi', name: 'Fix it', agent: 'nero' } });
const STOPPED: SessionView = sessionView('s-end', {
  config: { teammate: 'ora', name: 'Done', agent: 'nero' },
  state: { status: 'completed' },
});

let mounted: Mounted | undefined;
let clipboard: string[] = [];
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
});

const PREVIEW = {
  kind: 'ready',
  targetAgent: 'codex-a',
  targetModel: 'gpt-5.5',
  summary: {
    converter: 1,
    sourceHarness: 'claude',
    targetHarness: 'codex',
    targetVersion: '0.163.0',
    turns: 4,
    keptTurns: 4,
    omittedTurns: 0,
    cutNewest: false,
    messages: 8,
    nativeToolCalls: 0,
    toolCallsAsText: 0,
    attachments: 0,
    dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
    estimatedTokens: 10,
    budgetTokens: 100,
  },
};

const grants = (warden: boolean): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => ({
    capability,
    use: capability !== 'warden' || warden,
    configure: false,
    granted: { use: true, configure: false },
    mayGrant: false,
    useRefusal: capability !== 'warden' || warden ? 'granted' : 'not-granted',
    configureRefusal: 'not-granted',
    origin: 'default',
  })),
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

interface Calls {
  readonly stop: string[];
  readonly resume: string[];
  readonly migrate: unknown[][];
  readonly rename: unknown[][];
  readonly fork: unknown[][];
  readonly fetches: string[];
}

const setup = (
  options: {
    warden?: boolean;
    known?: boolean;
    pausedRestart?: boolean;
    convertible?: boolean;
    moveRefusal?: boolean;
  } = {},
) => {
  const calls: Calls = { stop: [], resume: [], migrate: [], rename: [], fork: [], fetches: [] };
  const record = { ...alpha, pairedAt: 1, lastSelectedAt: 1 };
  const client = {
    request: async () => grants(options.warden ?? false),
    stop: async (id: string) => {
      calls.stop.push(id);
      return sessionView(id, { config: { teammate: 'hadi' }, state: { status: 'completed' } });
    },
    resume: async (id: string) => {
      calls.resume.push(id);
      return sessionView(id, { config: { teammate: 'ora' } });
    },
    migrate: async (...args: unknown[]) => {
      calls.migrate.push(args);
      if (options.moveRefusal === true && args[6] === 'convert')
        throw new FyHttpError('Codex rejected the converted file.', 409, 'conversation_unresumable');
      if (options.pausedRestart === true && args[5] !== true)
        throw new FyHttpError('refused', 409, 'migration_refused', {
          error: 'refused',
          code: 'migration_refused',
          inflight: {
            status: 'running',
            turn: 2,
            blockedBy: 'unknown',
            restartsWithCli: 1,
            items: [
              {
                kind: 'process',
                verdict: 'unknown',
                title: 'A program Ferretry doesn’t recognise is running',
                detail: 'fy-helper --watch',
                blocks: true,
              },
            ],
          },
        });
      return RUNNING;
    },
    rename: async (...args: unknown[]) => {
      calls.rename.push(args);
      return sessionView('s-run', { config: { teammate: 'hadi', name: 'Renamed' } });
    },
    messages: async () => ({
      messages: [{ point: { v: 1, byteOffset: 4 }, selectionBinding: 'b' }],
      nextCursor: null,
    }),
    fork: async (...args: unknown[]) => {
      calls.fork.push(args);
      return { session: { id: 'forked-1' } };
    },
  };
  const fleet = new DaemonFleetStore({ list: async () => [RUNNING, STOPPED], get: async () => RUNNING });
  const store = {
    connections: new DaemonConnectionStore({
      connections: options.known === false ? [] : [record],
      selectedDaemonId: null,
    }),
    clients: { client: async () => client },
    fleet,
    projects: new DaemonProjectsStore({ projects: async () => [] }),
    accountPicker: new DaemonAccountPickerStore({
      catalog: async () => ({
        accounts:
          options.convertible === true
            ? [
                {
                  id: 'codex-a',
                  wrapper: 'codex-a',
                  displayName: 'Codex A',
                  kind: 'codex',
                  agent: true,
                  credentialId: 'login-a',
                  defaultModel: null,
                  models: [],
                  available: true,
                  unavailableReason: null,
                },
              ]
            : [],
      }),
      health: async () => ({ credentials: [] }) as never,
      probe: async () => ({ credentials: [] }) as never,
    } as never),
    carrier: {
      fetch: async (input: string | URL | Request) => {
        calls.fetches.push(String(input));
        if (String(input).endsWith('/conversion-preview')) return Response.json(PREVIEW);
        return Response.json({ passive: [], sessions: [] }, { status: 200 });
      },
    },
  } as unknown as AppStore;
  void fleet.hydrate(alpha);
  return { calls, store };
};

interface Seen {
  readonly closes: boolean[];
  readonly navigations: string[];
}

const show = async (
  options: {
    view?: SessionView;
    open?: boolean;
    touch?: boolean;
    daemonId?: string;
    warden?: boolean;
    known?: boolean;
    pausedRestart?: boolean;
    convertible?: boolean;
    moveRefusal?: boolean;
  } = {},
) => {
  const { calls, store } = setup(options);
  const seen: Seen = { closes: [], navigations: [] };
  mounted = await mount(
    <StoreProvider store={store}>
      <SessionRowActionsHost
        anchor={{ x: 100, y: 100 }}
        daemonId={(options.daemonId ?? ALPHA) as DaemonId}
        onClose={restore => seen.closes.push(restore)}
        onNavigate={to => seen.navigations.push(to)}
        open={options.open ?? true}
        touch={options.touch ?? false}
        view={options.view ?? RUNNING}
      />
    </StoreProvider>,
  );
  await settle();
  return { calls, seen, store, root: mounted.container };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const item = (root: HTMLElement, id: string): HTMLElement =>
  must(root.querySelector(`[data-session-action-item="${id}"]`), `row ${id}`);
const ids = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-session-action-item]')].map(
    node => node.getAttribute('data-session-action-item') ?? '',
  );
const choose = async (root: HTMLElement, id: string): Promise<void> => {
  await interact(() => item(root, id).click());
  await settle();
};
const confirmYes = async (root: HTMLElement): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>('[data-menu-confirm-yes]'), 'yes').click());
  await settle();
};
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the sessions bar row actions', () => {
  it('offers exactly the header’s Actions for a running ferret, plus Open and Copy session name', async () => {
    const { root } = await show();
    expect(must(root.querySelector('[role="menu"]'), 'menu').getAttribute('aria-label')).toBe('Hadi actions');
    expect(ids(root)).toEqual([
      'open',
      'rename',
      'fork',
      'copy-id',
      'copy-name',
      'move-login',
      'move-machine',
      'hypermedia',
      'pack',
      'agenda',
      'passive-learning',
      'scan-ferret',
      'restart',
      'earlier-conversation',
      'stop',
    ]);
    expect(item(root, 'move-machine').getAttribute('aria-disabled')).toBe('true');
  });

  it('offers Resume instead of Restart and Stop for a stopped ferret', async () => {
    const { root } = await show({ view: STOPPED });
    expect(ids(root)).toContain('resume');
    expect(ids(root)).not.toContain('stop');
    expect(ids(root)).not.toContain('restart');
  });

  it('offers the Warden only where this machine’s grants open it', async () => {
    expect(ids((await show({ warden: false })).root)).not.toContain('ask-warden');
    await mounted?.unmount();
    expect(ids((await show({ warden: true })).root).some(id => id.includes('warden'))).toBe(true);
  });

  it('draws nothing for a machine this browser is not paired with', async () => {
    const { root } = await show({ known: false });
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps its dialogs and status lines when the menu itself is not open', async () => {
    const { root } = await show({ open: false });
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(root.querySelector('[data-action-toast]')).not.toBeNull();
  });

  it('opens the ferret on its own machine, closing with focus handed back', async () => {
    const { root, seen } = await show();
    await choose(root, 'open');
    expect(seen.navigations).toEqual([`/d/${ALPHA}/session/s-run`]);
    expect(seen.closes).toEqual([true]);
  });

  it('copies the session id and the session name, and says when the browser has no clipboard', async () => {
    const { root } = await show();
    await choose(root, 'copy-id');
    expect(clipboard).toEqual(['s-run']);
    await mounted?.unmount();
    const again = await show();
    await choose(again.root, 'copy-name');
    expect(clipboard).toEqual(['s-run', 'Hadi']);
    await mounted?.unmount();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const none = await show();
    await choose(none.root, 'copy-id');
    expect(must(none.root.querySelector('[data-action-toast] p'), 'toast').textContent).toContain(
      'could not copy the session id: this browser offers no clipboard here',
    );
  });

  it('stops a ferret only after the question inside the menu is answered, and publishes what came back', async () => {
    const { root, calls, store } = await show();
    await choose(root, 'stop');
    expect(calls.stop).toEqual([]);
    await confirmYes(root);
    expect(calls.stop).toEqual(['s-run']);
    expect(
      store.fleet
        .getSnapshot()
        .daemons.get(ALPHA as DaemonId)
        ?.byId.get('s-run')?.state.status,
    ).toBe('completed');
  });

  it('goes back to the earlier conversation through a same-login migration that asks for it', async () => {
    const { root, calls } = await show();
    await choose(root, 'earlier-conversation');
    await confirmYes(root);
    expect(calls.migrate).toHaveLength(1);
    expect(calls.migrate[0]?.[0]).toBe('s-run');
    expect(calls.migrate[0]?.[6]).toBe('previous');
  });

  it('offers Move to Codex… only where the machine has a Codex account, and moves with conversation convert', async () => {
    expect(ids((await show()).root)).not.toContain('move-harness');
    await mounted?.unmount();
    const { root, calls, store } = await show({ convertible: true });
    expect(ids(root)).toContain('move-harness');
    expect(ids(root).indexOf('move-harness')).toBe(ids(root).indexOf('move-login') + 1);
    expect(item(root, 'move-harness').textContent).toContain('Move to Codex…');
    await choose(root, 'move-harness');
    expect(calls.fetches.some(url => url.endsWith('/v1/sessions/s-run/conversion-preview'))).toBe(true);
    const sheet = must(document.body.querySelector<HTMLElement>('[data-convert-preview]'), 'preview');
    expect(sheet.textContent).toContain('All 4 turns will move.');
    await interact(() => must(document.body.querySelector<HTMLElement>('[data-convert-confirm]'), 'confirm').click());
    await settle();
    expect(calls.migrate).toHaveLength(1);
    expect(calls.migrate[0]?.slice(0, 2)).toEqual(['s-run', 'codex-a']);
    expect(calls.migrate[0]?.[6]).toBe('convert');
    expect(must(root.querySelector('[data-action-toast] p'), 'toast').textContent).toBe('Moved to Codex (Codex A).');
    expect(
      store.fleet
        .getSnapshot()
        .daemons.get(ALPHA as DaemonId)
        ?.byId.get('s-run'),
    ).toBeDefined();
  });

  it('shows a refused move inside the sheet and leaves it open', async () => {
    const { root } = await show({ convertible: true, moveRefusal: true });
    await choose(root, 'move-harness');
    await interact(() => must(document.body.querySelector<HTMLElement>('[data-convert-confirm]'), 'confirm').click());
    await settle();
    expect(must(document.body.querySelector('[data-convert-failure]'), 'failure').textContent).toContain(
      'Codex rejected the converted file.',
    );
  });

  it('restarts the CLI through a same-login migration', async () => {
    const { root, calls } = await show();
    await choose(root, 'restart');
    await confirmYes(root);
    expect(calls.migrate).toHaveLength(1);
    expect(calls.migrate[0]?.[0]).toBe('s-run');
    expect(calls.migrate[0]?.[1]).toBe('nero');
  });

  it('holds a restart the daemon pauses for a confirm, and Restart anyway forces it under a fresh id', async () => {
    const { root, calls, seen } = await show({ pausedRestart: true });
    await choose(root, 'restart');
    await confirmYes(root);
    expect(root.textContent).toContain('Restart paused');
    expect(root.querySelector('[data-action-toast] p')?.textContent ?? '').not.toContain('failed');
    expect(calls.migrate).toHaveLength(1);
    await interact(() => must(root.querySelector<HTMLElement>('[data-restart-refusal-anyway]'), 'anyway').click());
    await settle();
    expect(calls.migrate).toHaveLength(2);
    expect(calls.migrate[1]?.[5]).toBe(true);
    expect(calls.migrate[1]?.[4]).not.toBe(calls.migrate[0]?.[4]);
    expect(root.querySelector('[data-restart-refusal]')).toBeNull();
    expect(seen.closes.length).toBeGreaterThan(0);
  });

  it('resumes a stopped ferret', async () => {
    const { root, calls } = await show({ view: STOPPED });
    await choose(root, 'resume');
    expect(calls.resume).toEqual(['s-end']);
  });

  it('says a failed action in a toast', async () => {
    const { root, store } = await show();
    (store.clients as unknown as { client: () => Promise<unknown> }).client = async () => {
      throw new Error('the machine did not answer');
    };
    await choose(root, 'stop');
    await confirmYes(root);
    expect(must(root.querySelector('[data-action-toast] p'), 'toast').textContent).toContain(
      'Stop ferret failed: the machine did not answer',
    );
  });

  it('renames in a form at the press and publishes the new name', async () => {
    const { root, calls, seen } = await show();
    await choose(root, 'rename');
    const fields = [...root.querySelectorAll<HTMLInputElement>('.fy-action-form__field input')];
    await type(must(fields[1], 'title field'), 'Renamed');
    await interact(() => must(root.querySelector('form'), 'form').requestSubmit());
    await settle();
    expect(calls.rename).toHaveLength(1);
    expect(calls.rename[0]?.[0]).toBe('s-run');
    expect(seen.closes).toContain(true);
  });

  it('forks through the latest message and opens the fork', async () => {
    const { root, calls, seen } = await show();
    await choose(root, 'fork');
    await interact(() => must(root.querySelector('form'), 'form').requestSubmit());
    await settle();
    expect(calls.fork).toHaveLength(1);
    expect(seen.navigations).toEqual([`/d/${ALPHA}/session/forked-1`]);
  });

  it('opens the move-login sheet for this ferret and keeps it when the menu closes', async () => {
    const { root } = await show();
    await choose(root, 'move-login');
    expect(document.body.textContent).toContain('Change model or account');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('flips a toggle through the machine’s own routes', async () => {
    const { root, calls } = await show();
    await choose(root, 'hypermedia');
    await choose(root, 'pack');
    await choose(root, 'agenda');
    expect(calls.fetches.some(url => url.startsWith('https://alpha.example.test'))).toBe(true);
  });

  it('reaches the Learning hub from a scan’s own link', async () => {
    const { root } = await show();
    await choose(root, 'scan-ferret');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('is a bottom sheet for a touch press', async () => {
    const { root } = await show({ touch: true });
    expect(must(root.querySelector('[role="menu"]'), 'menu').hasAttribute('data-compact')).toBe(true);
    await interact(() => pressKey(document, 'Escape'));
  });
});

describe('sessionRowMenuRenderer', () => {
  it('draws this host, keyed by machine and ferret, from the bar’s menu state', () => {
    const menu: SessionMenuState = {
      view: RUNNING,
      daemonId: BETA as DaemonId,
      x: 4,
      y: 8,
      trigger: document.createElement('a'),
      touch: false,
      open: true,
    };
    const element = sessionRowMenuRenderer(() => undefined)(menu, () => undefined) as { key: string; props: unknown };
    expect(element.key).toBe(`${BETA}:s-run`);
    expect(element.props).toMatchObject({ anchor: { x: 4, y: 8 }, daemonId: BETA, open: true, touch: false });
  });
});
