import '../support/dom.ts';

import type { SessionView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  MigrateSheet,
  type MigrateSession,
  type MigrateSheetProps,
  migrateSessionWithDaemon,
} from '../../src/components/migrate-sheet.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
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
      migrateSessionWithDaemon(daemonA, scopeB, {
        agent: 'codex-auto-atomi',
        allowContextDowngrade: false,
      }),
    ).rejects.toThrow('migration scope must belong to the requested daemon');
  });
});

describe('MigrateSheet', () => {
  it('is inert while closed or read-only, and renders the daemon-owned safety contract when editable', () => {
    const view = render(<MigrateSheet {...props({ open: false })} />);
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
    const view = render(
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

    expect(calls).toEqual([[daemonA, scopeA, { agent: 'codex-auto-atomi', allowContextDowngrade: false }]]);
    expect(updates).toEqual([[daemonA, scopeA, migrated]]);
    expect(closes).toBe(1);
  });

  it('blocks an oversized conversation and a mismatched daemon/session scope before the RPC', () => {
    let calls = 0;
    const migrateSession: MigrateSession = async () => {
      calls += 1;
      return source();
    };
    const oversized = source();
    const view = render(
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
    const view = render(
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
    const view = render(
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
    const view = render(
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
    const view = render(
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
    const view = render(<MigrateSheet {...make()} />);
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
});
