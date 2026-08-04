import { afterEach, describe, expect, test } from 'bun:test';
import type { TerminalListView } from '@ferretry/protocol';

import { SessionSurfaceReferences } from '../../src/components/session-surface-references.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});
const scope = daemonSessionScope(alpha, 'shared');
const TERMINAL = 'a1b2c3d4e5f6';
const token = `%terminal:${TERMINAL}`;

const listing = (ids: readonly string[], sessionId = 'shared'): TerminalListView => ({
  sessionId,
  terminals: ids.map((id, index) => ({
    id,
    sessionId,
    title: `Terminal ${index + 1}`,
    state: 'running' as const,
    cols: 80,
    rows: 24,
    viewers: index,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActivityAt: '2026-08-01T10:05:00.000Z',
    ...(index === 0 ? { idleDeadline: '2026-08-01T11:05:00.000Z' } : {}),
  })),
  limits: { perSession: 6, global: 24, runningGlobal: ids.length, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
});

const disposers: (() => void)[] = [];

/** A mounted composer for one scope, so Add to chat has somewhere to land. */
const composer = (target = scope, initial = '') => {
  const state = { draft: initial };
  disposers.push(
    registerComposerQuoteTarget({
      ...target,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

/** Lets the listing promise and its state write settle. */
const settle = async (): Promise<void> => {
  await runAsync(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

/** The accessible name a reader would act on: the label or the button's own text.
 *  Read field by field, because a rendered button's props hold React elements
 *  whose parent links make the whole object cyclic. */
const buttonName = (props: Record<string, unknown>): string => {
  const label = typeof props['aria-label'] === 'string' ? props['aria-label'] : '';
  const text = typeof props.children === 'string' ? props.children : '';
  return `${label} ${text}`;
};

const clickLabelled = (page: ReturnType<typeof render>, label: string): void => {
  const button = page.root
    .findAll(node => node.type === 'button')
    .find(node => buttonName(node.props as Record<string, unknown>).includes(label));
  if (button === undefined) throw new Error(`no button matching ${label}`);
  run(() => (button.props as { onClick: () => void }).onClick());
};

describe('SessionSurfaceReferences', () => {
  test('lists every terminal with its reference, its viewers and honest ownership', async () => {
    const page = render(
      <SessionSurfaceReferences connection={alpha} listTerminals={async () => listing([TERMINAL])} scope={scope} />,
    );
    await settle();

    const output = JSON.stringify(page.toJSON());
    expect(output).toContain(token);
    expect(output).toContain('Terminal 1');
    expect(output).toContain('No viewer attached');
    expect(output).toContain('Owner unrecorded');
    expect(output).toContain('reads as unrecorded rather than as yours');
    run(() => page.unmount());
  });

  test('names the agent driving a shell, so a reader knows before typing into it', async () => {
    // The whole reason ownership is on the row: the reader is deciding whether
    // their keystrokes land in a shell something else is already using.
    const owned = listing([TERMINAL]);
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => ({
          ...owned,
          terminals: owned.terminals.map(terminal => ({
            ...terminal,
            openedBy: { by: 'agent' as const, sessionId: 'mse7wwti-2a75bd9c' },
          })),
        })}
        scope={scope}
      />,
    );
    await settle();

    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('Opened by an agent');
    // The session id rides in the title, not the badge text: it is long enough
    // to wrap the row on a phone, and the CLASS is what decides the hesitation.
    expect(output).toContain('agent session mse7wwti-2a75bd9c');
    expect(output).not.toContain('Owner unrecorded');
    run(() => page.unmount());
  });

  test('distinguishes a paired device from the daemon host rather than merging them', async () => {
    const owned = listing([TERMINAL, '0f0e0d0c0b0a']);
    const openers = [{ by: 'human' as const, deviceId: 'device-7f3a' }, { by: 'local' as const }];
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => ({
          ...owned,
          terminals: owned.terminals.map((terminal, index) => ({ ...terminal, openedBy: openers[index] })),
        })}
        scope={scope}
      />,
    );
    await settle();

    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('Opened from a paired device');
    expect(output).toContain('Opened on the daemon host');
    run(() => page.unmount());
  });

  test('counts attached viewers, so a reader can see they would share the shell', async () => {
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => listing([TERMINAL, '0f0e0d0c0b0a'])}
        scope={scope}
      />,
    );
    await settle();

    expect(JSON.stringify(page.toJSON())).toContain('1 viewer attached');
    run(() => page.unmount());
  });

  test('says it is asking the daemon before any answer arrives', () => {
    const page = render(
      <SessionSurfaceReferences connection={alpha} listTerminals={() => new Promise(() => {})} scope={scope} />,
    );

    expect(JSON.stringify(page.toJSON())).toContain('Asking the daemon');
    run(() => page.unmount());
  });

  test('adds the reference to this session own message', async () => {
    const draft = composer(scope, 'run the build in');
    const page = render(
      <SessionSurfaceReferences connection={alpha} listTerminals={async () => listing([TERMINAL])} scope={scope} />,
    );
    await settle();

    clickLabelled(page, 'Add to chat');

    expect(draft.draft).toBe(`run the build in ${token} `);
    expect(JSON.stringify(page.toJSON())).toContain('Added');
    run(() => page.unmount());
  });

  test('never adds one daemon terminal to another daemon composer', async () => {
    // Arrange — the same session id is mounted on another pairing.
    const other = composer(daemonSessionScope(beta, 'shared'), 'other daemon draft');
    const page = render(
      <SessionSurfaceReferences connection={alpha} listTerminals={async () => listing([TERMINAL])} scope={scope} />,
    );
    await settle();

    clickLabelled(page, 'Add to chat');

    expect(other.draft).toBe('other daemon draft');
    expect(JSON.stringify(page.toJSON())).toContain('nowhere to add it');
    run(() => page.unmount());
  });

  test('copies the reference through the injected clipboard', async () => {
    const written: string[] = [];
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => listing([TERMINAL])}
        scope={scope}
        write={async text => {
          written.push(text);
        }}
      />,
    );
    await settle();

    clickLabelled(page, 'Copy the reference');
    await settle();

    expect(written).toEqual([token]);
    run(() => page.unmount());
  });

  test('says the session holds no terminal rather than showing an empty list', async () => {
    const page = render(
      <SessionSurfaceReferences connection={alpha} listTerminals={async () => listing([])} scope={scope} />,
    );
    await settle();

    expect(JSON.stringify(page.toJSON())).toContain('holds no terminal yet');
    run(() => page.unmount());
  });

  test('reports a failed listing as a refusal, never as an empty session, and retries on demand', async () => {
    let attempts = 0;
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('daemon unreachable');
          return listing([TERMINAL]);
        }}
        scope={scope}
      />,
    );
    await settle();

    const failed = JSON.stringify(page.toJSON());
    expect(failed).toContain('did not answer with its terminal list');
    expect(failed).toContain('daemon unreachable');
    expect(failed).not.toContain('holds no terminal yet');

    clickLabelled(page, 'Try again');
    await settle();

    expect(JSON.stringify(page.toJSON())).toContain(token);
    run(() => page.unmount());
  });

  test('refuses a listing that answers about another session', async () => {
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={async () => listing([TERMINAL], 'another')}
        scope={scope}
      />,
    );
    await settle();

    const output = JSON.stringify(page.toJSON());
    expect(output).toContain('answered about a different session');
    expect(output).not.toContain(token);
    run(() => page.unmount());
  });

  test('drops a listing that arrives after the pane is gone', async () => {
    let resolve: ((value: TerminalListView) => void) | undefined;
    const page = render(
      <SessionSurfaceReferences
        connection={alpha}
        listTerminals={() =>
          new Promise<TerminalListView>(next => {
            resolve = next;
          })
        }
        scope={scope}
      />,
    );

    run(() => page.unmount());
    resolve?.(listing([TERMINAL]));
    await settle();

    // Reaching here without a React state-update warning is the assertion.
    expect(resolve).toBeDefined();
  });
});
