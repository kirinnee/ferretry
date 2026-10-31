import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type GrantsView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { GrantStepUpPanel, GrantsCard, GrantsSurface } from '../../../../src/features/settings/grants-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { STEP_UP_NOTE } from '../../../../src/lib/grants.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const connection = (id = 'alpha') =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const entry = (overrides: Partial<CapabilityGrantView> = {}): CapabilityGrantView => ({
  capability: 'fleet',
  use: true,
  configure: true,
  granted: { use: true, configure: true },
  useRefusal: 'granted',
  configureRefusal: 'granted',
  origin: 'default',
  mayGrant: false,
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })),
  // Governed and NOT on the host: a paired device somewhere else.
  governed: true,
  hostLocal: false,
  steppedUp: false,
  ...overrides,
});

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

/** Every node carrying a `data-*` marker, so a test asserts on the marker rather than on copy. */
const marked = (renderer: ReactTestRenderer, attribute: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined);

const axisSwitch = (renderer: ReactTestRenderer, id: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-grant-axis'] === id)[0];

const NO_WORDS = /password|unlock/i;

describe('GrantStepUpPanel', () => {
  it('offers the passkey button while this device has not confirmed', () => {
    let asked = 0;
    const renderer = render(<GrantStepUpPanel steppedUp={false} busy={false} onStepUp={() => (asked += 1)} />);
    expect(marked(renderer, 'data-grant-step-up')[0]?.props['data-grant-step-up']).toBe('needed');
    expect(text(renderer)).toContain(STEP_UP_NOTE);
    run(() => marked(renderer, 'data-grant-step-up-open')[0]?.props.onClick());
    expect(asked).toBe(1);
    expect(text(renderer)).not.toMatch(NO_WORDS);
  });

  it('disables the button while a call is in flight', () => {
    const renderer = render(<GrantStepUpPanel steppedUp={false} busy onStepUp={() => {}} />);
    expect(marked(renderer, 'data-grant-step-up-open')[0]?.props.disabled).toBe(true);
  });

  it('says a confirmed device is confirmed, and offers nothing further to press', () => {
    const renderer = render(<GrantStepUpPanel steppedUp busy={false} onStepUp={() => {}} />);
    expect(marked(renderer, 'data-grant-step-up')[0]?.props['data-grant-step-up']).toBe('held');
    expect(text(renderer)).toContain('Confirmed with your passkey');
    expect(marked(renderer, 'data-grant-step-up-open')).toHaveLength(0);
  });

  it('renders no button when the screen was given no way to ask', () => {
    const renderer = render(<GrantStepUpPanel steppedUp={false} busy={false} />);
    expect(text(renderer)).toContain(STEP_UP_NOTE);
    expect(marked(renderer, 'data-grant-step-up-open')).toHaveLength(0);
  });
});

describe('GrantsCard', () => {
  it('shows the passkey panel and a header badge only to a caller the limits govern', () => {
    const governed = render(<GrantsCard connection={connection()} view={view()} onChange={() => {}} />);
    expect(marked(governed, 'data-grant-step-up')).toHaveLength(1);
    expect(marked(governed, 'data-grant-stepped-up')[0]?.props['data-grant-stepped-up']).toBe('no');
    expect(text(governed)).toContain('passkey not confirmed yet');

    const confirmed = render(
      <GrantsCard connection={connection()} view={view({ steppedUp: true })} onChange={() => {}} />,
    );
    expect(marked(confirmed, 'data-grant-stepped-up')[0]?.props['data-grant-stepped-up']).toBe('yes');
    expect(text(confirmed)).toContain('passkey confirmed');

    // An ungoverned view is the CLI's, never a browser's; it is asked for no passkey.
    const ungoverned = render(
      <GrantsCard connection={connection()} view={view({ governed: false, hostLocal: true })} onChange={() => {}} />,
    );
    expect(marked(ungoverned, 'data-grant-step-up')).toHaveLength(0);
    expect(marked(ungoverned, 'data-grant-stepped-up')).toHaveLength(0);
  });

  it('states that the rows apply to this browser, a browser on the machine itself included', () => {
    const scope = (renderer: ReactTestRenderer): unknown =>
      marked(renderer, 'data-grant-scope')[0]?.props['data-grant-scope'];
    const governed = render(<GrantsCard connection={connection()} view={view()} onChange={() => {}} />);
    expect(scope(governed)).toBe('this-browser');
    expect(text(governed)).toContain('on the machine itself included');
    expect(text(governed)).not.toContain('none of them apply');
  });

  it('explains a step-up-required row in one plain sentence with no password words', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [entry({ capability: 'fleet', configure: false, configureRefusal: 'step-up-required' })],
        })}
        onChange={() => {}}
      />,
    );
    const reason = marked(renderer, 'data-grant-axis-reason').find(
      node => node.props['data-grant-axis-reason'] === 'fleet.configure',
    );
    expect(JSON.stringify(reason?.props.children)).toContain('needs your passkey');
    expect(JSON.stringify(reason?.props.children)).not.toMatch(NO_WORDS);
    // A step-up never makes a control unchangeable: it can be had on the spot.
    expect(axisSwitch(renderer, 'fleet.configure')?.props.disabled).toBe(false);
  });

  it('renders no widening switch for a caller that may never turn a capability on', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
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
        onChange={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(true);
    const rendered = text(renderer);
    expect(rendered).toContain('only be switched on at the machine');
    expect(rendered).toContain('fy daemon config set terminal --use');
    expect(rendered).not.toMatch(NO_WORDS);
  });

  it('warns a one-way caller before they close a door only the machine can reopen', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'fleet' })] })}
        onChange={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-one-way')[0]?.props['data-grant-one-way']).toBe('fleet');
    expect(text(renderer)).toContain('cannot be undone from here');
    expect(text(renderer)).not.toContain('revoke that device FIRST');
  });

  it('tells a remote caller that switching pairing off also disables their own revoke', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'pairing' })] })}
        onChange={() => {}}
      />,
    );
    expect(text(renderer)).toContain('revoke that device FIRST');
  });

  it('keeps a browser on the machine behind the same one-way door: no switch on, only the command to run', () => {
    // A local browser reads `governed: true` and `mayGrant: false` like any paired device.
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({
              capability: 'terminal',
              use: false,
              granted: { use: false, configure: true },
              useRefusal: 'not-granted',
            }),
          ],
        })}
        onChange={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(true);
    expect(text(renderer)).toContain('fy daemon config set terminal --use');
  });

  it('hands the capability list the daemon’s own posture rather than deriving one', () => {
    const posture = (renderer: ReactTestRenderer): unknown =>
      marked(renderer, 'data-capability-posture')[0]?.props['data-capability-posture'];
    expect(posture(render(<GrantsCard connection={connection()} view={view()} onChange={() => {}} />))).toBe(
      'governed',
    );
    // A daemon that does not call this browser governed is not believed to mean "you are exempt".
    expect(
      posture(
        render(
          <GrantsCard
            connection={connection()}
            view={view({ governed: false, hostLocal: true })}
            onChange={() => {}}
          />,
        ),
      ),
    ).toBe('unknown');
  });

  it('renders one row per capability in the protocol’s order, and invents none', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'warden' }), entry({ capability: 'fleet' })] })}
        onChange={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-capability').map(node => node.props['data-grant-capability'])).toEqual([
      'fleet',
      'warden',
    ]);
  });

  it('carries a reason on every axis, which is the point of the unit', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'fleet' }), entry({ capability: 'terminal' })] })}
        onChange={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-axis')).toHaveLength(4);
    expect(marked(renderer, 'data-grant-axis-reason')).toHaveLength(4);
  });

  it('explains an allowed-but-immovable axis, and disables it for a governed caller without configure', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({
              capability: 'warden',
              configure: false,
              granted: { use: true, configure: false },
              configureRefusal: 'not-granted',
            }),
          ],
        })}
        onChange={() => {}}
      />,
    );
    const control = axisSwitch(renderer, 'warden.use');
    expect(control?.props.disabled).toBe(true);
    expect(control?.props['data-grant-axis-changeable']).toBe('no');
    expect(text(renderer)).toContain('may not change this');
  });

  it('leaves the same axis changeable for an ungoverned caller, which is never a browser', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          governed: false,
          hostLocal: true,
          capabilities: [entry({ capability: 'warden', granted: { use: true, configure: false }, mayGrant: true })],
        })}
        onChange={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'warden.use')?.props['data-grant-axis-changeable']).toBe('yes');
  });

  it('reports the axis and the value a reader asked for, from the recorded answer', () => {
    const seen: unknown[] = [];
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'fleet' })] })}
        onChange={(capability, axis, next) => seen.push([capability, axis, next])}
      />,
    );
    run(() => axisSwitch(renderer, 'fleet.configure')?.props.onClick());
    expect(seen).toEqual([['fleet', 'configure', false]]);
  });

  it('shows provenance per capability', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [entry({ capability: 'fleet', origin: 'config file' }), entry({ capability: 'warden' })],
        })}
        onChange={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-origin').map(node => node.props['data-grant-origin'])).toEqual([
      'config file',
      'default',
    ]);
  });

  it('renders a change refusal whole, because the daemon’s sentence names the command to run', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view()}
        changeFailure="fleet can only be turned on from the machine itself"
        onChange={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-change-failure')).toHaveLength(1);
    expect(text(renderer)).toContain('fleet can only be turned on from the machine itself');
  });

  it('disables every control while a change is in flight', () => {
    const renderer = render(<GrantsCard connection={connection()} view={view()} busy onChange={() => {}} />);
    for (const node of marked(renderer, 'data-grant-axis')) expect(node.props.disabled).toBe(true);
  });

  it('does not report five allowed rows for a daemon that cannot read its own decision', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: DAEMON_CAPABILITIES.map(capability =>
            entry({
              capability,
              use: false,
              configure: false,
              useRefusal: 'undetermined',
              configureRefusal: 'undetermined',
            }),
          ),
        })}
        onChange={() => {}}
      />,
    );
    expect(text(renderer)).toContain('could not read its own grant document');
  });
});

describe('GrantsSurface', () => {
  /** A client that answers the grant calls and records each one, with the headers it carried. */
  const client = (
    answers: {
      readonly read?: (reads: number) => GrantsView | Promise<GrantsView>;
      readonly patch?: (body: unknown) => unknown;
    } = {},
  ) => {
    const calls: Array<{ method: string; headers: Array<[string, string]> }> = [];
    let reads = 0;
    return {
      calls,
      reads: () => reads,
      create: async () => ({
        request: (async (_path: string, _schema: unknown, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          calls.push({ method, headers: [...new Headers(init?.headers)] });
          if (method === 'PATCH') {
            const body = JSON.parse(String(init?.body));
            const answered = answers.patch?.(body);
            if (answered instanceof Error) throw answered;
            return answered ?? view();
          }
          reads += 1;
          return answers.read?.(reads) ?? view();
        }) as never,
      }),
    };
  };

  const mountSurface = async (
    props: Partial<Parameters<typeof GrantsSurface>[0]> & { create: () => Promise<never> },
  ) => {
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={props.create} {...props} />);
    });
    return renderer as ReactTestRenderer;
  };

  it('renders the daemon’s answer once it has one', async () => {
    const renderer = await mountSurface({ create: client().create as never });
    expect(marked(renderer, 'data-grant-surface')).toHaveLength(1);
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
        />,
      );
    });
    const rendered = text(renderer as ReactTestRenderer);
    expect(rendered).toContain('will not show a limit or claim there is none');
    expect(rendered).toContain('this daemon did not answer');
  });

  it('says it is still reading before an answer lands, rather than implying no limits', () => {
    const renderer = render(
      <GrantsSurface connection={connection()} createClient={async () => new Promise(() => {})} />,
    );
    expect(text(renderer)).toContain('Reading what this machine allows');
  });

  it('sends the patch with no credential header, and shows the daemon’s answer', async () => {
    const recorder = client({
      patch: () =>
        view({ capabilities: [entry({ capability: 'fleet', use: false, granted: { use: false, configure: true } })] }),
    });
    const renderer = await mountSurface({ create: recorder.create as never });
    await runAsync(async () => {
      axisSwitch(renderer, 'fleet.use')?.props.onClick();
    });
    const patch = recorder.calls.find(call => call.method === 'PATCH');
    expect(patch?.headers).toEqual([['content-type', 'application/json']]);
    expect(axisSwitch(renderer, 'fleet.use')?.props['aria-checked']).toBe(false);
  });

  it('renders the refusal a change came back with, and clears it on the next attempt', async () => {
    let fail = true;
    const recorder = client({ patch: () => (fail ? new Error('the grant could not be written') : view()) });
    const renderer = await mountSurface({ create: recorder.create as never });
    await runAsync(async () => {
      axisSwitch(renderer, 'fleet.configure')?.props.onClick();
    });
    expect(text(renderer)).toContain('the grant could not be written');
    fail = false;
    await runAsync(async () => {
      axisSwitch(renderer, 'fleet.configure')?.props.onClick();
    });
    expect(marked(renderer, 'data-grant-change-failure')).toHaveLength(0);
  });

  it('asks for the passkey, then re-reads, because holding a step-up changes what is possible', async () => {
    const asked: string[] = [];
    const recorder = client({
      read: reads =>
        reads === 1
          ? view()
          : view({ steppedUp: true, capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })) }),
    });
    const renderer = await mountSurface({
      create: recorder.create as never,
      requestStepUp: async daemon => {
        asked.push(String(daemon.daemonId));
        return true;
      },
    });
    expect(marked(renderer, 'data-grant-step-up')[0]?.props['data-grant-step-up']).toBe('needed');
    await runAsync(async () => {
      marked(renderer, 'data-grant-step-up-open')[0]?.props.onClick();
    });
    expect(asked).toEqual(['alpha']);
    expect(recorder.reads()).toBe(2);
    expect(marked(renderer, 'data-grant-step-up')[0]?.props['data-grant-step-up']).toBe('held');
  });

  it('changes nothing and says nothing when the prompt is dismissed', async () => {
    const recorder = client();
    const renderer = await mountSurface({ create: recorder.create as never, requestStepUp: async () => false });
    await runAsync(async () => {
      marked(renderer, 'data-grant-step-up-open')[0]?.props.onClick();
    });
    expect(recorder.reads()).toBe(1);
    expect(marked(renderer, 'data-grant-change-failure')).toHaveLength(0);
    expect(marked(renderer, 'data-grant-step-up')[0]?.props['data-grant-step-up']).toBe('needed');
  });

  it('shows the failure when the passkey call itself fails', async () => {
    const renderer = await mountSurface({
      create: client().create as never,
      requestStepUp: async () => {
        throw new Error('the passkey sheet could not open');
      },
    });
    await runAsync(async () => {
      marked(renderer, 'data-grant-step-up-open')[0]?.props.onClick();
    });
    expect(text(renderer)).toContain('the passkey sheet could not open');
  });

  it('drops a read that lands after the screen was left, and re-reads for another machine', async () => {
    let release: (() => void) | undefined;
    const slow = {
      request: (async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return view();
      }) as never,
    };
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection('alpha')} createClient={async () => slow} />);
    });
    await runAsync(async () => {
      renderer?.unmount();
      release?.();
    });
    expect(renderer?.toJSON()).toBeNull();

    const recorder = client();
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection('alpha')} createClient={recorder.create as never} />);
    });
    await runAsync(async () => {
      renderer?.update(<GrantsSurface connection={connection('beta')} createClient={recorder.create as never} />);
    });
    expect(recorder.reads()).toBe(2);
    expect(marked(renderer as ReactTestRenderer, 'data-grant-surface')[0]?.props['data-grant-surface']).toBe('beta');
  });

  it('offers no passkey button outside the app store, where nothing could answer it', async () => {
    const renderer = await mountSurface({ create: client().create as never });
    expect(marked(renderer, 'data-grant-step-up')).toHaveLength(1);
    expect(marked(renderer, 'data-grant-step-up-open')).toHaveLength(0);
  });
});

describe('GrantsCard per-device grants', () => {
  it('shows the secret store and catalog sharing beside the other six, as cards of their own', () => {
    // Arrange, Act
    const renderer = render(<GrantsCard connection={connection()} view={view()} onChange={() => {}} />);

    // Assert
    expect(marked(renderer, 'data-grant-capability')).toHaveLength(8);
    expect(marked(renderer, 'data-grant-capability').at(-2)?.props['data-grant-capability']).toBe('secrets');
    expect(marked(renderer, 'data-grant-capability').at(-1)?.props['data-grant-capability']).toBe('sharing');
    expect(text(renderer)).toContain('Secrets');
    expect(axisSwitch(renderer, 'secrets.use')).toBeDefined();
  });

  it('explains a refusal that is this device’s own grant, with the host command, on that capability only', () => {
    // Arrange, Act
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({
              capability: 'terminal',
              use: false,
              useRefusal: 'device-not-granted',
              deviceGranted: { use: false, configure: false },
            }),
            entry({ capability: 'fleet', deviceGranted: { use: true, configure: true } }),
          ],
        })}
        onChange={() => {}}
      />,
    );

    // Assert
    expect(marked(renderer, 'data-grant-device-note')).toHaveLength(1);
    expect(text(renderer)).toContain('fy device grant <device> terminal --use');
    // The refusal reads as a widen of this device, never as a passkey or the operator's decision.
    expect(text(renderer)).toContain('this device has not been given it');
  });
});
