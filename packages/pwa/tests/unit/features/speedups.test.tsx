import { describe, expect, it } from 'bun:test';
import type { SpeedupStatus, SpeedupsView, SpeedupTestResult } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import { readSpeedups, testSpeedup } from '../../../src/features/speedups/speedups-api.ts';
import {
  keyDraftProblem,
  lastTestLine,
  SPEEDUPS_FALLBACK,
  SPEEDUPS_INTRO,
  SpeedupCard,
  SpeedupsPanel,
  SpeedupsSurface,
  speedupsSettingsTab,
  withTestResult,
} from '../../../src/features/speedups/speedups-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { configChangeHarness } from '../config-change-support.tsx';

const AT = '2026-10-16T10:00:00.000Z';
const KEY = 'gsk-test-0123456789abcdef';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const status = (overrides: Partial<SpeedupStatus> = {}): SpeedupStatus => ({
  provider: 'groq',
  label: 'Groq',
  purpose: 'Cleans up dictated text.',
  costNote: 'Well under a cent.',
  privacyNote: 'Text goes to Groq; audio never leaves.',
  keyUrl: 'https://console.groq.com/keys',
  testNote: 'Test lists models. Free.',
  secretName: 'GROQ_API_KEY',
  set: false,
  testStale: false,
  ...overrides,
});

const result = (overrides: Partial<SpeedupTestResult> = {}): SpeedupTestResult => ({
  provider: 'groq',
  secretName: 'GROQ_API_KEY',
  ok: true,
  code: 'ok',
  message: 'The key works.',
  latencyMs: 149.6,
  at: AT,
  ...overrides,
});

const view = (overrides: Partial<SpeedupsView> = {}): SpeedupsView => ({
  providers: [status({ provider: 'jev', label: 'Jev', secretName: 'JEV_API_KEY' }), status()],
  vault: 'ok',
  ...overrides,
});

const text = (node: unknown): string => JSON.stringify(node);

const buttonLabelled = (root: ReactTestInstance, label: string): ReactTestInstance =>
  root.find(node => node.type === 'button' && node.props['aria-label'] === label);

const submitButton = (root: ReactTestInstance): ReactTestInstance =>
  root.find(node => node.type === 'button' && node.props.type === 'submit');

const noop = () => undefined;

describe('speed-ups api', () => {
  it('reads the status and posts one provider’s Test, with no key on either', async () => {
    // Arrange
    const calls: unknown[] = [];
    const client = {
      request: async (
        path: string,
        schema: { parse: (value: unknown) => unknown },
        init?: RequestInit,
        timeout?: number,
      ) => {
        calls.push([path, init?.method ?? 'GET', init?.body, timeout]);
        return schema.parse(
          path === '/v1/speedups' ? view() : result({ provider: 'cerebras', secretName: 'CEREBRAS_API_KEY' }),
        );
      },
    } as never;

    // Act
    const read = await readSpeedups(client);
    const tested = await testSpeedup(client, 'cerebras');

    // Assert
    expect(read.providers).toHaveLength(2);
    expect(tested.provider).toBe('cerebras');
    expect(calls).toEqual([
      ['/v1/speedups', 'GET', undefined, undefined],
      ['/v1/speedups/cerebras/test', 'POST', undefined, 15_000],
    ]);
  });
});

describe('speed-up helpers', () => {
  it('describes the last test, with timing and staleness', () => {
    expect(lastTestLine(status())).toBeUndefined();
    expect(lastTestLine(status({ lastTest: result() }))).toBe('Worked 2026-10-16 10:00 · 150 ms. The key works.');
    expect(
      lastTestLine(
        status({
          lastTest: result({ ok: false, code: 'rejected', message: 'Refused.', latencyMs: undefined }),
          testStale: true,
        }),
      ),
    ).toBe('Failed 2026-10-16 10:00. Refused. The key has changed since — test again.');
  });

  it('flags a pasted key that is too short, and nothing else', () => {
    expect(keyDraftProblem('')).toBeUndefined();
    expect(keyDraftProblem('short')).toContain('too short');
    expect(keyDraftProblem(KEY)).toBeUndefined();
  });

  it('merges one Test into the view, clearing staleness for that provider only', () => {
    const before = view({ providers: [status({ provider: 'jev', testStale: true }), status({ testStale: true })] });
    const after = withTestResult(before, result());
    expect(after.providers[0]?.testStale).toBe(true);
    expect(after.providers[1]).toMatchObject({ testStale: false, lastTest: result() });
  });
});

describe('SpeedupCard', () => {
  it('shows purpose, cost, privacy and the key address as text AND a link', () => {
    const renderer = render(
      <SpeedupCard status={status()} vaultReadable busy={null} error={null} onSave={noop} onTest={noop} />,
    );
    const rendered = text(renderer.toJSON());
    for (const copy of [
      'Cleans up dictated text.',
      'Well under a cent.',
      'audio never leaves',
      'Not set',
      'GROQ_API_KEY',
    ])
      expect(rendered).toContain(copy);
    const link = renderer.root.findByType('a');
    expect(link.props.href).toBe('https://console.groq.com/keys');
    expect(link.props.rel).toContain('noopener');
    expect(link.children).toContain('https://console.groq.com/keys');
    // Nothing to test until a key is set.
    expect(buttonLabelled(renderer.root, 'Test the Groq key').props.disabled).toBe(true);
  });

  it('saves a pasted key once, then clears the field', async () => {
    // Arrange
    const saved: string[] = [];
    const renderer = render(
      <SpeedupCard
        status={status()}
        vaultReadable
        busy={null}
        error={null}
        onSave={value => void saved.push(value)}
        onTest={noop}
      />,
    );
    const input = renderer.root.findByType('input');
    expect(input.props.type).toBe('password');
    expect(input.props.autoComplete).toBe('new-password');

    // Act — too short first, then whole.
    run(() => input.props.onChange({ target: { value: 'abc' } }));
    expect(text(renderer.toJSON())).toContain('too short');
    expect(submitButton(renderer.root).props.disabled).toBe(true);
    run(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: noop }));
    run(() => input.props.onChange({ target: { value: `  ${KEY}  ` } }));
    await runAsync(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: noop });
    });

    // Assert
    expect(saved).toEqual([KEY]);
    expect(renderer.root.findByType('input').props.value).toBe('');
  });

  it('offers Replace and Test for a set key, and cancels a replacement', () => {
    // Arrange
    const tests: string[] = [];
    const renderer = render(
      <SpeedupCard
        status={status({ set: true })}
        vaultReadable
        busy={null}
        error={null}
        onSave={noop}
        onTest={() => void tests.push('groq')}
      />,
    );
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
    expect(renderer.root.findAll(node => node.props['data-speedup-set'] === '')).toHaveLength(1);

    // Act
    run(() => buttonLabelled(renderer.root, 'Test the Groq key').props.onClick());
    run(() => buttonLabelled(renderer.root, 'Replace the Groq key').props.onClick());
    const cancel = renderer.root.find(node => node.type === 'button' && node.children.includes('Cancel'));
    run(() => cancel.props.onClick());

    // Assert
    expect(tests).toEqual(['groq']);
    expect(renderer.root.findAllByType('input')).toHaveLength(0);
  });

  it('shows busy labels, locks while another card works, and says when it cannot tell', () => {
    const saving = render(
      <SpeedupCard
        status={status()}
        vaultReadable={false}
        busy="saving"
        error="the store is full"
        onSave={noop}
        onTest={noop}
      />,
    );
    expect(text(saving.toJSON())).toContain('Saving…');
    expect(text(saving.toJSON())).toContain('Can’t tell');
    expect(text(saving.toJSON())).toContain('the store is full');

    const testing = render(
      <SpeedupCard
        status={status({ set: true })}
        vaultReadable
        busy="testing"
        error={null}
        onSave={noop}
        onTest={noop}
      />,
    );
    expect(text(testing.toJSON())).toContain('Testing…');

    const locked = render(
      <SpeedupCard
        status={status({ set: true })}
        vaultReadable
        busy={null}
        locked
        error={null}
        onSave={noop}
        onTest={noop}
      />,
    );
    expect(buttonLabelled(locked.root, 'Test the Groq key').props.disabled).toBe(true);
    expect(buttonLabelled(locked.root, 'Replace the Groq key').props.disabled).toBe(true);
  });

  it('colours a passing, current test as good and anything else as a warning', () => {
    const good = render(
      <SpeedupCard
        status={status({ set: true, lastTest: result() })}
        vaultReadable
        busy={null}
        error={null}
        onSave={noop}
        onTest={noop}
      />,
    );
    const line = good.root.find(node => node.props['data-speedup-last-test'] === '');
    expect(line.props.className).toContain('text-ok');

    const stale = render(
      <SpeedupCard
        status={status({ set: true, lastTest: result(), testStale: true })}
        vaultReadable
        busy={null}
        error={null}
        onSave={noop}
        onTest={noop}
      />,
    );
    expect(stale.root.find(node => node.props['data-speedup-last-test'] === '').props.className).toContain('text-warn');
  });
});

describe('SpeedupsPanel', () => {
  it('introduces the keys, states the fallback, and warns over a damaged vault', () => {
    const renderer = render(
      <SpeedupsPanel view={view({ vault: 'damaged' })} busy={null} errors={{}} onSave={noop} onTest={noop} />,
    );
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain(SPEEDUPS_INTRO);
    expect(rendered).toContain(SPEEDUPS_FALLBACK);
    expect(rendered).toContain('cannot read its secret store');
    expect(renderer.root.findAllByType(SpeedupCard)).toHaveLength(2);
  });

  it('hands each card its own busy state and the rest a lock', () => {
    const renderer = render(
      <SpeedupsPanel
        view={view()}
        busy={{ provider: 'groq', kind: 'testing' }}
        errors={{ groq: 'boom' }}
        onSave={noop}
        onTest={noop}
      />,
    );
    const [jev, groq] = renderer.root.findAllByType(SpeedupCard);
    expect(jev?.props).toMatchObject({ busy: null, locked: true, error: null });
    expect(groq?.props).toMatchObject({ busy: 'testing', locked: false, error: 'boom' });
  });
});

function surfaceClient(
  calls: string[],
  options: { failTest?: boolean; initial?: SpeedupsView } = {},
): (connection: unknown) => Promise<never> {
  return async () =>
    ({
      request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/secrets') return schema.parse({ name: 'GROQ_API_KEY', createdAt: AT, updatedAt: AT });
        if (path.endsWith('/test')) {
          if (options.failTest === true) throw new Error('the daemon is unreachable');
          return schema.parse(result());
        }
        return schema.parse(
          calls.includes('POST /v1/secrets')
            ? view({ providers: [status({ set: true })] })
            : (options.initial ?? view()),
        );
      },
    }) as never;
}

describe('SpeedupsSurface', () => {
  it('shows a reading state before the first answer', () => {
    const renderer = render(
      <SpeedupsSurface connection={connection('a')} createClient={async () => await new Promise(() => undefined)} />,
    );
    expect(text(renderer.toJSON())).toContain('Reading this machine');
  });

  it('reports a failed read as a refusal, never as nothing set', async () => {
    const renderer = render(
      <SpeedupsSurface
        connection={connection('a')}
        createClient={async () => {
          throw new Error('the daemon is unreachable');
        }}
      />,
    );
    await runAsync(async () => undefined);
    const rendered = text(renderer.toJSON());
    expect(rendered).toContain('the daemon is unreachable');
    expect(rendered).toContain('not the same as none being');
  });

  it('saves through the secret route, then re-reads the status', async () => {
    // Arrange
    const calls: string[] = [];
    const renderer = render(<SpeedupsSurface connection={connection('a')} createClient={surfaceClient(calls)} />);
    await runAsync(async () => undefined);

    // Act
    await runAsync(async () => {
      await renderer.root.findByType(SpeedupsPanel).props.onSave(status(), KEY);
    });

    // Assert
    expect(calls).toEqual(['GET /v1/speedups', 'POST /v1/secrets', 'GET /v1/speedups']);
    expect(renderer.root.findAll(node => node.props['data-speedup-set'] === '')).toHaveLength(1);
  });

  it('runs a Test on request only, and shows its answer on the card', async () => {
    // Arrange
    const calls: string[] = [];
    const renderer = render(
      <SpeedupsSurface
        connection={connection('a')}
        createClient={surfaceClient(calls, { initial: view({ providers: [status({ set: true })] }) })}
      />,
    );
    await runAsync(async () => undefined);
    expect(calls).toEqual(['GET /v1/speedups']);

    // Act
    await runAsync(async () => {
      await renderer.root.findByType(SpeedupsPanel).props.onTest(status({ set: true }));
    });

    // Assert
    expect(calls).toEqual(['GET /v1/speedups', 'POST /v1/speedups/groq/test']);
    expect(text(renderer.toJSON())).toContain('Worked 2026-10-16 10:00');
  });

  it('keeps the view and names the failure when a Test cannot reach the daemon', async () => {
    // Arrange
    const calls: string[] = [];
    const renderer = render(
      <SpeedupsSurface connection={connection('a')} createClient={surfaceClient(calls, { failTest: true })} />,
    );
    await runAsync(async () => undefined);

    // Act
    await runAsync(async () => {
      await renderer.root.findByType(SpeedupsPanel).props.onTest(status());
    });

    // Assert
    expect(renderer.root.findByType(SpeedupsPanel).props.errors).toEqual({ groq: 'the daemon is unreachable' });
  });

  it('drops a daemon’s answer once the reader has switched machines', async () => {
    // Arrange
    let release: (value: never) => void = () => undefined;
    const slow = async () => await new Promise<never>(resolve => (release = resolve));
    const failing = async (): Promise<never> => {
      throw new Error('late failure');
    };
    const renderer = render(<SpeedupsSurface connection={connection('a')} createClient={slow} />);

    // Act — switch before A answers, then let A answer and a second stale load fail.
    run(() => renderer.update(<SpeedupsSurface connection={connection('b')} createClient={failing} />));
    await runAsync(async () => {
      release(surfaceClient([])(undefined) as never);
    });
    await runAsync(async () => undefined);

    // Assert
    expect(text(renderer.toJSON())).toContain('late failure');
    expect(renderer.root.findAllByType(SpeedupsPanel)).toHaveLength(0);
  });

  it('is offered to Settings as a machine panel', async () => {
    // Arrange
    const tab = speedupsSettingsTab(surfaceClient([]));
    const Surface = tab.Surface;

    // Act
    const renderer = render(<Surface connection={connection('a')} />);
    await runAsync(async () => undefined);

    // Assert
    expect(tab).toMatchObject({ id: 'speedups', label: 'Speed-ups' });
    expect(renderer.root.findAllByType(SpeedupsPanel)).toHaveLength(1);
  });
});

/** A daemon whose speed-up status a test changes by hand, and whose reads it can fail or hold back. */
function movingMachine() {
  const reads: string[] = [];
  const held: (() => void)[] = [];
  const state = { current: view(), failing: false, holding: false };
  const createClient = async () =>
    ({
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        reads.push(path);
        if (state.holding) await new Promise<void>(resolve => held.push(resolve));
        if (state.failing) throw new Error('the daemon is unreachable');
        return schema.parse(state.current);
      },
    }) as never;
  return { reads, held, state, createClient };
}

describe('SpeedupsSurface when the machine’s speed-ups move', () => {
  it('shows a key saved from another device without a reload', async () => {
    // Arrange
    const machine = movingMachine();
    const harness = configChangeHarness(connection('a').daemonId);
    const renderer = render(
      harness.wrap(<SpeedupsSurface connection={connection('a')} createClient={machine.createClient} />),
    );
    await runAsync(async () => undefined);
    expect(renderer.root.findAll(node => node.props['data-speedup-set'] === '')).toHaveLength(0);

    // Act — a key is saved elsewhere, then the machine says its speed-ups moved.
    machine.state.current = view({ providers: [status({ set: true })] });
    await harness.move(['speedups']);
    await runAsync(async () => undefined);

    // Assert
    expect(machine.reads).toEqual(['/v1/speedups', '/v1/speedups']);
    expect(renderer.root.findAll(node => node.props['data-speedup-set'] === '')).toHaveLength(1);
  });

  it('does nothing for a move that arrives before the client is ready', async () => {
    // Arrange
    const machine = movingMachine();
    const harness = configChangeHarness(connection('a').daemonId);
    const renderer = render(
      harness.wrap(
        <SpeedupsSurface connection={connection('a')} createClient={async () => await new Promise(() => undefined)} />,
      ),
    );

    // Act
    await harness.move(['speedups']);
    await runAsync(async () => undefined);

    // Assert
    expect(machine.reads).toEqual([]);
    expect(text(renderer.toJSON())).toContain('Reading this machine');
  });

  it('keeps what was shown when the re-read fails', async () => {
    // Arrange
    const machine = movingMachine();
    machine.state.current = view({ providers: [status({ set: true })] });
    const harness = configChangeHarness(connection('a').daemonId);
    const renderer = render(
      harness.wrap(<SpeedupsSurface connection={connection('a')} createClient={machine.createClient} />),
    );
    await runAsync(async () => undefined);

    // Act
    machine.state.failing = true;
    await harness.move(['speedups']);
    await runAsync(async () => undefined);

    // Assert
    expect(machine.reads).toEqual(['/v1/speedups', '/v1/speedups']);
    expect(renderer.root.findAll(node => node.props['data-speedup-set'] === '')).toHaveLength(1);
    expect(text(renderer.toJSON())).not.toContain('the daemon is unreachable');
  });

  it('drops a re-read that lands after the reader switched machines', async () => {
    // Arrange
    const machine = movingMachine();
    const harness = configChangeHarness(connection('a').daemonId);
    const renderer = render(
      harness.wrap(<SpeedupsSurface connection={connection('a')} createClient={machine.createClient} />),
    );
    await runAsync(async () => undefined);
    machine.state.holding = true;
    await harness.move(['speedups']);

    // Act — switch to a machine that has not answered, then let the old machine's re-read land.
    run(() =>
      renderer.update(
        harness.wrap(
          <SpeedupsSurface
            connection={connection('b')}
            createClient={async () => await new Promise(() => undefined)}
          />,
        ),
      ),
    );
    await runAsync(async () => {
      for (const release of machine.held.splice(0)) release();
    });

    // Assert
    expect(text(renderer.toJSON())).toContain('Reading this machine');
    expect(renderer.root.findAllByType(SpeedupsPanel)).toHaveLength(0);
  });
});
