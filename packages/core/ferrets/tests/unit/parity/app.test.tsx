/**
 * Ferrets' app half, parity with today's session screens, panels and sheets (docs/design/rebuild-parity.tsv, owner
 * `ferrets`; owner decision !A468: ONE test per screen or panel host per state, its title naming every row it proves).
 *
 * The half the shell builds is mounted over a scripted client and the test reads what it drew: the new-ferret screen,
 * the Actions panel and its menu, the three paused-restart panels, the move page's convert side, and Info. The views'
 * own behaviour is in the ported suites under tests/unit/app.
 *
 * Rows that are NOT here are the ones 5.0 has not built (the ferret list and its drawer, row context menu and `+ New`
 * machine menu, the Ferret limits tab, the Lineage tab, the action drawer) or that another plugin owns in 5.0 (the chat
 * page, hypermedia and session search are Conversation's): ports-pending.json names them, and the report lists each.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { RouterProvider } from '@ferretry/app/testing';
import { deviceControls, routeTable, type ScreenRef } from '@ferretry/app';
import type { PanelProps, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { type FunctionComponent, type ReactElement, Suspense } from 'react';
import app from '../../../app/index.ts';
import { chatHref } from '../../../app/features/move/chat-href.ts';
import { MovePage } from '../../../app/features/move/move-page.tsx';
import { ferretChatHref } from '../../../app/features/new-ferret/hrefs.ts';
import manifest from '../../../manifest.ts';
import { scripted } from '../app/support/client.ts';
import { interact, type Mounted, mount, must } from '../app/support/dom.ts';
import { ferretSummary } from '../app/header/support.ts';
import { ferretOf } from '../app/info/fixtures.ts';
import { chosenAccount, fakeSlot } from '../app/move/slot.tsx';
import { readyPreview, summaryOf } from '../app/move/support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (root: ParentNode, selector: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
  await settle();
};

const half = () => must(app.build?.({ manifest, client: scripted({}) as unknown as PluginClient }), 'the built half');

/** The half built over a scripted per-daemon client (the same object every view of the half reads through). */
const halfOver = (routes: Parameters<typeof scripted>[0]) =>
  must(app.build?.({ manifest, client: scripted(routes) as unknown as PluginClient }), 'the built half');

/** The screens the manifest declares, as the shell's route table sees them. */
const SCREEN_REFS: readonly ScreenRef[] = (manifest.ui?.screens ?? []).map(screen => ({
  plugin: manifest.id,
  id: screen.id,
  path: screen.path,
  label: manifest.title,
}));
const refOf = (id: string): ScreenRef =>
  must(
    SCREEN_REFS.find(ref => ref.id === id),
    `the ${id} screen`,
  );

const show = async (element: ReactElement): Promise<HTMLElement> => {
  mounted = await mount(<Suspense fallback={null}>{element}</Suspense>);
  await settle();
  return mounted.container;
};

describe('the new-ferret screen (the page a ferret is started from)', () => {
  it('S-0161 S-0348 S-0399 S-0374 the new-ferret screen is declared at /d/<daemon>/new and draws the start form', async () => {
    // S-0399 screen 'new-session' -> screen `new-ferret`; S-0348 PAGE_SLOTS NewSession -> the built half's screen.
    expect(manifest.ui?.screens?.map(screen => screen.id)).toContain('new-ferret');
    expect(typeof half().screens?.['new-ferret']).toBe('function');
    // S-0374 daemonNewSessionPath: /d/:daemonId/new, composed by the shell from the declared relative path.
    expect(refOf('new-ferret').path).toBe('new');
    const table = routeTable(SCREEN_REFS);
    expect(table.href(refOf('new-ferret'), {}, 'dm1')).toBe('/d/dm1/new');
    expect(table.parse('/d/dm1/new')).toMatchObject({ kind: 'screen', daemon: 'dm1', screen: refOf('new-ferret') });

    // S-0161 NewSessionRoute: the screen, bound to the router, draws the page for the daemon on the address.
    window.history.pushState(null, '', '/d/dm1/new');
    const Bound = must(
      halfOver({ 'GET /v1/ferrets': [] }).screens?.['new-ferret'],
      'the new-ferret screen',
    ) as FunctionComponent<ScreenProps>;
    const root = await show(
      <RouterProvider screens={SCREEN_REFS}>
        <Bound params={{}} />
      </RouterProvider>,
    );
    expect(root.querySelector('#new-ferret-heading')?.textContent).toBe('New ferret');
    expect(root.querySelector('#fy-new-ferret-runtime')).not.toBeNull();
    expect(root.querySelector('#fy-new-ferret-folder')).not.toBeNull();
    expect(root.querySelector('#fy-new-ferret-prompt')).not.toBeNull();
    const create = [...root.querySelectorAll('button')].find(button => button.textContent === 'Create ferret');
    expect(must(create, 'the Create ferret button').disabled).toBe(true);
  });
});

describe('the ferret address a start, a move and a link land on', () => {
  it('the address of one ferret is /d/<daemon>/ferrets/<id>/chat, spelled from the ferret id and encoded', () => {
    expect(ferretChatHref('dm1', 'f-1')).toBe('/d/dm1/ferrets/f-1/chat');
    expect(ferretChatHref('dm1', 'a b')).toBe('/d/dm1/ferrets/a%20b/chat');
    expect(chatHref('dm1', 'f-1')).toBe('/d/dm1/ferrets/f-1/chat');
  });
});

describe('the Actions panel on ferret.toolbar', () => {
  const open = async (ferret = ferretSummary('a1', { name: 'hadi', runtime: 'nero' })): Promise<HTMLElement> => {
    window.history.pushState(null, '', '/d/dm1');
    const Panel = must(
      halfOver({ 'GET /v1/ferrets/:ferretId': ferret }).panels?.actions,
      'the actions panel',
    ) as FunctionComponent<PanelProps>;
    const root = await show(
      <RouterProvider>
        <Panel subject="a1" />
      </RouterProvider>,
    );
    await click(root, '[data-ferret-actions-trigger]');
    return root;
  };

  it('S-0008 S-0323 an idle ferret: Actions ▾ opens its menu in Ferret, Move and Danger groups, one row per action', async () => {
    expect(manifest.ui?.panels?.map(panel => `${panel.slot}/${panel.id}`)).toContain('ferret.toolbar/actions');
    const root = await open();
    const menu = must(root.querySelector('[data-ferret-actions-menu]'), 'the menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('Hadi actions');
    expect([...menu.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([
      'Ferret',
      'Move',
      'Danger',
    ]);
    const rows = [...menu.querySelectorAll('[data-ferret-action-item]')].map(row => ({
      id: row.getAttribute('data-ferret-action-item'),
      label: row.querySelector('.fy-actions-menu__label')?.textContent,
    }));
    expect(rows).toEqual([
      { id: 'pin', label: 'Pin to top' },
      { id: 'rename', label: 'Rename…' },
      { id: 'copy-id', label: 'Copy ferret id' },
      { id: 'move-login', label: 'Move to another login…' },
      { id: 'move-harness', label: 'Move to Codex…' },
      { id: 'move-machine', label: 'Move to another machine' },
      { id: 'restart', label: 'Restart CLI' },
      { id: 'earlier-conversation', label: 'Go back to the earlier conversation…' },
      { id: 'stop', label: 'Stop ferret…' },
    ]);
    // A destructive row asks inside the menu, and the menu stays open (no modal).
    await click(menu, '[data-ferret-action-item="stop"]');
    expect(menu.textContent).toContain('Stop Hadi?');
    expect(menu.querySelector('[data-menu-confirm-yes]')?.textContent).toBe('Stop ferret');
  });
});

describe('a restart the daemon paused (Actions › Restart CLI)', () => {
  const refused = (code: string, message: string, body?: unknown) =>
    Object.assign(new Error(message), { status: 409, code, ...(body === undefined ? {} : { body }) });

  const restart = async (answer: Error): Promise<HTMLElement> => {
    window.history.pushState(null, '', '/d/dm1');
    const Panel = must(
      halfOver({
        'GET /v1/ferrets/:ferretId': ferretSummary('a1', { name: 'hadi', runtime: 'nero' }),
        'POST /v1/ferrets/:ferretId/move': answer,
      }).panels?.actions,
      'the actions panel',
    ) as FunctionComponent<PanelProps>;
    const root = await show(
      <RouterProvider>
        <Panel subject="a1" />
      </RouterProvider>,
    );
    await click(root, '[data-ferret-actions-trigger]');
    await click(root, '[data-ferret-action-item="restart"]');
    await click(root, '[data-menu-confirm-yes]');
    return root;
  };

  it('S-0203 RestartRefusalPanel: in-flight work paused the restart, so the panel lists it with Cancel and Restart anyway', async () => {
    const root = await restart(
      refused('move_refused', 'refused: raw daemon words', {
        error: 'refused',
        code: 'move_refused',
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
              age: '24h',
              blocks: true,
            },
          ],
        },
      }),
    );
    const panel = must(root.querySelector('[data-restart-refusal]'), 'the refusal panel');
    expect(panel.getAttribute('aria-label')).toBe('Restart paused');
    expect(panel.textContent).toContain(
      'Restart paused — Ferretry can’t tell if what the agent is running is safe to stop.',
    );
    expect(panel.textContent).toContain('fy-helper --watch');
    expect(panel.textContent).toContain('running 24h');
    expect(panel.textContent).toContain('1 helper process belongs to the agent and restarts with it.');
    expect(panel.querySelector('[data-restart-refusal-cancel]')?.textContent).toBe('Cancel');
    expect(panel.querySelector('[data-restart-refusal-anyway]')?.textContent).toBe('Restart anyway');
  });

  it('S-0202 RestartDowngradePanel: a smaller context window paused the restart, so the panel says the two sizes with Restart with the smaller window', async () => {
    const root = await restart(
      refused('context_downgrade_refused', 'refused: smaller window', {
        error: 'refused',
        code: 'context_downgrade_refused',
        downgrade: { model: 'opus', targetWindow: 200000, currentWindow: 1000000 },
      }),
    );
    const panel = must(root.querySelector('[data-restart-downgrade]'), 'the downgrade panel');
    expect(panel.textContent).toContain('200,000 tokens instead of 1,000,000');
    expect(panel.textContent).toContain('Nothing was restarted.');
    expect(panel.querySelector('[data-restart-refusal-cancel]')?.textContent).toBe('Cancel');
    expect(panel.querySelector('[data-restart-refusal-anyway]')?.textContent).toBe('Restart with the smaller window');
  });

  it('S-0204 RestartUnresumablePanel: a conversation that cannot be resumed paused the restart, so the panel offers Start fresh', async () => {
    const root = await restart(refused('conversation_unresumable', 'There is no recorded conversation to resume.'));
    const panel = must(root.querySelector('[data-restart-unresumable]'), 'the unresumable panel');
    expect(panel.textContent).toContain('Restart paused — the conversation can’t be resumed.');
    expect(panel.textContent).toContain('There is no recorded conversation to resume.');
    expect(panel.querySelector('[data-restart-refusal-cancel]')?.textContent).toBe('Cancel');
    expect(panel.querySelector('[data-restart-refusal-anyway]')?.textContent).toBe('Start fresh');
  });
});

describe('the move page, convert side (Actions › Move to Codex…)', () => {
  it('S-0080 ConvertSheet: Move to Codex waits for an account, then reads the preview and offers the confirm', async () => {
    const calls: string[] = [];
    mounted = await mount(
      <MovePage
        client={scripted({
          'GET /v1/ferrets/:ferretId': summaryOf({ id: 'f-1', harness: 'claude-code', runtime: 'claude-default' }),
          'POST /v1/ferrets/:ferretId/conversion-preview': () => {
            calls.push('preview');
            return { ...readyPreview };
          },
        })}
        ferret="f-1"
        initialMode="cli"
        onClose={() => undefined}
        slot={fakeSlot([chosenAccount('codex-a', 'codex', { displayName: 'Codex A' })])}
      />,
    );
    await settle();
    const root = mounted.container;
    const toggle = [...root.querySelectorAll('button')].find(button =>
      (button.textContent ?? '').includes('Move to Codex'),
    );
    expect(must(toggle, 'the Move to Codex switch').getAttribute('aria-pressed')).toBe('true');
    expect(root.textContent).toContain('Choose an account to see what will move.');
    expect(root.querySelector('[data-convert-confirm]')).toBeNull();
    expect(calls).toEqual([]);
    await click(root, '[data-account="codex-a"]');
    expect(calls).toEqual(['preview']);
    expect(root.querySelector('[data-convert-confirm]')).not.toBeNull();
  });
});

describe('Info, the ⓘ on ferret.toolbar', () => {
  it('S-0119 S-0120 S-0324 InfoPanel and InfoSection: the ⓘ opens Info with Overview and Runtime tabs and a titled section of label rows', async () => {
    expect(manifest.ui?.panels?.map(panel => `${panel.slot}/${panel.id}`)).toContain('ferret.toolbar/info');
    const Panel = must(
      halfOver({
        'GET /v1/ferrets/:ferretId': ferretOf('f1', { name: 'hadi', title: 'Fix the login bug', runtime: 'nero' }),
        'GET /v1/ferrets': [ferretOf('f1'), ferretOf('c1', { name: 'sol', parent: 'f1' })],
        'GET /v1/worktrees': { worktrees: [] },
      }).panels?.info,
      'the info panel',
    ) as FunctionComponent<PanelProps>;
    const root = await show(<Panel subject="f1" />);
    expect(root.querySelector('[data-info-panel]')).toBeNull();
    await click(root, '[data-info-toggle]');
    const panel = must(root.querySelector('[data-info-panel]'), 'the Info panel');
    expect(panel.querySelector('.fy-info__title')?.textContent).toBe('Info');
    expect(panel.querySelector('.fy-info__name')?.textContent).toBe('Hadi');
    expect([...panel.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Overview', 'Runtime']);
    expect(panel.getAttribute('data-info-tab')).toBe('overview');
    // InfoSection: a heading over a run of label rows.
    expect(panel.querySelector('.fy-info-section__title')?.textContent).toBe('About this ferret');
    expect(panel.querySelector('dl.fy-info-rows [data-info-row="Task"] dd')?.textContent).toBe('Fix the login bug');
    expect(panel.querySelector('[data-info-row="Ferret id"]')).not.toBeNull();
    // The Runtime tab is one more section of rows.
    const runtime = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === 'Runtime');
    await interact(() => must(runtime, 'the Runtime tab').click());
    await settle();
    expect(must(root.querySelector('[data-info-panel]'), 'the Info panel').getAttribute('data-info-tab')).toBe(
      'runtime',
    );
    await click(root, '[data-info-close]');
    expect(root.querySelector('[data-info-panel]')).toBeNull();
  });
});

describe('the ferret list row menu', () => {
  it('S-0074 the row menu opens for that ferret at the pointer, and as a sheet after a touch', async () => {
    // ContextActionsMenu (v4's row menu) is the menu the built half's ferret list opens from a row: the screen
    // provides it to every row, which opens it for its own ferret.
    deviceControls().setDeviceControls({ sessionsMode: 'all' });
    window.history.pushState(null, '', '/d/dm1/ferrets');
    const Screen = must(
      halfOver({ 'GET /v1/ferrets': [ferretSummary('f1', { name: 'hadi', title: 'Fix it', mode: 'auto' })] }).screens
        ?.ferrets,
      'the ferrets screen',
    ) as FunctionComponent<ScreenProps>;
    const root = await show(
      <RouterProvider screens={SCREEN_REFS}>
        <Screen params={{}} />
      </RouterProvider>,
    );
    const row = must(root.querySelector<HTMLElement>('[data-sbar-session="f1"]'), 'the ferret row');
    const fire = (target: EventTarget, type: string, fields: Record<string, unknown>): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, fields);
      target.dispatchEvent(event);
    };
    const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-ferret-row-menu]');

    await interact(() => fire(row, 'contextmenu', { clientX: 140, clientY: 210 }));
    const atPointer = must(menu(), 'the menu at the pointer');
    expect(atPointer.getAttribute('aria-label')).toBe('Hadi actions');
    expect([atPointer.style.left, atPointer.style.top]).toEqual(['140px', '210px']);
    expect(atPointer.className).not.toContain('fy-actions-menu--sheet');
    expect(atPointer.querySelector('[data-ferret-action-item="open"]')).not.toBeNull();

    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await settle();
    expect(menu()).toBeNull();

    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'touch' });
      fire(row, 'contextmenu', { clientX: 5, clientY: 6 });
    });
    expect(must(menu(), 'the sheet').className).toContain('fy-actions-menu--sheet');
  });
});
