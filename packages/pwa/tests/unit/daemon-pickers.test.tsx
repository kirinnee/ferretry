import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';

import {
  AccountHealthCheck,
  AccountPickerField,
  accountEmptyCopy,
  accountFieldOptions,
  accountFieldSource,
  DaemonAccountPicker,
  checkedAmongOffered,
  DaemonProjectPicker,
  ProjectPickerField,
  projectFieldOptions,
  projectFieldSource,
} from '../../src/components/daemon-pickers.tsx';
import { accountPickerOptions, projectPickerOptions } from '../../src/components/daemon-picker-model.ts';
import type { AccountPickerHealthCatalog, PickerAccount } from '../../src/lib/account-picker-catalog.ts';
import {
  type DaemonAccountPickerPort,
  type DaemonAccountPickerSlice,
  DaemonAccountPickerStore,
} from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonFleetSlice } from '../../src/lib/fleet-store.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import type { DaemonProjectsSlice } from '../../src/lib/projects-store.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

// ─── fixtures ────────────────────────────────────────────────────────────────

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const account = (overrides: Partial<PickerAccount> = {}): PickerAccount => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-studio',
  home: '/homes/claude-auto-studio',
  displayName: 'Studio Claude',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const codex = account({
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'codex',
  wrapper: 'codex-auto-atelier',
  home: '/homes/codex-auto-atelier',
  displayName: 'Atelier Codex',
  defaultModel: 'gpt-5.6-terra',
  models: [{ id: 'gpt-5.6-terra', available: true }],
});

const archived = account({
  id: '33333333-3333-4333-8333-333333333333',
  wrapper: 'claude-auto-archive',
  home: '/homes/claude-auto-archive',
  displayName: 'Archive Claude',
  defaultModel: null,
  models: [],
  available: false,
  unavailableReason: 'this host has no such executable on its PATH',
});

/** A quota row for the studio wrapper only, so the others prove "unknown ≠ 0 %". */
const usage = [{ agent: 'claude-auto-studio', fiveHourPercent: 37, weeklyPercent: 61, authOk: true }] as const;

const slice = (overrides: Partial<DaemonAccountPickerSlice> = {}): DaemonAccountPickerSlice => ({
  generation: 1,
  catalog: { accounts: [account()] },
  status: 'ready',
  error: null,
  health: null,
  healthStatus: 'idle',
  healthError: null,
  ...overrides,
});

const projectsSlice = (overrides: Partial<DaemonProjectsSlice> = {}): DaemonProjectsSlice => ({
  projects: [],
  status: 'ready',
  error: null,
  ...overrides,
});

const fleetSlice = (overrides: Partial<DaemonFleetSlice> = {}): DaemonFleetSlice => ({
  sessions: [],
  byId: new Map(),
  status: 'ready',
  error: null,
  ...overrides,
});

const ferretry: FleetProject = { name: 'ferretry', path: '/work/ferretry', id: 'registry-id', source: 'clone' };

// ─── DOM helpers ─────────────────────────────────────────────────────────────

let live: Mounted | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const show = async (element: React.ReactElement): Promise<Mounted> => {
  const mounted = await mount(element);
  live = mounted;
  return mounted;
};

/**
 * THIS mount's own subtree.
 *
 * Every query below is scoped to it rather than to `document`, because the whole
 * suite shares one happy-dom document and a sibling file that leaves a control
 * behind would otherwise answer a question about this one. Asserting "no button
 * is offered" against the page is a claim about the page; the claim worth making
 * is about the field.
 */
const root = (): HTMLElement => must(live, 'a mounted picker').container;

const find = (selector: string): Element | null => root().querySelector(selector);

const input = (): HTMLInputElement => {
  const element = find('input[role="combobox"]');
  if (!(element instanceof HTMLInputElement)) throw new Error('the picker input is not mounted');
  return element;
};

/** Focus is what reveals the list, exactly as a reader's tap or Tab does. */
const openList = async (): Promise<void> => {
  await interact(() => input().focus());
};

const rows = (): readonly Element[] => [...root().querySelectorAll('[role="option"]')];

const rowText = (index: number): string => must(rows()[index], `row ${index}`).textContent ?? '';

const panelState = (): string | null => find('[data-picker-state]')?.getAttribute('data-picker-state') ?? null;

const panelText = (): string => find('[data-picker-state]')?.textContent ?? '';

const staleText = (): string | null => find('[data-picker-stale="true"]')?.textContent ?? null;

/** The health block's own live region, never the control's row count. */
const healthStatusText = (): string =>
  must(find('[data-picker-health] [role="status"]'), 'the health status line').textContent ?? '';

const checkButton = (): HTMLButtonElement => {
  const element = find('button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('the check button is not mounted');
  return element;
};

const alertText = (): string => must(find('[role="alert"]'), 'an alert').textContent ?? '';

const type = async (value: string): Promise<void> => {
  const field = input();
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

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

// ─── accountFieldOptions ─────────────────────────────────────────────────────

describe('accountFieldOptions', () => {
  it('keeps an unread roster unread rather than turning it into no accounts', () => {
    expect(accountFieldOptions(null)).toBeNull();
    expect(accountFieldOptions(accountPickerOptions(null, usage, null))).toBeNull();
  });

  it('offers each account under its wrapper, searchable by everything the projection matched on', () => {
    const options = must(accountFieldOptions(accountPickerOptions([account(), codex], usage, null)), 'options');

    expect(options.map(option => option.value)).toEqual(['claude-auto-studio', 'codex-auto-atelier']);
    expect(options.map(option => option.label)).toEqual(['Studio Claude', 'Atelier Codex']);
    expect(options[0]?.search).toContain('studio claude');
    expect(options[0]?.disabled).toBeUndefined();
    expect(options[0]?.disabledReason).toBeUndefined();
  });

  it('disables an unavailable account with the manifest’s own reason, and hides nothing', () => {
    const options = must(accountFieldOptions(accountPickerOptions([archived], usage, null)), 'options');

    expect(options).toHaveLength(1);
    expect(options[0]?.disabled).toBeTrue();
    expect(options[0]?.disabledReason).toBe('this host has no such executable on its PATH');
    // Still typeable is the control's job; still OFFERED is this one's.
    expect(options[0]?.value).toBe('claude-auto-archive');
  });
});

// ─── accountFieldSource ──────────────────────────────────────────────────────

describe('accountFieldSource', () => {
  it('reads an unread roster as loading, never as an empty fleet', () => {
    expect(accountFieldSource(slice({ catalog: null, status: 'loading' }), null)).toEqual({ kind: 'loading' });
    expect(accountFieldSource(slice({ catalog: null, status: 'idle' }), null)).toEqual({ kind: 'loading' });
  });

  it('reads a failed roster as failed, in the daemon’s own words', () => {
    expect(accountFieldSource(slice({ catalog: null, status: 'error', error: 'pairing expired' }), null)).toEqual({
      kind: 'failed',
      reason: 'pairing expired',
    });
  });

  it('still says something when a failure arrived without a sentence', () => {
    const source = accountFieldSource(slice({ catalog: null, status: 'error', error: null }), null);

    expect(source).toEqual({ kind: 'failed', reason: 'this daemon’s account roster could not be read' });
  });

  it('reads a positively empty roster as ready with no rows', () => {
    expect(accountFieldSource(slice({ catalog: { accounts: [] } }), [])).toEqual({ kind: 'ready', options: [] });
  });

  it('keeps last-good rows AND the failure when a refresh fails over them', () => {
    const options = must(accountFieldOptions(accountPickerOptions([account()], usage, null)), 'options');
    const source = accountFieldSource(slice({ status: 'error', error: 'the daemon stopped answering' }), options);

    expect(source).toMatchObject({ kind: 'ready', staleReason: 'the daemon stopped answering' });
  });

  it('adds no staleness to a settled read', () => {
    const source = accountFieldSource(slice(), []);

    expect(source).toEqual({ kind: 'ready', options: [] });
  });
});

// ─── project projections ─────────────────────────────────────────────────────

describe('projectFieldOptions', () => {
  it('is unread only when neither the registry nor the session list was read', () => {
    expect(projectFieldOptions({ registered: null, recent: null })).toBeNull();
  });

  it('puts registered folders before folders a session merely used', () => {
    const sessions = [sessionView('s1', { config: { cwd: '/work/other' } })];
    const options = must(projectFieldOptions(projectPickerOptions([ferretry], sessions)), 'options');

    expect(options.map(option => option.value)).toEqual(['/work/ferretry', '/work/other']);
    expect(options.map(option => option.project.kind)).toEqual(['registered', 'recent']);
    expect(options[1]).not.toHaveProperty('project.id');
  });

  it('offers recent folders alone when the registry is unread', () => {
    const sessions = [sessionView('s1', { config: { cwd: '/work/other' } })];
    const options = must(projectFieldOptions(projectPickerOptions(null, sessions)), 'options');

    expect(options.map(option => option.project.kind)).toEqual(['recent']);
  });

  it('offers registered folders alone when the session list is unread', () => {
    const options = must(projectFieldOptions(projectPickerOptions([ferretry], null)), 'options');

    expect(options.map(option => option.project.kind)).toEqual(['registered']);
  });
});

describe('projectFieldSource', () => {
  it('reads two unread lists as loading', () => {
    const source = projectFieldSource(projectsSlice({ projects: null, status: 'loading' }), fleetSlice(), null);

    expect(source).toEqual({ kind: 'loading' });
  });

  it('reads a failed registry as failed', () => {
    const source = projectFieldSource(
      projectsSlice({ projects: null, status: 'error', error: 'projects are admin-only' }),
      fleetSlice(),
      null,
    );

    expect(source).toEqual({ kind: 'failed', reason: 'projects are admin-only' });
  });

  it('reads a failed session list as failed', () => {
    const source = projectFieldSource(
      projectsSlice({ projects: null }),
      fleetSlice({ sessions: null, status: 'error', error: 'the fleet is unreachable' }),
      null,
    );

    expect(source).toEqual({ kind: 'failed', reason: 'the fleet is unreachable' });
  });

  it('still says something when neither read supplied a sentence', () => {
    const source = projectFieldSource(
      projectsSlice({ projects: null, status: 'error' }),
      fleetSlice({ sessions: null }),
      null,
    );

    expect(source).toEqual({ kind: 'failed', reason: 'this daemon’s folders could not be read' });
  });

  it('warns that the list is partial when only the registry failed', () => {
    const source = projectFieldSource(
      projectsSlice({ projects: null, status: 'error', error: 'the registry is damaged' }),
      fleetSlice(),
      [],
    );

    expect(source).toMatchObject({ kind: 'ready', staleReason: 'the registry is damaged' });
  });

  it('names the missing half itself when the failed read said nothing', () => {
    const source = projectFieldSource(projectsSlice({ projects: null }), fleetSlice(), []);

    expect(source).toMatchObject({
      kind: 'ready',
      staleReason: 'the registered projects could not be read — only recently used folders are listed',
    });
  });

  it('warns the other way round when only the session list is missing', () => {
    expect(projectFieldSource(projectsSlice(), fleetSlice({ sessions: null }), [])).toMatchObject({
      staleReason: 'the session list could not be read — only registered projects are listed',
    });
    expect(
      projectFieldSource(projectsSlice(), fleetSlice({ sessions: null, error: 'the fleet read timed out' }), []),
    ).toMatchObject({ staleReason: 'the fleet read timed out' });
  });

  it('adds no warning when both halves were read', () => {
    expect(projectFieldSource(projectsSlice(), fleetSlice(), [])).toEqual({ kind: 'ready', options: [] });
  });
});

// ─── empty copy and the health count ─────────────────────────────────────────

describe('accountEmptyCopy', () => {
  it('claims nothing about the host when no filter is in play', () => {
    expect(accountEmptyCopy(undefined, true).notice).toBe(
      'This daemon publishes no accounts. Type a wrapper name instead.',
    );
    expect(accountEmptyCopy(undefined, true).status).toContain('publishes no accounts');
  });

  it('names the harness only when the host published something else', () => {
    const claude = accountEmptyCopy('claude', true);
    expect(claude.notice).toBe('This daemon publishes no Claude accounts. Type a wrapper name instead.');
    expect(claude.status).toContain('though it publishes others');
    expect(accountEmptyCopy('codex', true).notice).toContain('no Codex accounts');
  });

  it('keeps the fleet-wide sentence for an empty manifest, filtered or not', () => {
    expect(accountEmptyCopy('codex', false).notice).toBe(
      'This daemon publishes no accounts. Type a wrapper name instead.',
    );
  });

  it('claims less when the caller cannot say whether anything is published', () => {
    // An unread roster must not be described as "publishes no Codex accounts,
    // though it publishes others" — nobody knows that yet.
    expect(accountEmptyCopy('codex', undefined).notice).toContain('publishes no accounts');
  });
});

describe('checkedAmongOffered', () => {
  const options = must(accountFieldOptions(accountPickerOptions([account(), codex], usage, null)), 'options').map(
    option => option.account,
  );
  const health = (...ids: readonly string[]) =>
    new Map(
      ids.map(id => [
        id,
        { accountId: id, kind: 'claude' as const, state: 'healthy' as const, cached: false, checkedAt: 1, ms: 2 },
      ]),
    );

  it('counts only the rows this field offers', () => {
    const codexOnly = [must(options[1], 'the codex option')];

    // The probe checked both; a Codex-only list may claim only its own row.
    expect(checkedAmongOffered(options, health(account().id, codex.id))).toBe(2);
    expect(checkedAmongOffered(codexOnly, health(account().id, codex.id))).toBe(1);
    expect(checkedAmongOffered(codexOnly, health(account().id))).toBe(0);
  });

  it('is zero when nothing has been checked or nothing is offered', () => {
    expect(checkedAmongOffered(options, null)).toBe(0);
    expect(checkedAmongOffered(null, health(account().id))).toBe(0);
  });
});

// ─── account rows ────────────────────────────────────────────────────────────

const accountField = async (
  accounts: readonly PickerAccount[],
  health: AccountPickerHealthCatalog['health'] | null = null,
): Promise<void> => {
  const options = accountFieldOptions(accountPickerOptions(accounts, usage, health));
  await show(
    <AccountPickerField
      id="fy-test-agent"
      label="Account"
      onValueChange={() => undefined}
      source={accountFieldSource(slice(), options)}
      value=""
    />,
  );
  await openList();
};

describe('the account row', () => {
  it('leads with the display name and names the wrapper, harness and mode beneath it', async () => {
    await accountField([account()]);

    expect(rowText(0)).toContain('Studio Claude');
    expect(rowText(0)).toContain('claude-auto-studio · Claude · auto');
  });

  it('renders a real quota reading and never a confident zero for a wrapper with none', async () => {
    await accountField([account(), codex]);

    expect(rowText(0)).toContain('5h 37%');
    expect(rowText(0)).toContain('wk 61%');
    // The feed has no row for this wrapper, so the column says so explicitly.
    expect(rowText(1)).toContain('quota —');
    expect(rowText(1)).not.toContain('0%');
  });

  it('says an unchecked account is unchecked rather than healthy', async () => {
    await accountField([account()]);

    expect(rowText(0)).toContain('unchecked');
    expect(rowText(0)).not.toContain('healthy');
  });

  it('tells the three health verdicts apart once a reader has checked', async () => {
    const health = new Map([
      [
        account().id,
        {
          accountId: account().id,
          kind: 'claude' as const,
          state: 'healthy' as const,
          cached: true,
          checkedAt: 1,
          ms: 2,
        },
      ],
      [
        codex.id,
        {
          accountId: codex.id,
          kind: 'codex' as const,
          state: 'down' as const,
          cached: false,
          checkedAt: 1,
          ms: 30_000,
          failureKind: 'timeout' as const,
          error: 'timed out after 30s',
        },
      ],
      [
        archived.id,
        {
          accountId: archived.id,
          kind: 'claude' as const,
          state: 'unknown' as const,
          cached: false,
          checkedAt: 1,
          ms: 0,
        },
      ],
    ]);
    await accountField([account(), codex, archived], health);

    expect(rowText(0)).toContain('healthy');
    expect(rowText(1)).toContain('down');
    expect(rowText(2)).toContain('unknown');
    expect(must(rows()[0], 'row 0').querySelector('[title*="cached health: healthy"]')).not.toBeNull();
    expect(must(rows()[1], 'row 1').querySelector('[title*="(timeout)"]')?.getAttribute('title')).toContain(
      'timed out after 30s',
    );
  });

  /**
   * THE RESPONSIVE CONTRACT, asserted as classes rather than as pixels.
   *
   * happy-dom loads no stylesheet, so no test here can measure a wrapped line —
   * that evidence comes from the harness capture at a real 390px. What a test CAN
   * pin is the contract the capture depends on, and pin it against the exact
   * regression that produced the defect: a bare `truncate` on a line carrying a
   * submitted value. If somebody re-adds one, this fails before anybody has to
   * look at a screenshot again.
   */
  it('stacks the evidence beneath the identity on a phone and restores the rail at sm', async () => {
    await accountField([account()]);
    const row = must(rows()[0], 'row 0');

    const layout = must(row.querySelector('[data-picker-row="account"]'), 'the row layout')?.className;
    // Stacked by default, side by side only from `sm` up.
    expect(layout).toContain('flex-col');
    expect(layout).toContain('sm:flex-row');
    expect(layout).toContain('sm:justify-between');
    // Stacked children size to their content: without this a bordered child
    // stretches the full row width and reads as a bar rather than a pill.
    expect(layout).toContain('items-start');

    // The rail never shrinks, and it is a wrapping row on a phone.
    const rail = must(row.querySelector('.flex-wrap'), 'the evidence rail').className;
    expect(rail).toContain('shrink-0');
    expect(rail).toContain('sm:flex-col');
    expect(rail).toContain('sm:items-end');
  });

  it('never truncates the submitted wrapper on a phone', async () => {
    await accountField([account({ wrapper: 'claude-auto-a-deliberately-long-wrapper-name' })]);
    const line = must(find('[data-picker-identity="wrapper"]'), 'the wrapper line');

    // The whole value is in the DOM, and nothing clips it below `sm`.
    expect(line.textContent).toContain('claude-auto-a-deliberately-long-wrapper-name');
    expect(line.className).toContain('break-words');
    expect(line.className).toContain('sm:truncate');
    expect(line.className.split(/\s+/u)).not.toContain('truncate');
  });

  it('shows an unavailable account with its reason, and refuses to let it be chosen', async () => {
    await accountField([archived]);

    expect(rowText(0)).toContain('this host has no such executable on its PATH');
    expect(must(rows()[0], 'row 0').getAttribute('aria-disabled')).toBe('true');
    await pressRow(0);
    expect(input().value).toBe('');
  });
});

// ─── project rows ────────────────────────────────────────────────────────────

describe('the project row', () => {
  it('labels a registered folder and a merely-used one differently', async () => {
    const sessions = [sessionView('s1', { config: { cwd: '/work/other' } })];
    const catalog = projectPickerOptions([ferretry], sessions);
    await show(
      <DaemonProjectPicker
        catalog={catalog}
        fleet={fleetSlice({ sessions })}
        id="fy-test-cwd"
        label="Project"
        onValueChange={() => undefined}
        projects={projectsSlice({ projects: [ferretry] })}
        value=""
      />,
    );
    await openList();

    expect(rowText(0)).toContain('ferretry');
    expect(rowText(0)).toContain('/work/ferretry');
    expect(rowText(0)).toContain('Registered');
    expect(rowText(1)).toContain('Recent');
    expect(rowText(1)).not.toContain('Registered');
    expect(must(rows()[1], 'row 1').querySelector('[title*="registers nothing"]')).not.toBeNull();
  });

  /** The same contract as the account row, for the value a folder row submits. */
  it('lets a long absolute path wrap whole on a phone while the badge keeps its width', async () => {
    const deep: FleetProject = {
      name: 'home-manager',
      path: '/home/pilot/.config/home-manager/modules/agent-config',
      id: 'p-deep',
      source: 'existing-folder',
    };
    await show(
      <DaemonProjectPicker
        catalog={projectPickerOptions([deep], [])}
        fleet={fleetSlice()}
        id="fy-test-cwd"
        label="Project"
        onValueChange={() => undefined}
        projects={projectsSlice({ projects: [deep] })}
        value=""
      />,
    );
    await openList();

    const layout = must(find('[data-picker-row="project"]'), 'the row layout').className;
    expect(layout).toContain('flex-col');
    expect(layout).toContain('sm:flex-row');

    const path = must(find('[data-picker-identity="path"]'), 'the path line');
    expect(path.textContent).toBe('/home/pilot/.config/home-manager/modules/agent-config');
    // A path has no spaces, so anywhere is the only place it can break.
    expect(path.className).toContain('break-all');
    expect(path.className).toContain('sm:truncate');
    expect(path.className.split(/\s+/u)).not.toContain('truncate');

    // The provenance badge is still the thing that refuses to shrink.
    expect(must(find('.rounded-badge'), 'the provenance badge').className).toContain('shrink-0');
  });
});

// ─── the fields ──────────────────────────────────────────────────────────────

describe('AccountPickerField', () => {
  it('filters as you type and keeps a value the roster has never heard of', async () => {
    const values: string[] = [];
    const options = accountFieldOptions(accountPickerOptions([account(), codex], usage, null));

    function Host() {
      const [value, setValue] = useState('');
      return (
        <AccountPickerField
          id="fy-test-agent"
          label="Account"
          onValueChange={next => {
            values.push(next);
            setValue(next);
          }}
          source={accountFieldSource(slice(), options)}
          value={value}
        />
      );
    }
    await show(<Host />);
    await openList();
    expect(rows()).toHaveLength(2);

    await type('atel');
    expect(rows()).toHaveLength(1);
    expect(rowText(0)).toContain('Atelier Codex');

    await type('glm-mass-chore');
    expect(panelState()).toBe('no-match');
    expect(input().value).toBe('glm-mass-chore');
    expect(values.at(-1)).toBe('glm-mass-chore');
    // The field is the thing that submits, and it never stopped being editable.
    expect(input().hasAttribute('disabled')).toBeFalse();
  });

  it('hands the whole chosen account to its surface without touching a model', async () => {
    const chosen: string[] = [];
    const options = accountFieldOptions(accountPickerOptions([account()], usage, null));

    function Host() {
      const [value, setValue] = useState('');
      return (
        <AccountPickerField
          id="fy-test-agent"
          label="Account"
          onAccountChosen={picked => chosen.push(`${picked.wrapper}:${picked.defaultModel ?? ''}`)}
          onValueChange={setValue}
          source={accountFieldSource(slice(), options)}
          value={value}
        />
      );
    }
    await show(<Host />);
    await openList();
    await pressRow(0);

    expect(input().value).toBe('claude-auto-studio');
    // The default model is REACHABLE, which is the point of the callback, and
    // the field's own value is still only the wrapper.
    expect(chosen).toEqual(['claude-auto-studio:claude-opus-5']);

    // Choosing dismisses the list, so a reader re-opens it the way the control
    // documents: a navigation key. Re-opened, the row the box already holds is
    // marked — a different fact from where the keyboard cursor is.
    await interact(() => pressKey(input(), 'ArrowDown'));
    expect(must(rows()[0], 'row 0').getAttribute('data-current')).toBe('true');
    expect(find('[aria-label="current choice"]')).not.toBeNull();
  });

  /**
   * A migration narrows the roster to one harness. On a host with Claude accounts
   * and no Codex one, "this daemon publishes no accounts" is a false statement
   * about the host, invented from a decision the browser made — and the one that
   * sends somebody to provision an account they already have.
   */
  it('names the harness when the FILTER emptied the list, not the host', async () => {
    const store = new DaemonAccountPickerStore({
      catalog: async () => ({
        accounts: [account(), account({ id: 'other', wrapper: 'claude-auto-two', home: '/h2' })],
      }),
      health: async () => ({ health: new Map(), error: null }),
    });
    await show(
      <DaemonAccountPicker
        connection={laptop}
        harness="codex"
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('publishes no Codex accounts');
    expect(panelText()).not.toContain('publishes no accounts.');
    // Spoken as well as shown, and it says WHY the list is empty.
    expect(must(find('[role="status"]'), 'the live region').textContent).toBe(
      'This daemon publishes no Codex accounts, though it publishes others. Type a wrapper name instead.',
    );
  });

  /**
   * A slice assembled by hand — which is what the app-shell wiring test does —
   * can carry an ABSENT catalog rather than an explicitly null one. Reading it
   * with a strict `=== null` test threw on `.accounts` and blanked the pane
   * behind the error boundary, so the field lost its text box entirely. The
   * regression is off-type on purpose: the types say `null`, the DOM said
   * otherwise, and a picker must render a usable field either way.
   */
  it('renders a usable field when the roster slice carries no catalog at all', async () => {
    // Frozen and returned by identity, because `useSyncExternalStore` compares
    // snapshots by reference: a fake handing back a fresh object per read would
    // re-render forever and prove nothing about the component.
    const catalogless = Object.freeze({
      generation: 1,
      status: 'idle',
      error: null,
      health: null,
      healthStatus: 'idle',
      healthError: null,
    });
    const store = {
      subscribe: () => () => undefined,
      sliceFor: () => catalogless,
      hydrate: async () => ({ accounts: [] }),
      checkHealth: async () => ({ health: new Map(), error: null }),
    } as unknown as DaemonAccountPickerStore;

    await show(
      <DaemonAccountPicker
        connection={laptop}
        harness="codex"
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );

    expect(input().id).toBe('fy-test-agent');
    expect(input().getAttribute('role')).toBe('combobox');
    await openList();
    expect(panelState()).toBe('loading');
  });

  it('keeps the fleet-wide sentence when the manifest really is empty', async () => {
    const store = new DaemonAccountPickerStore({
      catalog: async () => ({ accounts: [] }),
      health: async () => ({ health: new Map(), error: null }),
    });
    await show(
      <DaemonAccountPicker
        connection={laptop}
        harness="codex"
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('This daemon publishes no accounts.');
    expect(panelText()).not.toContain('Codex');
    expect(must(find('[role="status"]'), 'the live region').textContent).toBe(
      'This daemon publishes no accounts. Type a wrapper name instead.',
    );
  });

  it('says a positively empty roster is empty, in words about accounts', async () => {
    await show(
      <AccountPickerField
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        source={{ kind: 'ready', options: [] }}
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('empty');
    expect(panelText()).toContain('publishes no accounts');
  });

  it('shows a failed roster as a failure over an editable field, never as an empty one', async () => {
    await show(
      <AccountPickerField
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        source={{ kind: 'failed', reason: 'the daemon refused the roster' }}
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('failed');
    expect(alertText()).toContain('the daemon refused the roster');
    expect(input().hasAttribute('disabled')).toBeFalse();
  });

  it('shows rows and a staleness warning together', async () => {
    const options = accountFieldOptions(accountPickerOptions([account()], usage, null));
    await show(
      <AccountPickerField
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        source={accountFieldSource(slice({ status: 'error', error: 'the last refresh failed' }), options)}
        value=""
      />,
    );
    await openList();

    expect(rows()).toHaveLength(1);
    expect(staleText()).toContain('the last refresh failed');
  });

  it('offers no health control unless its surface asked for one', async () => {
    await accountField([account()]);

    expect(find('button')).toBeNull();
  });
});

describe('ProjectPickerField', () => {
  it('says an empty catalogue is empty, in words about folders', async () => {
    await show(
      <ProjectPickerField
        describedBy="fy-test-cwd-help"
        id="fy-test-cwd"
        label="Project"
        onValueChange={() => undefined}
        placeholder="/absolute/path"
        source={{ kind: 'ready', options: [] }}
        value=""
      />,
    );
    await openList();

    expect(panelText()).toContain('registers no projects');
    expect(input().getAttribute('aria-describedby')).toBe('fy-test-cwd-help');
    expect(input().getAttribute('placeholder')).toBe('/absolute/path');
    expect(input().id).toBe('fy-test-cwd');
  });
});

// ─── the health check ────────────────────────────────────────────────────────

describe('AccountHealthCheck', () => {
  it('says what pressing it costs before it is pressed', async () => {
    const presses: number[] = [];
    await show(<AccountHealthCheck checked={0} error={null} onCheck={() => presses.push(1)} status="idle" />);

    const button = checkButton();
    expect(button.textContent).toContain('Check accounts');
    expect(root().textContent).toContain('starts each published account once');
    expect(button.hasAttribute('disabled')).toBeFalse();

    await press(button);
    expect(presses).toEqual([1]);
  });

  it('refuses a second press while the host is still being probed', async () => {
    const presses: number[] = [];
    await show(<AccountHealthCheck checked={0} error={null} onCheck={() => presses.push(1)} status="loading" />);

    const button = checkButton();
    expect(button.textContent).toContain('Checking accounts…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBeTrue();
    await press(button);
    expect(presses).toEqual([]);
  });

  it('reports how many accounts answered, singular and plural', async () => {
    const one = await show(<AccountHealthCheck checked={1} error={null} onCheck={() => undefined} status="ready" />);
    expect(healthStatusText()).toContain('1 account checked.');

    await one.render(<AccountHealthCheck checked={3} error={null} onCheck={() => undefined} status="ready" />);
    expect(healthStatusText()).toContain('3 accounts checked.');
    expect(root().textContent).toContain('Accounts with no result stay unchecked');
  });

  it('reports a failed check as an alert that promises nothing about the accounts', async () => {
    const failed = await show(
      <AccountHealthCheck
        checked={0}
        error="the daemon returned ambiguous health rows"
        onCheck={() => undefined}
        status="error"
      />,
    );
    const alert = must(find('[role="alert"]'), 'alert');
    expect(alert.textContent).toContain('ambiguous health rows');
    expect(alert.textContent).toContain('stay unchecked rather than being reported healthy');

    await failed.render(<AccountHealthCheck checked={0} error={null} onCheck={() => undefined} status="error" />);
    expect(alertText()).toContain('the account check could not be completed');
  });
});

// ─── connected ───────────────────────────────────────────────────────────────

const catalogPort = (health?: () => Promise<AccountPickerHealthCatalog>): DaemonAccountPickerPort => ({
  catalog: async daemon => ({
    accounts: daemon.daemonId === laptop.daemonId ? [account(), codex] : [archived],
  }),
  health:
    health ??
    (async () => {
      throw new Error('the harness never probes unless a test says so');
    }),
});

describe('DaemonAccountPicker', () => {
  it('hydrates the cheap roster from its own subscription and never probes the host', async () => {
    let probes = 0;
    const store = new DaemonAccountPickerStore({
      catalog: async () => ({ accounts: [account()] }),
      health: async () => {
        probes += 1;
        return { health: new Map(), error: null };
      },
    });
    await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();

    expect(rows()).toHaveLength(1);
    // Projected internally: the caller supplied a roster of nothing at all.
    expect(rowText(0)).toContain('Studio Claude');
    expect(rowText(0)).toContain('5h 37%');
    expect(probes).toBe(0);
    expect(find('button')).toBeNull();
  });

  it('reads an unhydrated roster as loading, not as a host with no accounts', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore({
      catalog: async () => {
        await gate;
        return { accounts: [account()] };
      },
      health: async () => ({ health: new Map(), error: null }),
    });
    await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={[]}
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('loading');
    release();
    await interact(async () => {
      await Promise.resolve();
    });
  });

  it('reports a missing quota feed beside the rows instead of failing the roster', async () => {
    const store = new DaemonAccountPickerStore(catalogPort());
    await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={[]}
        usageError="the usage feed has not been read yet"
        value=""
      />,
    );
    await openList();

    expect(panelState()).toBe('options');
    expect(rows()).toHaveLength(2);
    expect(must(find('[data-picker-advisory]'), 'advisory').textContent).toContain(
      'the usage feed has not been read yet',
    );
    expect(rowText(0)).toContain('quota —');
  });

  it('says nothing about quota when the feed was read and simply had no row', async () => {
    const store = new DaemonAccountPickerStore(catalogPort());
    await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={[]}
        usageError={null}
        value=""
      />,
    );

    expect(find('[data-picker-advisory]')).toBeNull();
  });

  it('offers only the same harness for a migration', async () => {
    const store = new DaemonAccountPickerStore(catalogPort());
    await show(
      <DaemonAccountPicker
        connection={laptop}
        harness="codex"
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();

    expect(rows()).toHaveLength(1);
    expect(rowText(0)).toContain('Atelier Codex');
  });

  it('probes only from a press, then shows what came back', async () => {
    let probes = 0;
    const store = new DaemonAccountPickerStore(
      catalogPort(async () => {
        probes += 1;
        return {
          health: new Map([
            [
              account().id,
              {
                accountId: account().id,
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
      }),
    );

    function Host() {
      const [value, setValue] = useState('');
      return (
        <DaemonAccountPicker
          connection={laptop}
          id="fy-test-agent"
          label="Account"
          offerHealthCheck={true}
          onAccountChosen={() => undefined}
          onValueChange={setValue}
          store={store}
          usage={usage}
          value={value}
        />
      );
    }
    await show(<Host />);
    expect(probes).toBe(0);

    await press(checkButton());
    expect(probes).toBe(1);
    expect(healthStatusText()).toContain('1 account checked.');

    // The verdict reaches the ROWS through the same subscription, with no second
    // one anywhere: this is what the connected shape buys.
    await openList();
    expect(rowText(0)).toContain('healthy');
    expect(rowText(1)).toContain('unchecked');
  });

  /**
   * The probe checks the WHOLE fleet — that is the host's business and the button
   * says so. The completion count is a sentence about the list in front of the
   * reader, so a one-row Codex migration must never report the two Claude rows
   * that were also probed.
   */
  it('counts only the harness rows on screen, while still disclosing the whole-fleet cost', async () => {
    const store = new DaemonAccountPickerStore({
      catalog: async () => ({
        accounts: [account(), codex, account({ id: 'third', wrapper: 'claude-auto-three', home: '/h3' })],
      }),
      health: async () => ({
        // Every published account came back — three of them.
        health: new Map(
          [account().id, codex.id, 'third'].map(id => [
            id,
            { accountId: id, kind: 'claude' as const, state: 'healthy' as const, cached: false, checkedAt: 9, ms: 12 },
          ]),
        ),
        error: null,
      }),
    });
    await show(
      <DaemonAccountPicker
        connection={laptop}
        harness="codex"
        id="fy-test-agent"
        label="Account"
        offerHealthCheck={true}
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );

    // The cost disclosure stays whole-fleet, because that is what will happen.
    expect(root().textContent).toContain('starts each published account once');

    await press(checkButton());

    // One Codex row is offered, so exactly one is claimed — not three.
    expect(healthStatusText()).toContain('1 account checked.');
    expect(healthStatusText()).not.toContain('3 accounts');
    await openList();
    expect(rows()).toHaveLength(1);
    expect(rowText(0)).toContain('Atelier Codex');
    expect(rowText(0)).toContain('healthy');
  });

  it('keeps a refused probe out of the roster and says so without disabling anything', async () => {
    const store = new DaemonAccountPickerStore(
      catalogPort(async () => {
        throw new Error('the host refused the health check');
      }),
    );
    await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        offerHealthCheck={true}
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );

    await press(checkButton());

    expect(alertText()).toContain('the host refused the health check');
    await openList();
    expect(rowText(0)).toContain('unchecked');
    expect(input().hasAttribute('disabled')).toBeFalse();
  });

  it('shows the second daemon’s accounts and never the first one’s', async () => {
    const store = new DaemonAccountPickerStore(catalogPort());
    const mounted = await show(
      <DaemonAccountPicker
        connection={laptop}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();
    expect(rows()).toHaveLength(2);

    await mounted.render(
      <DaemonAccountPicker
        connection={workstation}
        id="fy-test-agent"
        label="Account"
        onValueChange={() => undefined}
        store={store}
        usage={usage}
        value=""
      />,
    );
    await openList();

    expect(rows()).toHaveLength(1);
    expect(rowText(0)).toContain('Archive Claude');
    expect(root().textContent).not.toContain('Studio Claude');
  });
});

describe('DaemonProjectPicker', () => {
  it('registers nothing, whatever a reader chooses or types', async () => {
    const sessions = [sessionView('s1', { config: { cwd: '/work/other' } })];
    const chosen: string[] = [];

    function Host() {
      const [value, setValue] = useState('');
      return (
        <DaemonProjectPicker
          catalog={projectPickerOptions([ferretry], sessions)}
          fleet={fleetSlice({ sessions })}
          id="fy-test-cwd"
          label="Project"
          onValueChange={next => {
            chosen.push(next);
            setValue(next);
          }}
          projects={projectsSlice({ projects: [ferretry] })}
          value={value}
        />
      );
    }
    await show(<Host />);
    await openList();

    await pressRow(1);
    expect(chosen).toEqual(['/work/other']);

    await type('/work/typed-by-hand');
    expect(input().value).toBe('/work/typed-by-hand');
    // Nothing here can register a folder: this field has no write port at all,
    // and the only thing it ever calls is its own `onValueChange`.
    expect(chosen).toEqual(['/work/other', '/work/typed-by-hand']);
  });
});
