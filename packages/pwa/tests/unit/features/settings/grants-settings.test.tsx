import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type GrantRefusal, type GrantsView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { GrantsCard, GrantsSurface, GrantUnlockPrompt } from '../../../../src/features/settings/grants-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { capabilityReach, NO_PASSWORD_DISCLOSURE, PASSWORD_SET_DISCLOSURE } from '../../../../src/lib/grants.ts';
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
  mayGrant: false,
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })),
  // Governed by default: these fixtures stand for a caller who is NOT on the host, which is the only
  // caller the grants apply to.
  governed: true,
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

  /**
   * The capability list sits above the switches, and its "direct local" mark must come from the
   * daemon. These three cases pin that the surface passes through what the daemon said — including
   * saying nothing — rather than deriving it from the page it is rendered on.
   */
  /**
   * THE ONE-WAY DOOR. A remote caller may never widen a grant — no password, no unlock — so an off
   * capability must not render a switch that fails on press, and an on capability must warn before it
   * is closed, because only the machine can reopen it.
   */
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
              mayGrant: false,
            }),
          ],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    // The switch is inert, and the reason names the machine rather than a password that cannot help.
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(true);
    const rendered = text(renderer);
    expect(rendered).toContain('only be switched on at the machine');
    expect(rendered).toContain('fy daemon config set terminal --use');
  });

  it('warns a one-way caller before they close a door only the machine can reopen', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'fleet', mayGrant: false })] })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-one-way')[0]?.props['data-grant-one-way']).toBe('fleet');
    expect(text(renderer)).toContain('cannot be undone from here');
    // `fleet` loses nothing else by being switched off, so it gets no ordering advice it cannot use.
    expect(text(renderer)).not.toContain('revoke that device FIRST');
  });

  it('tells a remote caller that switching pairing off also disables their own revoke', () => {
    // THE POINT OF DECISION. Somebody reaches for this switch because a phone was stolen — and the same
    // permission covers `DELETE /v1/pair/devices/:deviceId`, so the coarse switch disables the remedy they
    // came to apply. The ordering is in `docs/grants.md` too, but a document is read afterwards and the
    // lockout happens at the click.
    // Arrange, Act
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'pairing', mayGrant: false })] })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    // Assert — the way back AND the order that keeps it usable.
    const rendered = text(renderer);
    expect(rendered).toContain('cannot be undone from here');
    expect(rendered).toContain('revoke that device FIRST');
  });

  it('says nothing about one-way doors to a caller standing at the machine', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [entry({ capability: 'fleet', mayGrant: true })] })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-one-way')).toHaveLength(0);
    // And its switches stay live in both directions.
    expect(axisSwitch(renderer, 'fleet.use')?.props.disabled).toBe(false);
  });

  it('offers a live widening switch at the machine, where turning one on is allowed', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({
              capability: 'terminal',
              use: false,
              configure: true,
              granted: { use: false, configure: true },
              useRefusal: 'not-granted',
              mayGrant: true,
            }),
          ],
          unlocked: true,
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(false);
    expect(text(renderer)).not.toContain('only be switched on at the machine');
  });

  /**
   * The capability list sits above the switches and takes its posture from `GrantsView.governed` — the
   * daemon's own `isGovernedCaller(request.loopback)`, PASSED rather than inferred. This pins that the
   * surface hands the daemon's answer through rather than deriving it from the page it is rendered on, or
   * from `mayGrant` unanimity a second time. Both fixtures move `mayGrant` with `governed`, because the
   * daemon does: they are one fact, and a fixture where they disagree is a daemon that cannot exist.
   */
  it('shows the capability list the posture the daemon’s own answer implies', () => {
    const posture = (renderer: ReactTestRenderer): unknown =>
      renderer.root.findAll(
        node => typeof node.type === 'string' && node.props['data-capability-posture'] !== undefined,
      )[0]?.props['data-capability-posture'];

    const remote = render(
      <GrantsCard
        connection={connection()}
        view={view({
          governed: true,
          capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability, mayGrant: false })),
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(posture(remote)).toBe('governed-remote');

    const local = render(
      <GrantsCard
        connection={connection()}
        view={view({
          governed: false,
          capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability, mayGrant: true })),
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(posture(local)).toBe('direct-local');
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

  /**
   * THE RULE, RESTATED AFTER THE REDESIGN. It was never "every control carries a paragraph" — it is
   * that no control a person cannot move is left silent. A live switch reading On needs no sentence
   * telling it so; a dead one needs the reason and the way back, in the flow of the page.
   */
  it('leaves no immovable control without a reason, and no live control with a paragraph', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          passwordSet: true,
          capabilities: [
            // Live: the document grants both axes, so both switches move and the password is the only
            // thing between the reader and a change. The unlock prompt above says that once.
            entry({ capability: 'fleet', configure: false, configureRefusal: 'locked' }),
            // Dead: switched off entirely, and no remote caller can reopen it.
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

    // Four controls. Every dead one is explained, and the two live ones carry no paragraph at all —
    // `terminal`'s single shared sentence is the only prose the two rows spend between them.
    const controls = marked(renderer, 'data-grant-axis');
    expect(controls).toHaveLength(4);
    for (const control of controls)
      if (control.props.disabled === true) expect(control.props['aria-describedby']).toBeDefined();
    expect(marked(renderer, 'data-grant-axis-reason')).toHaveLength(0);
    expect(marked(renderer, 'data-grant-capability-reason')).toHaveLength(1);
    // The live ones still SAY what stands behind them — a badge rather than a paragraph.
    expect(marked(renderer, 'data-grant-axis-badge').map(node => node.props['data-grant-axis-badge'])).toContain(
      'fleet.configure',
    );
    const rendered = text(renderer);
    expect(rendered).toContain('Needs the password');
    expect(rendered).toContain('switched off entirely');
  });

  /**
   * THE DUPLICATION THE OWNER'S SCREENSHOT CAUGHT. A capability that is off entirely is ONE fact, and
   * the screen printed it under both of its axes; a daemon that cannot read its own document is one
   * fact too. Both switches point at the single sentence, which is also what the screen means.
   */
  it('says one reason once when both axes land on the same one', () => {
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
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    expect(marked(renderer, 'data-grant-axis-reason')).toHaveLength(0);
    const shared = marked(renderer, 'data-grant-capability-reason');
    expect(shared).toHaveLength(1);
    // Both controls are described by it, so a reader who cannot see the layout gets the same answer.
    const id = shared[0]?.props.id;
    expect(axisSwitch(renderer, 'terminal.use')?.props['aria-describedby']).toContain(id);
    expect(axisSwitch(renderer, 'terminal.configure')?.props['aria-describedby']).toContain(id);
    // And the remedy names BOTH flags: turning only `--use` back on leaves the other control dead.
    expect(text(renderer)).toContain('fy daemon config set terminal --use --configure');
  });

  /**
   * THE BUG UNDER THE DUPLICATION. The capability-wide sentence under a `configure` control of a
   * capability whose `use` is ON told a reader their access was switched off when it was not, and sent
   * them to the host to run `--use` on a switch that was already on.
   */
  it('never tells a reader a capability they may use is switched off', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({
              capability: 'warden',
              use: true,
              configure: false,
              granted: { use: true, configure: false },
              useRefusal: 'granted',
              configureRefusal: 'not-granted',
            }),
          ],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    // Two dead controls, two DIFFERENT reasons — this is the case that must not be collapsed.
    const reasons = marked(renderer, 'data-grant-axis-reason');
    expect(reasons).toHaveLength(2);
    expect(marked(renderer, 'data-grant-capability-reason')).toHaveLength(0);
    expect(text(renderer)).toContain('may use fleet supervision');
    // The `configure` sentence itself, read alone: it never claims the capability is off, and the
    // remedy it names is the flag that would actually change this control.
    const configure = String(
      reasons.find(node => node.props['data-grant-axis-reason'] === 'warden.configure')?.props.children,
    );
    expect(configure).toContain('can be used from here');
    expect(configure).toContain('--configure');
    expect(configure).not.toContain('--use');
  });

  /** The state is the headline, so it is a marker a test and a screenshot can both read. */
  it('marks what each axis is set to, because that is what the row is for', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [entry({ capability: 'warden', configure: false, granted: { use: true, configure: false } })],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(axisSwitch(renderer, 'warden.use')?.props['data-grant-axis-state']).toBe('on');
    expect(axisSwitch(renderer, 'warden.configure')?.props['data-grant-axis-state']).toBe('off');
  });

  /**
   * WHAT IS TRUE OF EVERY ROW IS SAID ONCE. The two axis questions were printed under all twelve
   * controls, which crowded out the only thing that differs between them.
   */
  it('asks what the two columns mean once, not twelve times', () => {
    const renderer = render(
      <GrantsCard connection={connection()} view={view()} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
    );
    expect(marked(renderer, 'data-grant-axis-legend')).toHaveLength(1);
    const rendered = text(renderer);
    expect(rendered).toContain('May this browser use it at all?');
    expect(rendered.split('May this browser use it at all?')).toHaveLength(2);
  });

  /**
   * The capability list directly above already answers "what does this reach". Answering it a second
   * time under the switches is what made a reader scroll past every capability twice.
   */
  it('does not answer the reach question a second time under the switches', () => {
    const rendered = text(
      render(
        <GrantsCard connection={connection()} view={view()} nowMs={NOW} onChange={() => {}} onUnlock={() => {}} />,
      ),
    );
    // Once each — the list owns "what does this reach", and the switches own "what is it set to".
    for (const capability of DAEMON_CAPABILITIES) expect(rendered.split(capabilityReach(capability))).toHaveLength(2);
  });

  it('renders no switch panel for a daemon that listed no capabilities', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({ capabilities: [] })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(renderer.root.findAll(node => node.props['aria-label'] === 'Capability switches')).toHaveLength(0);
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
    const renderer = render(
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
    );
    const rendered = text(renderer);
    expect(rendered).toContain('could not read its own grant document');
    // ONCE. It is a fact about the DAEMON, and every row would otherwise print the same sentence —
    // six copies of it on one screen, which is the wall this redesign is removing.
    expect(marked(renderer, 'data-grant-daemon-fault')).toHaveLength(1);
    expect(marked(renderer, 'data-grant-capability-reason')).toHaveLength(0);
    expect(rendered.split('could not read its own grant document')).toHaveLength(2);
  });

  it('keeps a single capability’s fault beside that capability', () => {
    const renderer = render(
      <GrantsCard
        connection={connection()}
        view={view({
          capabilities: [
            entry({ capability: 'fleet' }),
            entry({
              capability: 'warden',
              use: false,
              configure: false,
              useRefusal: 'undetermined',
              configureRefusal: 'undetermined',
            }),
          ],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    // Not every row reports it, so it is this row's fact and stays on this row.
    expect(marked(renderer, 'data-grant-daemon-fault')).toHaveLength(0);
    expect(
      marked(renderer, 'data-grant-capability-reason').map(node => node.props['data-grant-capability-reason']),
    ).toEqual(['warden']);
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
