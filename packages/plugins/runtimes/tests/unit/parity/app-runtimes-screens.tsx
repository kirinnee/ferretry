/**
 * Runtimes' app half, parity with today's Runtimes Settings tab and the composer's runtime picker
 * (docs/design/rebuild-parity.tsv, owner `runtimes`, kind S).
 *
 * Each screen is proved by drawing it: the half the plugin builds is mounted (the `runtimes` Settings tab and the
 * `runtime-picker` panel, both lazy behind a Suspense boundary as the shell mounts them) over a scripted daemon client,
 * and the test reads what it drew. A menu or dialog behind an action is opened by a short scripted walk. A screen that
 * only shows in another state (a runtime's own page, the remove dialog) gets its own state and its own test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { RuntimeCatalogSchema, type RuntimeView } from '../../../contract/index.ts';
import { READS, RUNTIMES, runtime, scripted, stagedFrom, DATA } from '../app/features/fleet/account-support.ts';
import type { Call } from '../app/features/fleet/account-support.ts';

/** Agent runtimes (the default's candidates), one plain runtime, on a machine whose default is `claude-default`. */
const LISTED: readonly RuntimeView[] = [
  runtime({ name: 'claude-default', agent: true }),
  runtime({
    name: 'claude-work',
    agent: true,
    credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'ready' },
  }),
  runtime({
    name: 'codex-kirin',
    agent: true,
    harness: 'codex',
    credential: { id: 'codex', store: 'host', status: 'ready' },
  }),
  runtime({ name: 'claude-plain' }),
];

const catalogOf = (runtimes: readonly RuntimeView[]) => RuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes });

/** A daemon that answers the machine's reads, plus whatever routes a test adds. */
const daemon = (
  runtimes: readonly RuntimeView[],
  extra: Record<string, unknown> = {},
  calls: Call[] = [],
): PluginClient =>
  scripted({ ...READS({ ...DATA, runtimes: catalogOf(runtimes) }), ...extra }, calls) as unknown as PluginClient;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.window.location.hash = '';
  globalThis.history?.replaceState({}, '', '/');
});

/** Puts the address bar at `path` and `hash`. `mount` registers the DOM on first use, so an address set first needs one. */
const at = async (path: string, hash = ''): Promise<void> => {
  if (typeof window === 'undefined') await (await mount(<i />)).unmount();
  window.history.replaceState({}, '', path);
  window.location.hash = hash;
};

/** Mounts one of the half's surfaces as the shell does (inside Suspense), and waits for `ready`. */
const draw = async <Props extends object>(
  component: unknown,
  props: Props,
  ready: (root: HTMLElement) => boolean,
  what: string,
): Promise<HTMLElement> => {
  const element = createElement(
    Suspense,
    { fallback: null },
    createElement(component as FunctionComponent<Props>, props),
  );
  view = await mount(element);
  const root = view.container;
  await settleUntil(
    () => ready(root),
    () => `${what}; drew: ${root.textContent ?? ''}`,
    interact,
  );
  return root;
};

const drawTab = async (client: PluginClient, ready: string, hash = ''): Promise<HTMLElement> => {
  await at('/d/d1/settings/runtimes/runtimes', hash);
  const half = app.build?.({ manifest, client });
  return await draw<SettingsProps>(
    half?.settings.runtimes,
    {},
    root => root.querySelector(ready) !== null,
    `the Runtimes tab drew ${ready}`,
  );
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (element: Element): Promise<void> => {
  await interact(() => (element as HTMLElement).click());
  await settle();
};

const text = (root: ParentNode, selector: string): string =>
  must(root.querySelector(selector), selector).textContent ?? '';

describe('the Runtimes Settings tab the half builds', () => {
  it('S-0210 S-0084 S-0539 the Runtimes tab is declared, and draws the default runtime control and every runtime row', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'runtimes')?.label).toBe('Runtimes');
    const root = await drawTab(daemon(LISTED), '[data-runtimes-tab]');

    // S-0210: the tab itself, with its count, Add runtime and one row per runtime.
    expect(text(root, '[data-runtimes-count]')).toBe('4 runtimes on studio-mac');
    expect([...root.querySelectorAll('[data-runtime-row]')].map(row => row.getAttribute('data-runtime-row'))).toEqual([
      'claude-default',
      'claude-work',
      'codex-kirin',
      'claude-plain',
    ]);
    expect(text(root, '[data-add-runtime]')).toBe('Add runtime');
    expect(text(root, '[data-runtime-card="claude-default"] [data-runtime-default-badge]')).toBe('Default');

    // S-0084: "Default for new agents", a select of the agent runtimes only, with its hint.
    const control = must(root.querySelector('[data-default-runtime]'), 'the default runtime control');
    expect(control.textContent).toContain('Default for new agents');
    expect(text(control, '[data-default-runtime-hint]')).toBe('Used when a start names no runtime.');
    const select = must(control.querySelector<HTMLSelectElement>('[data-default-runtime-select]'), 'the select');
    expect([...select.options].map(option => option.value)).toEqual(['claude-default', 'claude-work', 'codex-kirin']);
    expect(select.value).toBe('claude-default');
    expect(control.querySelector('[data-change-submit]')).toBeNull();

    // Picking another one shows the apply panel, never a save by itself.
    await interact(() => {
      select.value = 'claude-work';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(text(control, '[data-change-submit]')).toBe('Save default runtime');
    expect(text(control, '[data-default-runtime-undo]')).toBe('Keep claude-default');
  });

  it('S-0206 the ⋯ menu on a runtime row offers Make default, Rename and a destructive Remove', async () => {
    const root = await drawTab(daemon(LISTED), '[data-runtimes-tab]');
    const trigger = must(
      root.querySelector<HTMLButtonElement>('[data-runtime-card="claude-work"] [data-runtime-actions]'),
      'the ⋯ button on claude-work',
    );
    expect(trigger.getAttribute('aria-label')).toBe('Actions for claude-work');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = must(document.querySelector('[role="menu"]'), 'the actions menu');
    expect(menu.getAttribute('aria-label')).toBe('Actions for claude-work');
    const items = new Map(
      [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => [
        item.getAttribute('data-menu-key'),
        item,
      ]),
    );
    expect([...items.keys()]).toEqual(['make-default', 'rename', 'remove']);
    expect(items.get('make-default')?.textContent).toBe('Make default');
    expect(items.get('rename')?.textContent).toBe('Rename');
    expect(items.get('remove')?.textContent).toBe('Remove');
    expect(items.get('remove')?.className).toContain('text-err');
  });

  it('S-0200 S-0208 Rename in the ⋯ menu opens the dialog frame with the current name and a Rename button', async () => {
    const root = await drawTab(daemon(LISTED), '[data-runtimes-tab]');
    await click(must(root.querySelector('[data-runtime-card="codex-kirin"] [data-runtime-actions]'), 'the ⋯ button'));
    await click(must(document.querySelector('[role="menu"] [data-menu-key="rename"]'), 'Rename in the menu'));

    // S-0208: the frame every runtime dialog sits in: a modal dialog with its title and a scrim that closes it.
    const dialog = must(document.querySelector('[data-runtime-dialog="rename"]'), 'the rename dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(text(dialog, 'h2')).toBe('Rename codex-kirin');
    expect(must(document.querySelector('[data-runtime-dialog-scrim]'), 'the scrim').getAttribute('aria-label')).toBe(
      'Close without renaming',
    );

    // S-0200: the rename dialog's own fields.
    const input = must(dialog.querySelector<HTMLInputElement>('[data-runtime-rename-input]'), 'the name field');
    expect(input.value).toBe('codex-kirin');
    expect(text(dialog, '[data-runtime-rename-notes]')).toContain('nothing restarts');
    expect(text(dialog, '[data-runtime-rename-notes]')).toContain('--agent codex-kirin still works');
    expect(text(dialog, '[data-change-submit]')).toBe('Rename');
    expect(text(dialog, '[data-runtime-dialog-cancel]')).toBe('Cancel');

    await click(must(dialog.querySelector('[data-runtime-dialog-cancel]'), 'Cancel'));
    expect(document.querySelector('[data-runtime-dialog]')).toBeNull();
  });

  it('S-0199 Remove in the ⋯ menu lists the ferrets running on the runtime and offers to move them first', async () => {
    const ferrets = [
      { id: 's-1', name: 'Fisher', harness: 'claude-code' },
      { id: 's-2', name: 'Otter', harness: 'claude-code' },
    ];
    const staged = (call: Call) => ({
      ...stagedFrom(call),
      summary: 'Remove runtime',
      consequences: [
        '2 ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.',
      ],
      preview: { kind: 'apply', operations: [], documents: [], runtimes: [], runningSessions: ferrets },
    });
    const root = await drawTab(daemon(LISTED, { 'POST /v1/runtimes/proposals': staged }), '[data-runtimes-tab]');
    await click(must(root.querySelector('[data-runtime-card="codex-kirin"] [data-runtime-actions]'), 'the ⋯ button'));
    await click(must(document.querySelector('[role="menu"] [data-menu-key="remove"]'), 'Remove in the menu'));
    await settleUntil(
      () => document.querySelector('[data-runtime-remove-impact]') !== null,
      () => `the remove dialog read what runs; drew: ${document.body.textContent ?? ''}`,
      interact,
    );

    const dialog = must(document.querySelector('[data-runtime-dialog="remove"]'), 'the remove dialog');
    expect(text(dialog, 'h2')).toBe('Remove codex-kirin?');
    expect(text(dialog, '[data-runtime-remove-impact]')).toContain('2 ferrets are running on it.');
    expect([...dialog.querySelectorAll('[data-runtime-running] li')].map(row => row.textContent)).toEqual([
      'Fisher' + 'Claude Code',
      'Otter' + 'Claude Code',
    ]);
    const target = must(dialog.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'the move target');
    expect([...target.options].map(option => option.value)).toEqual([
      '',
      'claude-default',
      'claude-work',
      'claude-plain',
    ]);
    expect(text(dialog, '[data-runtime-dialog-cancel]')).toBe('Cancel');
    expect(must(dialog.querySelector('[data-change-submit]'), 'the Remove button').textContent).toContain('Remove');
  });
});

describe('a runtime page on the Runtimes tab', () => {
  it('S-0209 S-0221 a runtime page draws its sections: credential, profile, model set, fixed layer and Launch', async () => {
    const root = await drawTab(
      daemon(RUNTIMES.runtimes),
      '[data-runtime-page]',
      '#machines/studio-mac/runtimes/claude-agent',
    );

    // S-0209: the page itself, its name, back link, actions and Launch.
    const page = must(root.querySelector('[data-runtime-page="claude-agent"]'), 'the runtime page');
    expect(text(page, 'h3')).toBe('claude-agent');
    expect(text(page, '[data-page-back]')).toBe('Runtimes');
    expect(page.textContent).toContain('Agent runtime');
    expect(page.querySelector('[data-runtime-rename="claude-agent"]')).not.toBeNull();
    expect(page.querySelector('[data-runtime-remove="claude-agent"]')).not.toBeNull();
    expect(page.querySelector('[data-runtimes-tab]')).toBeNull();
    expect(must(page.querySelector('[data-runtime-launch]'), 'Launch').getAttribute('href')).toBe(
      '/d/d1/new?agent=claude-agent',
    );
    expect(
      must(page.querySelector('[data-runtime-credential]'), 'the credential').getAttribute('data-runtime-credential'),
    ).toBe('claude-personal');
    expect(page.querySelector('[data-runtime-profile="Agent work"]')).not.toBeNull();

    // S-0221: the section headings the page is built from.
    const headings = [...page.querySelectorAll('section h4')].map(heading => heading.textContent?.trim());
    expect(headings.slice(-4)).toEqual(['Credential', 'Profile', 'Model set', 'Fixed layer']);
    expect(text(page, '[data-runtime-fixed-layer]')).toContain('permissions.defaultMode = auto');
  });
});

describe('the runtime picker above the composer', () => {
  it('S-0207 the runtime-picker panel draws the model choices as a menu with the current one checked', async () => {
    expect(manifest.ui?.panels?.find(entry => entry.id === 'runtime-picker')?.slot).toBe('composer.tools');
    const catalog = {
      harness: 'claude-code',
      source: 'wrapper-inventory',
      choices: [
        { value: 'claude-opus-5', label: 'Opus 5', description: 'The big one', isDefault: true, reasoningEfforts: [] },
        { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [] },
      ],
    };
    const ferret = {
      config: { id: 's-1', harness: 'claude-code', model: 'claude-sonnet-5' },
      state: { status: 'running', promptReady: true },
    };
    const client = scripted({
      'GET /v1/ferrets/:ferretId': ferret,
      'GET /v1/ferrets/:id/runtime-models': catalog,
    }) as unknown as PluginClient;
    await at('/d/d1/chat/s-1');
    const half = app.build?.({ manifest, client });
    const root = await draw<PanelProps>(
      half?.panels['runtime-picker'],
      { subject: 's-1' } as PanelProps,
      node => node.querySelector('[role="menu"]') !== null,
      'the runtime picker menu',
    );
    expect(root.querySelector('[data-runtime-picker="s-1"]')).not.toBeNull();
    const menu = must(root.querySelector('[role="menu"]'), 'the model menu');
    expect(menu.getAttribute('aria-label')).toBe('Switch claude-code model in place');
    const choices = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(choices.map(choice => choice.getAttribute('aria-label'))).toEqual([
      'Switch model in place to Opus 5',
      'Switch model in place to Sonnet 5, current',
    ]);
    expect(choices.map(choice => choice.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(choices[0]?.textContent).toContain('The big one');
  });
});
