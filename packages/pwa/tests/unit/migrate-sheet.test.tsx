import '../support/dom.ts';

import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactElement } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  type MigrateSession,
  MigrateSheet,
  type MigrateSheetProps,
  migrateSessionWithDaemon,
  migrationRequestKey,
} from '../../src/components/migrate-sheet.tsx';
import type { PickerAccount } from '../../src/lib/account-picker-catalog.ts';
import { type DaemonAccountPickerPort, DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.invalid',
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://daemon-b.invalid',
  deviceToken: 'token-b',
});
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');
const mountedViews: ReactTestRenderer[] = [];

const renderSheet = (element: ReactElement): ReactTestRenderer => {
  const view = render(element);
  mountedViews.push(view);
  return view;
};

afterEach(() => {
  run(() => {
    for (const view of mountedViews.splice(0)) view.unmount();
  });
});

const source = (status: SessionView['state']['status'] = 'running'): SessionView =>
  sessionView('same-session', {
    config: {
      agent: 'codex-auto-loge',
      harness: 'codex',
      model: 'gpt-5.6-sol[1m]',
      modelHint: 'gpt-5.6-sol[1m]',
    },
    state: { status, contextTokens: 120_000, contextWindow: 1_000_000 },
  });

const text = (node: ReactTestInstance): string =>
  node.children
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : text(child)))
    .join('');

const button = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const match = root.findAll(node => node.type === 'button' && text(node).includes(label)).at(0);
  if (match === undefined) throw new Error(`missing button ${label}`);
  return match;
};

const fields = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAllByType('input').filter(input => input.props.type !== 'checkbox');

const field = (root: ReactTestInstance, index: number): ReactTestInstance => {
  const match = fields(root)[index];
  if (match === undefined) throw new Error(`missing migration field ${index}`);
  return match;
};

const change = (input: ReactTestInstance, value: string): void => {
  run(() => input.props.onChange({ target: { value } }));
};

const review = (root: ReactTestInstance): void => {
  run(() => root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
};

const press = async (root: ReactTestInstance, label: string): Promise<void> => {
  await runAsync(async () => {
    await button(root, label).props.onClick();
  });
};

const props = (overrides: Partial<MigrateSheetProps> = {}): MigrateSheetProps => ({
  canMutate: true,
  connection: daemonA,
  migrateSession: async () => source(),
  onClose: () => undefined,
  onMigrated: () => undefined,
  open: true,
  scope: scopeA,
  view: source(),
  ...overrides,
});

describe('migrateSessionWithDaemon', () => {
  it('rejects a cross-daemon scope before constructing a typed client', async () => {
    await expect(
      migrateSessionWithDaemon(
        daemonA,
        scopeB,
        {
          agent: 'codex-auto-atomi',
          allowContextDowngrade: false,
        },
        'request-1',
      ),
    ).rejects.toThrow('migration scope must belong to the requested daemon');
  });

  it('forwards the whole target and the request id to the paired daemon client', async () => {
    const calls: unknown[][] = [];
    const migrated = await migrateSessionWithDaemon(
      daemonA,
      scopeA,
      { agent: 'codex-auto-atomi', model: 'gpt-5.6-sol[1m]', allowContextDowngrade: true },
      'request-7',
      async connection => {
        calls.push(['client', connection.daemonId]);
        return {
          migrate: async (...args: unknown[]) => {
            calls.push(args);
            return source();
          },
        } as never;
      },
    );

    expect(migrated.config.id).toBe('same-session');
    expect(calls).toEqual([
      ['client', 'daemon-a'],
      ['same-session', 'codex-auto-atomi', 'gpt-5.6-sol[1m]', true, 'request-7'],
    ]);
  });
});

describe('migrationRequestKey', () => {
  it('is stable for one target and distinct for every field a reader can change', () => {
    const target = { agent: 'codex-auto-atomi', model: 'gpt-5.6-sol', allowContextDowngrade: false } as const;
    expect(migrationRequestKey(scopeA, target)).toBe(migrationRequestKey(scopeA, { ...target }));
    expect(migrationRequestKey(scopeA, target)).not.toBe(
      migrationRequestKey(scopeA, { ...target, agent: 'codex-auto-loge' }),
    );
    expect(migrationRequestKey(scopeA, target)).not.toBe(migrationRequestKey(scopeA, { ...target, model: 'other' }));
    expect(migrationRequestKey(scopeA, target)).not.toBe(
      migrationRequestKey(scopeA, { ...target, allowContextDowngrade: true }),
    );
    // The account default is a real target, and must not collide with a named model.
    expect(migrationRequestKey(scopeA, { agent: target.agent, allowContextDowngrade: false })).not.toBe(
      migrationRequestKey(scopeA, target),
    );
    // Same session id on another paired daemon is a different migration.
    expect(migrationRequestKey(scopeA, target)).not.toBe(migrationRequestKey(scopeB, target));
  });
});

describe('MigrateSheet', () => {
  it('is inert while closed or read-only, and renders the daemon-owned safety contract when editable', () => {
    const view = renderSheet(<MigrateSheet {...props({ open: false })} />);
    expect(view.toJSON()).toBeNull();

    run(() => view.update(<MigrateSheet {...props({ canMutate: false })} />));
    expect(view.toJSON()).toBeNull();

    run(() => view.update(<MigrateSheet {...props()} />));
    expect(view.root.findByProps({ children: 'Change model or account' })).toBeDefined();
    expect(fields(view.root).map(input => input.props.value)).toEqual(['codex-auto-loge', 'gpt-5.6-sol[1m]']);
    expect(JSON.stringify(view.toJSON())).toContain('This public route has no force switch');
    expect(JSON.stringify(view.toJSON())).not.toContain('Force migration');
    expect(button(view.root, 'Review migration').props.disabled).toBe(true);
  });

  it('submits one normalised target through the exact connection and scope, then reports the authoritative view', async () => {
    const migrated = source('stopped');
    const calls: unknown[][] = [];
    const updates: unknown[][] = [];
    let closes = 0;
    const migrateSession: MigrateSession = async (...args) => {
      calls.push(args);
      return migrated;
    };
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession,
          onClose: () => {
            closes += 1;
          },
          onMigrated: (...args) => updates.push(args),
          view: source('stopped'),
        })}
      />,
    );

    change(field(view.root, 0), '  codex-auto-atomi  ');
    change(field(view.root, 1), '   ');
    review(view.root);
    expect(button(view.root, 'Relaunch on selected runtime')).toBeDefined();
    await press(view.root, 'Relaunch on selected runtime');

    expect(calls.map(call => call.slice(0, 3))).toEqual([
      [daemonA, scopeA, { agent: 'codex-auto-atomi', allowContextDowngrade: false }],
    ]);
    expect(typeof calls[0]?.[3]).toBe('string');
    expect(updates).toEqual([[daemonA, scopeA, migrated]]);
    expect(closes).toBe(1);
  });

  it('allows an explicitly selected model to be cleared for the same account default', async () => {
    const calls: unknown[][] = [];
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession: async (...args) => {
            calls.push(args);
            return source('stopped');
          },
          view: source('stopped'),
        })}
      />,
    );

    change(field(view.root, 1), '   ');
    expect(button(view.root, 'Review migration').props.disabled).toBe(false);
    review(view.root);
    await press(view.root, 'Relaunch on selected runtime');

    expect(calls.map(call => call.slice(0, 3))).toEqual([
      [daemonA, scopeA, { agent: 'codex-auto-loge', allowContextDowngrade: false }],
    ]);
  });

  it('blocks an oversized conversation and a mismatched daemon/session scope before the RPC', () => {
    let calls = 0;
    const migrateSession: MigrateSession = async () => {
      calls += 1;
      return source();
    };
    const oversized = source();
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession,
          view: {
            ...oversized,
            state: { ...oversized.state, contextTokens: 300_000 },
          },
        })}
      />,
    );
    change(field(view.root, 0), 'codex-auto-atomi');
    change(field(view.root, 1), 'gpt-5.6-terra');

    expect(view.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(button(view.root, 'Review migration').props.disabled).toBe(true);

    run(() => view.update(<MigrateSheet {...props({ migrateSession, scope: scopeB })} />));
    change(field(view.root, 0), 'codex-auto-atomi');
    expect(text(view.root.findByProps({ role: 'alert' }))).toContain('does not belong to the selected daemon');
    expect(button(view.root, 'Review migration').props.disabled).toBe(true);
    expect(calls).toBe(0);
  });

  it('requires a second explicit action before accepting a daemon-confirmed context downgrade', async () => {
    const calls: unknown[][] = [];
    const migrated = source();
    const migrateSession: MigrateSession = async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        throw new FyHttpError(
          'codex-auto-atomi serves gpt-5.6-terra with a 200000-token window and this session is running in 1000000',
          409,
          'context_downgrade_refused',
        );
      }
      return migrated;
    };
    const updates: SessionView[] = [];
    const view = renderSheet(
      <MigrateSheet {...props({ migrateSession, onMigrated: (_connection, _scope, next) => updates.push(next) })} />,
    );
    change(field(view.root, 0), 'codex-auto-atomi');
    change(field(view.root, 1), 'gpt-5.6-terra');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');

    expect(view.root.findByProps({ children: 'The daemon refused a smaller context window' })).toBeDefined();
    expect(button(view.root, 'Migrate with smaller window').props.disabled).toBe(true);
    await press(view.root, 'Migrate with smaller window');
    expect(calls).toHaveLength(1);

    run(() => view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
    await press(view.root, 'Migrate with smaller window');

    expect(calls.map(call => call[2])).toEqual([
      { agent: 'codex-auto-atomi', model: 'gpt-5.6-terra', allowContextDowngrade: false },
      { agent: 'codex-auto-atomi', model: 'gpt-5.6-terra', allowContextDowngrade: true },
    ]);
    expect(updates).toEqual([migrated]);
  });

  it('offers the daemon-suggested 1M model without silently accepting a downgrade', async () => {
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession: async () => {
            throw new FyHttpError(
              'codex-auto-atomi serves gpt-5.6-terra with a 200000-token window',
              409,
              'context_downgrade_refused',
            );
          },
        })}
      />,
    );
    change(field(view.root, 0), 'codex-auto-atomi');
    change(field(view.root, 1), 'gpt-5.6-terra');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');
    await press(view.root, 'Use gpt-5.6-terra[1m] instead');

    expect(field(view.root, 1).props.value).toBe('gpt-5.6-terra[1m]');
    expect(view.root.findByType('form')).toBeDefined();
  });

  it('renders the full preflight inventory, exposes no force bypass, and retries only through the daemon gate', async () => {
    let attempts = 0;
    const message =
      'open tool work is not safe to interrupt\nin-flight inventory — status tool_running, turn 4, worst: UNKNOWN\n  blind [UNKNOWN] open tool call-7 has no transcript';
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession: async () => {
            attempts += 1;
            if (attempts === 1) throw new FyHttpError(message, 409, 'migration_refused');
            return source();
          },
        })}
      />,
    );
    change(field(view.root, 0), 'codex-auto-atomi');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');

    expect(text(view.root.findByType('pre'))).toBe(message);
    expect(JSON.stringify(view.toJSON())).toContain('There is no force control');
    expect(JSON.stringify(view.toJSON())).not.toContain('Force migration');
    await press(view.root, 'Retry safety check');
    expect(attempts).toBe(2);
  });

  it('keeps an actionable typed failure in confirmation and lets the reader return to edit', async () => {
    const view = renderSheet(
      <MigrateSheet
        {...props({
          migrateSession: async () => {
            throw new FyHttpError('no account named missing', 404, 'unknown_agent');
          },
        })}
      />,
    );
    change(field(view.root, 0), 'missing');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');

    expect(view.root.findByProps({ children: 'Unknown target account' })).toBeDefined();
    expect(JSON.stringify(view.toJSON())).toContain('no account named missing');
    await press(view.root, 'Back');
    expect(view.root.findByType('form')).toBeDefined();
  });

  it('locks duplicate submits and dismissal, then ignores a late response from the previous daemon', async () => {
    let resolveA: ((view: SessionView) => void) | undefined;
    const pendingA = new Promise<SessionView>(resolve => {
      resolveA = resolve;
    });
    const calls: string[] = [];
    const updates: string[] = [];
    const closes: string[] = [];
    const migrateSession: MigrateSession = async connection => {
      calls.push(connection.daemonId);
      return connection.daemonId === daemonA.daemonId ? pendingA : source();
    };
    const make = (overrides: Partial<MigrateSheetProps> = {}): MigrateSheetProps =>
      props({
        migrateSession,
        onClose: () => closes.push('closed'),
        onMigrated: connection => updates.push(connection.daemonId),
        ...overrides,
      });
    const view = renderSheet(<MigrateSheet {...make()} />);
    change(field(view.root, 0), 'codex-auto-atomi');
    review(view.root);
    const action = button(view.root, 'Migrate and relaunch');

    run(() => {
      void action.props.onClick();
      void action.props.onClick();
    });
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual(['daemon-a']);
    expect(JSON.stringify(view.toJSON())).toContain('Keep this sheet open');
    run(() => view.root.findAllByProps({ 'aria-label': 'Close change model or account' })[0]?.props.onClick());
    expect(closes).toEqual([]);

    run(() => view.update(<MigrateSheet {...make({ connection: daemonB, scope: scopeB })} />));
    expect(fields(view.root).map(input => input.props.value)).toEqual(['codex-auto-loge', 'gpt-5.6-sol[1m]']);
    await runAsync(async () => {
      resolveA?.(source());
      await pendingA;
    });
    expect(updates).toEqual([]);
    expect(closes).toEqual([]);

    change(field(view.root, 0), 'codex-auto-atomi');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');
    expect(calls).toEqual(['daemon-a', 'daemon-b']);
    expect(updates).toEqual(['daemon-b']);
    expect(closes).toEqual(['closed']);
  });

  it('shows the newly selected daemon session fields immediately when opening in the DOM', async () => {
    const next = source('stopped');
    const daemonBView = {
      ...next,
      config: {
        ...next.config,
        agent: 'claude-auto-loge',
        harness: 'claude',
        model: 'claude-opus-5',
        modelHint: 'claude-opus-5',
      },
    } as SessionView;
    const mounted = await mount(<MigrateSheet {...props({ open: false })} />);

    await mounted.render(
      <MigrateSheet {...props({ connection: daemonB, open: true, scope: scopeB, view: daemonBView })} />,
    );

    expect(
      [...mounted.container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(
        input => input.value,
      ),
    ).toEqual(['claude-auto-loge', 'claude-opus-5']);
    await mounted.unmount();
  });

  it('marks the safety statements as a real list, so they do not read as one paragraph', () => {
    const view = renderSheet(<MigrateSheet {...props()} />);
    // The CSS preflight clears `list-style` on every `ul`, so the class has to be explicit.
    expect(view.root.findByType('ul').props.className).toContain('list-disc');
  });

  it('warns when the target account is on a restricted routing tier', () => {
    const restricted = source();
    const view = renderSheet(
      <MigrateSheet {...props({ view: { ...restricted, config: { ...restricted.config, agent: 'claude-glm52' } } })} />,
    );
    expect(JSON.stringify(view.toJSON())).toContain('Restricted tier');
  });

  it('reuses one request id for a repeated confirmation of the same target, and mints a new one when it changes', async () => {
    // A migration is destructive and the typed client retries its POST, so a second confirmation of
    // the SAME target must be the same operation to the daemon — while a changed target must not be.
    const seen: Array<{ agent: string; requestId: string }> = [];
    const migrateSession: MigrateSession = async (_connection, _scope, input, requestId) => {
      seen.push({ agent: input.agent, requestId });
      throw new FyHttpError('in-flight work refuses this migration', 409, 'migration_refused');
    };
    const view = renderSheet(<MigrateSheet {...props({ migrateSession })} />);

    change(field(view.root, 0), 'codex-auto-atomi');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');
    await press(view.root, 'Retry safety check');

    // Same target, so the retry is the same logical migration.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.requestId).toBe(seen[1]?.requestId);

    // A different target is a different decision and must not inherit the id.
    await press(view.root, 'Back');
    change(field(view.root, 0), 'codex-auto-other');
    review(view.root);
    await press(view.root, 'Migrate and relaunch');
    expect(seen).toHaveLength(3);
    expect(seen[2]?.agent).toBe('codex-auto-other');
    expect(seen[2]?.requestId).not.toBe(seen[0]?.requestId);
  });
});

// ─── the connected account field ─────────────────────────────────────────────

/**
 * These run against a real document rather than the renderer tree above,
 * because the thing under test is a combobox: focus reveals its list, a pointer
 * pair chooses a row, and a disabled row's refusal is a pointer fact. None of
 * that is visible to a shallow tree.
 *
 * The fixtures deliberately include one account of the OTHER CLI, one that the
 * host says is unavailable, and one wrapper with no quota row, because each is
 * a separate claim this field must not make: no cross-CLI target, no hidden
 * unavailable account, no 0 % invented out of a missing reading.
 */

const pickerAccount = (overrides: Partial<PickerAccount> = {}): PickerAccount => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'codex',
  mode: 'auto',
  wrapper: 'codex-auto-loge',
  home: '/homes/codex-auto-loge',
  displayName: 'Loge Codex',
  defaultModel: 'gpt-5.6-sol[1m]',
  models: [{ id: 'gpt-5.6-sol[1m]', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const atomi = pickerAccount({
  id: '22222222-2222-4222-8222-222222222222',
  wrapper: 'codex-auto-atomi',
  home: '/homes/codex-auto-atomi',
  displayName: 'Atomi Codex',
  defaultModel: 'gpt-5.6-terra',
  models: [
    { id: 'gpt-5.6-terra', available: true },
    { id: 'gpt-5.6-sol', available: true },
    { id: 'gpt-5.5-legacy', available: false, unavailableReason: 'withdrawn from this account' },
  ],
});

const archived = pickerAccount({
  id: '33333333-3333-4333-8333-333333333333',
  wrapper: 'codex-auto-archive',
  home: '/homes/codex-auto-archive',
  displayName: 'Archive Codex',
  defaultModel: null,
  models: [],
  available: false,
  unavailableReason: 'this host has no such executable on its PATH',
});

const otherHarness = pickerAccount({
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'claude',
  wrapper: 'claude-auto-loge',
  home: '/homes/claude-auto-loge',
  displayName: 'Loge Claude',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5', available: true }],
});

const ROSTER: readonly PickerAccount[] = [pickerAccount(), atomi, archived, otherHarness];

/** Only the current wrapper has a reading, so the others prove "unknown ≠ 0 %". */
const QUOTA_FEED = {
  stale: false,
  accounts: [{ agent: 'codex-auto-loge', fiveHourPercent: 37, weeklyPercent: 61, atLimit: false, authOk: true }],
};

interface Roster {
  readonly port: DaemonAccountPickerPort;
  /**
   * How many times the COLLECTING check has run.
   *
   * It used to count the "expensive live probe", because reading health launched every account's agent
   * and asked a model for a sentinel. That probe is deleted: the read is a free stored snapshot the
   * sheet hydrates on open, and only the control below reaches the collection. So this counts the
   * collection, which is where the property lives now.
   */
  probes(): number;
}

const roster = (catalog: DaemonAccountPickerPort['catalog'] = async () => ({ accounts: ROSTER })): Roster => {
  let probes = 0;
  const snapshot = {
    health: new Map([
      [
        atomi.id,
        {
          accountId: atomi.id,
          kind: 'codex' as const,
          verdict: 'healthy' as const,
          reason: 'provider_accepted' as const,
          evidence: 'anthropic_usage' as const,
          lastCheckedAt: 1,
          verdictAt: 1,
          lastCheckInconclusive: false,
        },
      ],
    ]),
    error: null,
  };
  return {
    port: {
      catalog,
      // Free, and answered on open. It records nothing, so it is not counted.
      health: async () => snapshot,
      checkHealth: async () => {
        probes += 1;
        return snapshot;
      },
    },
    probes: () => probes,
  };
};

const quotaStore = (feed: unknown = QUOTA_FEED): DaemonUsageStore =>
  // The visibility gate is pinned shut so the shared poll can never fire a
  // second read mid-assertion; the sheet's own first read is unconditional.
  new DaemonUsageStore({ usage: async () => feed }, { isHidden: () => true });

describe('MigrateSheet account picker', () => {
  let live: Mounted | undefined;

  afterEach(async () => {
    await live?.unmount();
    live = undefined;
  });

  const showSheet = async (element: ReactElement): Promise<void> => {
    live = await mount(element);
  };

  const container = (): HTMLElement => must(live, 'a mounted migrate sheet').container;

  const combobox = (): HTMLInputElement => {
    const node = container().querySelector('input[role="combobox"]');
    if (!(node instanceof HTMLInputElement)) throw new Error('the account picker is not mounted');
    return node;
  };

  const modelField = (): HTMLInputElement => {
    const node = container().querySelectorAll('input:not([type="checkbox"])')[1];
    if (!(node instanceof HTMLInputElement)) throw new Error('the model field is not mounted');
    return node;
  };

  /** What the MODEL box offers — never what it holds. */
  const datalist = (): readonly (string | null)[] =>
    [...container().querySelectorAll('datalist option')].map(option => option.getAttribute('value'));

  /** Focus is what reveals the list, exactly as a reader's tap or Tab does. */
  const openRoster = async (): Promise<void> => {
    await interact(() => combobox().focus());
  };

  const rows = (): readonly Element[] => [...container().querySelectorAll('[role="option"]')];

  const rowText = (index: number): string => must(rows()[index], `row ${index}`).textContent ?? '';

  const panelState = (): string | null =>
    container().querySelector('[data-picker-state]')?.getAttribute('data-picker-state') ?? null;

  const typeWrapper = async (value: string): Promise<void> => {
    const input = combobox();
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const chooseRow = async (index: number): Promise<void> => {
    const row = must(rows()[index], `row ${index}`);
    await interact(() => {
      for (const kind of ['pointerdown', 'pointerup']) {
        const event = new Event(kind, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 7 });
        row.dispatchEvent(event);
      }
    });
  };

  const control = (label: string): HTMLButtonElement =>
    must(
      [...container().querySelectorAll('button')].find(node => (node.textContent ?? '').includes(label)),
      `the ${label} button`,
    );

  const pressControl = async (label: string): Promise<void> => {
    await interact(() => control(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  };

  const submitForm = async (): Promise<void> => {
    const form = must(container().querySelector('form'), 'the migration form');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };

  const recorder = (): { readonly calls: unknown[][]; readonly migrateSession: MigrateSession } => {
    const calls: unknown[][] = [];
    return {
      calls,
      migrateSession: async (...args) => {
        calls.push(args);
        return source('stopped');
      },
    };
  };

  it('sanitizes the useId-derived picker id so a CSS selector against it never throws', async () => {
    await showSheet(
      <MigrateSheet {...props({ accountPicker: new DaemonAccountPickerStore(roster().port), usage: quotaStore() })} />,
    );

    const id = combobox().id;

    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(container().querySelector(`#${id}`)).toBe(combobox());
  });

  it('offers only this daemon’s same-CLI accounts, and never a row from the other one', async () => {
    await showSheet(
      <MigrateSheet {...props({ accountPicker: new DaemonAccountPickerStore(roster().port), usage: quotaStore() })} />,
    );
    await openRoster();
    // The typed value doubles as the query, so clearing it is what asks for the
    // whole published roster rather than the row already in the box.
    await typeWrapper('');

    expect(rows()).toHaveLength(3);
    expect(rows().map(row => row.textContent)).toEqual([
      expect.stringContaining('Loge Codex'),
      expect.stringContaining('Atomi Codex'),
      expect.stringContaining('Archive Codex'),
    ]);
    expect(container().textContent).not.toContain('Loge Claude');
    expect(container().textContent).not.toContain('claude-auto-loge');
  });

  it('carries a chosen account through review into the migration, and pins no model of its own', async () => {
    const { calls, migrateSession } = recorder();
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(roster().port),
          migrateSession,
          usage: quotaStore(),
          view: source('stopped'),
        })}
      />,
    );
    await openRoster();
    await typeWrapper('atomi');
    await chooseRow(0);

    expect(combobox().value).toBe('codex-auto-atomi');
    // Atomi's own default is gpt-5.6-terra. Choosing the account must leave the
    // session's current model exactly where it was.
    expect(modelField().value).toBe('gpt-5.6-sol[1m]');

    await submitForm();
    await pressControl('Relaunch on selected runtime');

    expect(calls.map(call => call.slice(0, 3))).toEqual([
      [daemonA, scopeA, { agent: 'codex-auto-atomi', model: 'gpt-5.6-sol[1m]', allowContextDowngrade: false }],
    ]);
  });

  it('keeps migrating a typed wrapper when the roster read fails outright', async () => {
    const { calls, migrateSession } = recorder();
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(
            roster(async () => {
              throw new Error('the account manifest could not be read');
            }).port,
          ),
          migrateSession,
          usage: quotaStore(),
          view: source('stopped'),
        })}
      />,
    );
    await openRoster();

    expect(panelState()).toBe('failed');
    expect(container().textContent).toContain('the account manifest could not be read');
    expect(container().textContent).toContain('This field still accepts a typed value.');

    await typeWrapper('codex-auto-unpublished');
    await submitForm();
    await pressControl('Relaunch on selected runtime');

    expect(calls.map(call => call[2])).toEqual([
      { agent: 'codex-auto-unpublished', model: 'gpt-5.6-sol[1m]', allowContextDowngrade: false },
    ]);
  });

  it('refuses to select an unavailable account while leaving its wrapper typeable', async () => {
    const { calls, migrateSession } = recorder();
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(roster().port),
          migrateSession,
          usage: quotaStore(),
          view: source('stopped'),
        })}
      />,
    );
    await openRoster();
    await typeWrapper('archive');

    expect(rows()).toHaveLength(1);
    expect(must(rows()[0], 'the archived row').getAttribute('aria-disabled')).toBe('true');
    expect(rowText(0)).toContain('this host has no such executable on its PATH');

    await chooseRow(0);
    expect(combobox().value).toBe('archive');

    // The daemon, not this browser, is the thing that refuses a launch.
    await typeWrapper('codex-auto-archive');
    await submitForm();
    await pressControl('Relaunch on selected runtime');

    expect(calls.map(call => call[2])).toEqual([
      { agent: 'codex-auto-archive', model: 'gpt-5.6-sol[1m]', allowContextDowngrade: false },
    ]);
  });

  it('leaves Review disabled when the account chosen is the one already running', async () => {
    await showSheet(
      <MigrateSheet {...props({ accountPicker: new DaemonAccountPickerStore(roster().port), usage: quotaStore() })} />,
    );
    await openRoster();
    await typeWrapper('');
    await chooseRow(0);

    expect(combobox().value).toBe('codex-auto-loge');
    expect(control('Review migration').disabled).toBeTrue();
  });

  it('offers the chosen account’s available models as suggestions without writing one', async () => {
    const { calls, migrateSession } = recorder();
    const blank = source('stopped');
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(roster().port),
          migrateSession,
          usage: quotaStore(),
          view: { ...blank, config: { ...blank.config, model: '', modelHint: '' } } as SessionView,
        })}
      />,
    );
    await openRoster();
    await typeWrapper('atomi');
    await chooseRow(0);

    expect(modelField().value).toBe('');
    expect(datalist()).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);

    await submitForm();
    await pressControl('Relaunch on selected runtime');

    // Blank stays blank: the daemon resolves the account's own default.
    expect(calls.map(call => call[2])).toEqual([{ agent: 'codex-auto-atomi', allowContextDowngrade: false }]);
  });

  it('drops the previous account’s suggestions as soon as the wrapper is typed over', async () => {
    const blank = source('stopped');
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(roster().port),
          usage: quotaStore(),
          view: { ...blank, config: { ...blank.config, model: '', modelHint: '' } } as SessionView,
        })}
      />,
    );
    await openRoster();
    await typeWrapper('atomi');
    await chooseRow(0);
    await typeWrapper('codex-auto-elsewhere');

    expect(datalist()).toEqual([]);
  });

  it('drops the chosen account’s suggestions when the same daemon id is re-paired underneath', async () => {
    // The leak this pins: a re-pair keeps `daemonId`, the session and the typed
    // wrapper, so the reset effect correctly does not fire — while everything
    // the browser proved about the host has expired. The roster is fenced off by
    // `sameDaemonConnection`; the suggestions taken off one of its rows must go
    // with it, rather than describing the new pairing on the old one's word.
    const blank = source('stopped');
    const view = { ...blank, config: { ...blank.config, model: '', modelHint: '' } } as SessionView;
    const store = new DaemonAccountPickerStore(roster().port);
    const usage = quotaStore();
    await showSheet(<MigrateSheet {...props({ accountPicker: store, usage, view })} />);
    await openRoster();
    await typeWrapper('atomi');
    await chooseRow(0);

    expect(datalist()).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol']);

    const rotated = daemonConnection({
      daemonId: daemonA.daemonId,
      baseUrl: daemonA.baseUrl,
      deviceToken: 'token-a-rotated',
    });
    await must(live, 'a mounted migrate sheet').render(
      <MigrateSheet {...props({ accountPicker: store, connection: rotated, usage, view })} />,
    );

    // Nothing else moved: same session, same typed wrapper, no new choice made.
    expect(combobox().value).toBe('codex-auto-atomi');
    expect(datalist()).toEqual([]);
  });

  /**
   * OPENING THE SHEET SHOWS THE STORED VERDICTS AND COLLECTS NOTHING.
   *
   * It used to assert no health call at all, because a health read on open would have started every
   * account's agent on a host the reader is not sitting at. The read is now free, so the sheet shows
   * the verdicts immediately and only the control reaches the collection.
   *
   * WHAT THIS CANNOT PROVE: it counts port calls. It cannot see a process spawn, so it is not the
   * guard against a spend regression — `packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts`
   * ("what an unattended fleet pass may spend") is, because it boots a real `fyd`.
   */
  it('shows the stored verdicts on open and collects only when the check is pressed', async () => {
    const probe = roster();
    await showSheet(
      <MigrateSheet {...props({ accountPicker: new DaemonAccountPickerStore(probe.port), usage: quotaStore() })} />,
    );
    await openRoster();
    await typeWrapper('');

    expect(rows()).toHaveLength(3);
    expect(probe.probes()).toBe(0);

    await pressControl('Check now');

    expect(probe.probes()).toBe(1);
    expect(must(container().querySelector('[data-picker-health]'), 'the health block').textContent).toContain(
      '1 account checked',
    );
  });

  it('renders a wrapper with no cached reading as unknown rather than as zero percent', async () => {
    await showSheet(
      <MigrateSheet {...props({ accountPicker: new DaemonAccountPickerStore(roster().port), usage: quotaStore() })} />,
    );
    await openRoster();
    await typeWrapper('');

    expect(rowText(0)).toContain('5h 37%');
    expect(rowText(1)).toContain('quota —');
    expect(rowText(1)).not.toContain('0%');
  });

  it('says the quota feed failed beside the rows instead of failing the roster with it', async () => {
    await showSheet(
      <MigrateSheet
        {...props({
          accountPicker: new DaemonAccountPickerStore(roster().port),
          usage: quotaStore({ stale: 'not a feed' }),
        })}
      />,
    );
    await openRoster();
    await typeWrapper('');

    expect(rows()).toHaveLength(3);
    expect(must(container().querySelector('[data-picker-advisory]'), 'the quota advisory').textContent).toContain(
      'the daemon returned an account feed this client cannot read',
    );
  });

  it('shows no frame of the previous daemon’s accounts after the sheet switches daemon', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonAccountPickerStore(
      roster(async daemon => {
        if (daemon.daemonId === daemonA.daemonId) return { accounts: ROSTER };
        await gate;
        return { accounts: [] };
      }).port,
    );
    const usage = quotaStore();
    await showSheet(<MigrateSheet {...props({ accountPicker: store, usage })} />);
    await openRoster();
    await typeWrapper('');
    expect(rowText(1)).toContain('Atomi Codex');

    const remote = source();
    await must(live, 'a mounted migrate sheet').render(
      <MigrateSheet
        {...props({
          accountPicker: store,
          connection: daemonB,
          scope: scopeB,
          usage,
          view: { ...remote, config: { ...remote.config, agent: 'codex-auto-remote' } } as SessionView,
        })}
      />,
    );
    await openRoster();

    expect(combobox().value).toBe('codex-auto-remote');
    expect(panelState()).toBe('loading');
    expect(rows()).toHaveLength(0);
    expect(container().textContent).not.toContain('Atomi Codex');

    await interact(async () => {
      release();
      await gate;
    });
  });
});
