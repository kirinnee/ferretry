import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  type RenameClientFactory,
  RenameSheet,
  type RenameSheetProps,
  renameErrorsFor,
  renamePatch,
} from '../../src/components/rename-sheet.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { mount } from '../support/dom.ts';
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

const source = (parent = 'lead'): SessionView =>
  sessionView('same-session', {
    config: { name: 'Original Task', teammate: 'original', ...(parent ? { parent } : {}) },
  });

const button = (root: ReactTestInstance, label: string): ReactTestInstance => {
  const match = root.findAll(node => node.type === 'button' && node.children.join('') === label).at(0);
  if (match === undefined) throw new Error(`missing button ${label}`);
  return match;
};

const fields = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAllByType('input').filter(input => input.props.type !== 'checkbox');

const field = (root: ReactTestInstance, index: number): ReactTestInstance => {
  const match = fields(root)[index];
  if (match === undefined) throw new Error(`missing rename field ${index}`);
  return match;
};

const change = (input: ReactTestInstance, value: string): void => {
  run(() => input.props.onChange({ target: { value } }));
};

const submit = async (root: ReactTestInstance): Promise<void> => {
  await runAsync(async () => {
    await root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
  });
};

describe('renamePatch', () => {
  it('normalises changed fields, detaches only a real child, and omits unchanged values', () => {
    expect(renamePatch(source(), ' Original Task ', ' ORIGINAL ', false)).toEqual({});
    expect(renamePatch(source(), '  Better Task  ', ' New-Name ', true)).toEqual({
      name: 'Better Task',
      teammate: 'new-name',
      clearParent: true,
    });
    expect(renamePatch(source(''), 'Original Task', 'original', true)).toEqual({});
  });

  it('places named daemon failures beside their field and leaves unknown failures at form level', () => {
    expect(renameErrorsFor(new Error('callsign already belongs to a teammate'))).toEqual({
      teammate: 'callsign already belongs to a teammate',
    });
    expect(renameErrorsFor(new Error('task title is too long'))).toEqual({ title: 'task title is too long' });
    expect(renameErrorsFor('daemon offline')).toEqual({ form: 'daemon offline' });
  });
});

describe('RenameSheet', () => {
  it('renders the original touch-safe form and hides detachment for a root session', () => {
    const view = render(
      <RenameSheet
        connection={daemonA}
        createClient={async () => ({ rename: async () => source('') })}
        onClose={() => undefined}
        open
        view={source('')}
      />,
    );

    expect(view.root.findByProps({ children: 'Rename session' })).toBeDefined();
    expect(fields(view.root).map(input => input.props.value)).toEqual(['Original Task', 'original']);
    expect(fields(view.root)[0]?.props.maxLength).toBe(120);
    expect(fields(view.root)[1]?.props.pattern).toBe('[a-z][a-z0-9-]*');
    expect(JSON.stringify(view.toJSON())).toContain('Convention: plain Title Case, up to 5 words.');
    expect(view.root.findAllByProps({ children: 'Detach from parent' })).toHaveLength(0);
    expect(button(view.root, 'Save changes').props.disabled).toBe(true);
  });

  it('renders nothing while initially closed', () => {
    const view = render(<RenameSheet connection={daemonA} onClose={() => undefined} open={false} view={source()} />);

    expect(view.toJSON()).toBeNull();
  });

  it('submits one normalised patch through the exact paired daemon and reports the updated view', async () => {
    const renamed = sessionView('same-session', { config: { name: 'Better Task', teammate: 'new-name' } });
    const factories: unknown[] = [];
    const calls: unknown[][] = [];
    const closed: number[] = [];
    const updates: SessionView[] = [];
    const createClient: RenameClientFactory = async connection => {
      factories.push(connection);
      return {
        rename: async (...args) => {
          calls.push(args);
          return renamed;
        },
      };
    };
    const view = render(
      <RenameSheet
        connection={daemonA}
        createClient={createClient}
        onClose={() => closed.push(1)}
        onRenamed={next => updates.push(next)}
        open
        view={source()}
      />,
    );

    change(field(view.root, 0), '  Better Task  ');
    change(field(view.root, 1), ' New-Name ');
    run(() => view.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
    await submit(view.root);

    expect(factories).toEqual([daemonA]);
    expect(calls).toEqual([['same-session', 'Better Task', 'new-name', true]]);
    expect(updates).toEqual([renamed]);
    expect(closed).toEqual([1]);
  });

  it('validates both required fields locally and clears each error as the reader repairs it', async () => {
    let calls = 0;
    const view = render(
      <RenameSheet
        connection={daemonA}
        createClient={async () => ({
          rename: async () => {
            calls += 1;
            return source();
          },
        })}
        onClose={() => undefined}
        open
        view={source()}
      />,
    );

    change(field(view.root, 0), '   ');
    await submit(view.root);
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('Task title cannot be empty.');

    change(field(view.root, 0), 'Repaired Task');
    change(field(view.root, 1), '   ');
    await submit(view.root);
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('Callsign cannot be empty.');

    change(field(view.root, 1), 'repaired');
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('shows an unclassified daemon refusal and unlocks the form for a successful retry', async () => {
    let attempts = 0;
    const view = render(
      <RenameSheet
        connection={daemonA}
        createClient={async () => ({
          rename: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('daemon offline');
            return source();
          },
        })}
        onClose={() => undefined}
        open
        view={source()}
      />,
    );
    change(field(view.root, 0), 'Retry Rename');

    await submit(view.root);
    expect(view.root.findByProps({ children: 'daemon offline' })).toBeDefined();
    expect(button(view.root, 'Save changes').props.disabled).toBe(false);
    await submit(view.root);

    expect(attempts).toBe(2);
  });

  it('locks duplicate submits and dismissal, then ignores a late response after a daemon switch', async () => {
    let resolveA: ((view: SessionView) => void) | undefined;
    const pendingA = new Promise<SessionView>(resolve => {
      resolveA = resolve;
    });
    const calls: string[] = [];
    const closed: string[] = [];
    const props = (overrides: Partial<RenameSheetProps> = {}): RenameSheetProps => ({
      connection: daemonA,
      createClient: async connection => ({
        rename: async () => {
          calls.push(connection.daemonId);
          return connection.daemonId === daemonA.daemonId ? pendingA : source();
        },
      }),
      onClose: () => closed.push('closed'),
      open: true,
      view: source(),
      ...overrides,
    });
    const view = render(<RenameSheet {...props()} />);
    change(field(view.root, 0), 'Daemon A Rename');

    run(() => {
      void view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
      void view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });
    });
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual(['daemon-a']);
    expect(view.root.findAllByProps({ 'aria-label': 'Close rename session' })[0]?.props.onClick()).toBeUndefined();
    expect(closed).toEqual([]);
    expect(JSON.stringify(view.toJSON())).toContain('Saving changes…');

    run(() => view.update(<RenameSheet {...props({ connection: daemonB })} />));
    expect(fields(view.root).map(input => input.props.value)).toEqual(['Original Task', 'original']);
    await runAsync(async () => {
      resolveA?.(source());
      await pendingA;
    });
    expect(closed).toEqual([]);

    change(field(view.root, 0), 'Daemon B Rename');
    await submit(view.root);
    expect(calls).toEqual(['daemon-a', 'daemon-b']);
    expect(closed).toEqual(['closed']);
  });

  it('shows the newly selected daemon session fields immediately when opening in the DOM', async () => {
    const next = source();
    const daemonBView = {
      ...next,
      config: { ...next.config, name: 'Daemon B Task', teammate: 'daemon-b' },
    } as SessionView;
    const mounted = await mount(
      <RenameSheet connection={daemonA} onClose={() => undefined} open={false} view={source()} />,
    );

    await mounted.render(<RenameSheet connection={daemonB} onClose={() => undefined} open view={daemonBView} />);

    expect(
      [...mounted.container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(
        input => input.value,
      ),
    ).toEqual(['Daemon B Task', 'daemon-b']);
    await mounted.unmount();
  });
});
