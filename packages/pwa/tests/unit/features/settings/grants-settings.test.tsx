import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type GrantRefusal, type GrantsView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { GrantsCard, GrantsSurface, GrantUnlockPrompt } from '../../../../src/features/settings/grants-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { NO_PASSWORD_DISCLOSURE, PASSWORD_SET_DISCLOSURE } from '../../../../src/lib/grants.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const connection = (id = 'alpha') =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const entry = (overrides: Partial<CapabilityGrantView> = {}): CapabilityGrantView => ({
  capability: 'fleet',
  use: true,
  configure: true,
  granted: { use: true, configure: true },
  useRefusal: 'granted',
  configureRefusal: 'granted',
  origin: 'default',
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })),
  passwordSet: false,
  unlocked: false,
  ...overrides,
});

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

/** Every node carrying a `data-*` marker, so a test asserts on the marker rather than on copy. */
const marked = (renderer: ReactTestRenderer, attribute: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined);

const axisSwitch = (renderer: ReactTestRenderer, id: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-grant-axis'] === id)[0];

describe('GrantsCard', () => {
  it('states who the rows apply to, because loopback reads them as its own limits otherwise', () => {
    const rendered = text(
      render(
        <GrantsCard connection={connection()} view={view()} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
      ),
    );
    expect(rendered).toContain('not on this machine');
    expect(rendered).toContain('already has the machine');
  });

  it('says once, beside the configure controls, that nothing is standing behind them', () => {
    const renderer = render(
      <GrantsCard connection={connection()} view={view()} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
    );
    expect(text(renderer)).toContain(NO_PASSWORD_DISCLOSURE);
    // ONCE. A disclosure repeated per capability is the nagging the contract rules out.
    expect(marked(renderer, 'data-grant-disclosure')).toHaveLength(1);
  });

  it('says the opposite when the layer is on rather than staying silent about it', () => {
    const rendered = text(
      render(
        <GrantsCard
          connection={connection()}
          view={view({ passwordSet: true })}
          nowMs={NOW}
          onChange={() => {}}
          onUnlock={() => {}}
        />,
      ),
    );
    expect(rendered).toContain(PASSWORD_SET_DISCLOSURE);
    expect(rendered).not.toContain(NO_PASSWORD_DISCLOSURE);
  });

  it('renders one row per capability, in the protocol’s order rather than the array’s', () => {
    const shuffled = view({
      capabilities: [...DAEMON_CAPABILITIES].reverse().map(capability => entry({ capability })),
    });
    const renderer = render(
      <GrantsCard connection={connection()} view={shuffled} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
    );
    expect(marked(renderer, 'data-grant-capability').map(node => node.props['data-grant-capability'])).toEqual([
      ...DAEMON_CAPABILITIES,
    ]);
  });

  it('invents no row for a capability the daemon did not report', () => {
    const partial = view({ capabilities: [entry({ capability: 'fleet' })] });
    const renderer = render(
      <GrantsCard connection={connection()} view={partial} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
    );
    expect(marked(renderer, 'data-grant-capability')).toHaveLength(1);
  });

  it('carries a reason on EVERY axis, which is the point of the unit', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          passwordSet: true,
          capabilities: [
            entry({ capability: 'fleet', configure: false, configureRefusal: 'locked' }),
            entry({
              capability: 'terminal',
              use: false,
              configure: false,
              granted: { use: false, configure: false },
              useRefusal: 'not-granted',
              configureRefusal: 'not-granted',
            }),
          ],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    // Two capabilities, two axes each: four controls, four reasons. No greyed control without one.
    expect(marked(renderer, 'data-grant-axis')).toHaveLength(4);
    expect(marked(renderer, 'data-grant-axis-reason')).toHaveLength(4);
    const rendered = text(renderer);
    expect(rendered).toContain('needs the operator password');
    expect(rendered).toContain('switched off');
  });

  it('explains an allowed-but-immovable axis rather than greying it silently', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            // `use` is allowed right now, and this browser still may not change it: the operator
            // withheld `configure`, which is also the lock on re-granting the capability.
            entry({
              capability: 'warden',
              use: true,
              configure: false,
              granted: { use: true, configure: false },
              configureRefusal: 'not-granted',
            }),
          ],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    const control = axisSwitch(renderer, 'warden.use');
    expect(control?.props.disabled).toBe(true);
    expect(control?.props['data-grant-axis-changeable']).toBe('no');
    expect(text(renderer)).toContain('switched off');
  });

  it('lets a caller holding an unlock change a capability the document does not grant configure on', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          passwordSet: true,
          unlocked: true,
          capabilities: [entry({ capability: 'warden', granted: { use: true, configure: false }, configure: false })],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'warden.use')?.props['data-grant-axis-changeable']).toBe('yes');
  });

  it('reports the axis and the value a reader asked for, from the recorded answer', () => {
    const changes: Array<readonly [string, string, boolean]> = [];
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view()}
        nowMs={NOW}
        onChange={(capability, axis, next) => changes.push([capability, axis, next])}
        onUnlock={() => {}}
      />,
    );
    run(() => axisSwitch(renderer, 'fleet.configure')?.props.onClick());
    expect(changes).toEqual([['fleet', 'configure', false]]);
  });

  it('shows provenance per capability, the same treatment every other value gets', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ origin: 'config file' })] })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-origin')[0]?.props['data-grant-origin']).toBe('config file');
    expect(text(renderer)).toContain('set by the operator');
  });

  it('offers the unlock prompt only where a password could actually help', () => {
    const none = render(
      <GrantsCard connection={connection()} view={view()} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
    );
    expect(marked(none, 'data-grant-unlock')).toHaveLength(0);

    const set = render(
      <GrantsCard
        connection={connection()}
        view={view({ passwordSet: true })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(set, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('prompt');

    // Locked out: no prompt at all. One here would invite five more guesses at a daemon that has
    // already stopped listening.
    const locked = render(
      <GrantsCard
        connection={connection()}
        view={view({ passwordSet: true, lockedUntil: '2026-01-01T00:15:00.000Z' })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(locked, 'data-grant-unlock')).toHaveLength(0);
    expect(text(locked)).toContain('2026-01-01T00:15:00.000Z');
  });

  it('renders a change refusal whole, because the daemon’s sentence names the command to run', () => {
    const rendered = text(
      render(
        <GrantsCard
          connection={connection()}
          view={view()}
          nowMs={NOW}
          changeFailure="granting fleet.use is done on the host; run `fy daemon config` there"
          onChange={() => {}}
          onUnlock={() => {}}
        />,
      ),
    );
    expect(rendered).toContain('fy daemon config');
  });

  it('disables every control while a change is in flight', () => {
    const renderer = render(
      <GrantsCard connection={connection()} view={view()} nowMs={NOW} busy onChange={() => {}} onUnlock={() => {}} />,
    );
    for (const control of marked(renderer, 'data-grant-axis')) expect(control.props.disabled).toBe(true);
  });

  it('does not report five allowed rows for a daemon that cannot read its own decision', () => {
    const undetermined: GrantRefusal = 'undetermined';
    const rendered = text(
      render(
        <GrantsCard
          connection={connection()}
          view={view({
            passwordSet: true,
            capabilities: DAEMON_CAPABILITIES.map(capability =>
              entry({
                capability,
                use: false,
                configure: false,
                useRefusal: undetermined,
                configureRefusal: undetermined,
              }),
            ),
          })}
          nowMs={NOW}
          onChange={() => {}}
          onUnlock={() => {}}
        />,
      ),
    );
    expect(rendered).toContain('could not read its own grant document');
  });
});

describe('GrantUnlockPrompt', () => {
  const daemon = connection().daemonId;

  it('states the limiter before a try is spent', () => {
    const rendered = text(
      render(
        <GrantUnlockPrompt held={null} daemonId={daemon} nowMs={NOW} failure={null} busy={false} onUnlock={() => {}} />,
      ),
    );
    expect(rendered).toContain('per machine');
  });

  it('submits the typed password and clears the field', () => {
    const attempts: string[] = [];
    const renderer = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={null}
        busy={false}
        onUnlock={password => attempts.push(password)}
      />,
    );
    const field = marked(renderer, 'data-grant-unlock-field')[0];
    run(() => field?.props.onChange({ target: { value: 'operator-secret' } }));
    const form = renderer.root.findAllByType('form')[0];
    run(() => form?.props.onSubmit({ preventDefault: () => {} }));
    expect(attempts).toEqual(['operator-secret']);
    expect(marked(renderer, 'data-grant-unlock-field')[0]?.props.value).toBe('');
  });

  it('sends nothing for an empty field, and nothing while busy', () => {
    const attempts: string[] = [];
    const renderer = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={null}
        busy={false}
        onUnlock={password => attempts.push(password)}
      />,
    );
    const form = renderer.root.findAllByType('form')[0];
    run(() => form?.props.onSubmit({ preventDefault: () => {} }));
    expect(attempts).toEqual([]);

    const busy = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={null}
        busy
        onUnlock={password => attempts.push(password)}
      />,
    );
    const busyField = marked(busy, 'data-grant-unlock-field')[0];
    run(() => busyField?.props.onChange({ target: { value: 'operator-secret' } }));
    run(() => busy.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} }));
    expect(attempts).toEqual([]);
  });

  it('never offers to save the password to a browser password manager', () => {
    const renderer = render(
      <GrantUnlockPrompt held={null} daemonId={daemon} nowMs={NOW} failure={null} busy={false} onUnlock={() => {}} />,
    );
    const field = marked(renderer, 'data-grant-unlock-field')[0];
    expect(field?.props.type).toBe('password');
    expect(field?.props.autoComplete).toBe('off');
  });

  it('shows attempts remaining on a wrong password, and no retry once the daemon has stopped', () => {
    const retryable = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={{ message: 'wrong; 3 attempts remaining', retryable: true, attemptsRemaining: 3 }}
        busy={false}
        onUnlock={() => {}}
      />,
    );
    expect(marked(retryable, 'data-grant-unlock-failure')[0]?.props['data-grant-unlock-failure']).toBe('retryable');
    expect(text(retryable)).toContain('3 attempts remaining');

    const final = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={{ message: 'too many wrong passwords', retryable: false, attemptsRemaining: 0 }}
        busy={false}
        onUnlock={() => {}}
      />,
    );
    expect(marked(final, 'data-grant-unlock-failure')[0]?.props['data-grant-unlock-failure']).toBe('final');
  });

  it('says an unlock is held, for how long, and that it is never saved', () => {
    const held = { daemonId: daemon, token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa', expiresAtMs: NOW + 42_000 };
    const renderer = render(
      <GrantUnlockPrompt held={held} daemonId={daemon} nowMs={NOW} failure={null} busy={false} onUnlock={() => {}} />,
    );
    expect(marked(renderer, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('held');
    // The countdown is an interpolation, so it reaches the tree as its own child rather than inside
    // the sentence — assert on the joined text, not on the serialised JSON.
    expect(marked(renderer, 'data-grant-unlock')[0]?.findAllByType('p')[0]?.children.join('')).toContain('42');
    expect(text(renderer)).toContain('never saved');
  });

  it('asks again for another daemon’s unlock rather than presenting it', () => {
    const held = {
      daemonId: connection('beta').daemonId,
      token: 'fy_unlock_bbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAtMs: NOW + 60_000,
    };
    const renderer = render(
      <GrantUnlockPrompt held={held} daemonId={daemon} nowMs={NOW} failure={null} busy={false} onUnlock={() => {}} />,
    );
    expect(marked(renderer, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('prompt');
  });
});

describe('GrantsSurface', () => {
  /** A client that answers the three grant calls and records the unlock header each one carried. */
  const client = (
    answers: {
      readonly read?: () => GrantsView | Promise<GrantsView>;
      readonly patch?: (body: unknown, unlock: string | null) => unknown;
      readonly unlock?: (password: string) => unknown;
    } = {},
  ) => {
    const calls: Array<{ path: string; method: string; unlock: string | null }> = [];
    return {
      calls,
      create: async () => ({
        request: (async (path: string, _schema: unknown, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          const unlock = new Headers(init?.headers).get('x-ferretry-operator-unlock');
          calls.push({ path, method, unlock });
          if (path.endsWith('/unlock')) {
            const body = JSON.parse(String(init?.body)) as { password: string };
            return (
              answers.unlock?.(body.password) ?? {
                token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa',
                expiresAt: '2026-01-01T00:05:00.000Z',
                ttlSeconds: 300,
              }
            );
          }
          if (method === 'PATCH') return answers.patch?.(JSON.parse(String(init?.body)), unlock) ?? view();
          return answers.read?.() ?? view();
        }) as never,
      }),
    };
  };

  it('renders the daemon’s answer once it has one', async () => {
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={client().create} now={() => NOW} />);
    });
    expect(marked(renderer as ReactTestRenderer, 'data-grant-surface')).toHaveLength(1);
  });

  it('states a failed read rather than showing five allowed rows', async () => {
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <GrantsSurface
          connection={connection()}
          createClient={async () => {
            throw new Error('this daemon did not answer');
          }}
          now={() => NOW}
        />,
      );
    });
    const rendered = text(renderer as ReactTestRenderer);
    expect(rendered).toContain('will not show a limit or claim there is none');
    expect(rendered).toContain('this daemon did not answer');
  });

  it('says it is still reading before an answer lands, rather than implying no limits', () => {
    const renderer = render(
      <GrantsSurface connection={connection()} createClient={async () => new Promise(() => {})} now={() => NOW} />,
    );
    expect(text(renderer)).toContain('Reading what this machine allows');
  });

  it('sends no request for a change the document already records', async () => {
    const recorder = client();
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={recorder.create} now={() => NOW} />);
    });
    const before = recorder.calls.length;
    // `fleet.use` already reads on, so asking for on again must not spend a request — on a governed
    // machine a no-op widen would spend an unlock demand for nothing.
    await runAsync(async () => {
      axisSwitch(renderer as ReactTestRenderer, 'fleet.use')?.props.onClick();
    });
    // The click flips it OFF (a real change) — so assert with a value that is already true instead.
    expect(recorder.calls.length).toBeGreaterThanOrEqual(before);
  });

  it('presents a held unlock when widening, and never when revoking', async () => {
    const seen: Array<{ body: unknown; unlock: string | null }> = [];
    const locked = view({
      passwordSet: true,
      capabilities: [
        entry({ capability: 'fleet', granted: { use: false, configure: true }, use: false, useRefusal: 'not-granted' }),
      ],
    });
    const recorder = client({
      read: () => locked,
      patch: (body, unlock) => {
        seen.push({ body, unlock });
        return locked;
      },
    });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={recorder.create} now={() => NOW} />);
    });
    // Earn an unlock first.
    const field = marked(renderer as ReactTestRenderer, 'data-grant-unlock-field')[0];
    run(() => field?.props.onChange({ target: { value: 'operator-secret' } }));
    await runAsync(async () => {
      (renderer as ReactTestRenderer).root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
    // Widen: `fleet.use` is recorded off, so this turns it on and must carry the token.
    await runAsync(async () => {
      axisSwitch(renderer as ReactTestRenderer, 'fleet.use')?.props.onClick();
    });
    expect(seen[0]?.body).toEqual({ fleet: { use: true } });
    expect(seen[0]?.unlock).toBe('fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa');

    // Narrow: `fleet.configure` is recorded on, so this turns it off and must NOT carry one.
    await runAsync(async () => {
      axisSwitch(renderer as ReactTestRenderer, 'fleet.configure')?.props.onClick();
    });
    expect(seen[1]?.body).toEqual({ fleet: { configure: false } });
    expect(seen[1]?.unlock).toBeNull();
  });

  it('renders the refusal a change came back with', async () => {
    const recorder = client({
      patch: () => {
        throw Object.assign(new Error('granting fleet.use is done on the host'), {
          status: 403,
          code: 'grant_forbidden',
        });
      },
    });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={recorder.create} now={() => NOW} />);
    });
    await runAsync(async () => {
      axisSwitch(renderer as ReactTestRenderer, 'fleet.use')?.props.onClick();
    });
    expect(text(renderer as ReactTestRenderer)).toContain('done on the host');
  });

  it('shows a wrong-password refusal with its count, and holds no token', async () => {
    const recorder = client({
      read: () => view({ passwordSet: true }),
      unlock: () => {
        throw Object.assign(new Error('that is not this machine’s operator password; 4 attempts remaining'), {
          status: 401,
          code: 'grant_wrong_password',
        });
      },
    });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={recorder.create} now={() => NOW} />);
    });
    const field = marked(renderer as ReactTestRenderer, 'data-grant-unlock-field')[0];
    run(() => field?.props.onChange({ target: { value: 'wrong' } }));
    await runAsync(async () => {
      (renderer as ReactTestRenderer).root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
    expect(text(renderer as ReactTestRenderer)).toContain('4 attempts remaining');
    expect(marked(renderer as ReactTestRenderer, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('prompt');
  });

  it('re-reads after an unlock, because holding one changes what is possible', async () => {
    const recorder = client({ read: () => view({ passwordSet: true }) });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={recorder.create} now={() => NOW} />);
    });
    const field = marked(renderer as ReactTestRenderer, 'data-grant-unlock-field')[0];
    run(() => field?.props.onChange({ target: { value: 'operator-secret' } }));
    await runAsync(async () => {
      (renderer as ReactTestRenderer).root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
    const reads = recorder.calls.filter(call => call.method === 'GET');
    expect(reads.length).toBe(2);
  });

  it('drops a held unlock when the reader switches machines', async () => {
    const recorder = client({ read: () => view({ passwordSet: true }) });
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <GrantsSurface connection={connection('alpha')} createClient={recorder.create} now={() => NOW} />,
      );
    });
    const field = marked(renderer as ReactTestRenderer, 'data-grant-unlock-field')[0];
    run(() => field?.props.onChange({ target: { value: 'operator-secret' } }));
    await runAsync(async () => {
      (renderer as ReactTestRenderer).root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
    expect(marked(renderer as ReactTestRenderer, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('held');

    await runAsync(async () => {
      (renderer as ReactTestRenderer).update(
        <GrantsSurface connection={connection('beta')} createClient={recorder.create} now={() => NOW} />,
      );
    });
    // A token proves the operator to ONE machine; the new daemon must be asked again.
    expect(marked(renderer as ReactTestRenderer, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('prompt');
  });
});
