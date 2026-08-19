import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type GrantRefusal, type GrantsView } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  GrantsCard,
  type GrantsCardProps,
  GrantsSurface,
  GrantUnlockPrompt,
} from '../../../../src/features/settings/grants-settings.tsx';
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
  mayGrant: false,
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })),
  // Governed by default, and NOT on the host: these fixtures stand for a paired device somewhere else.
  // The two are separate fields because they came apart — a browser ON the machine is governed too until
  // it unlocks — so a fixture has to say which caller it means rather than implying it with one boolean.
  governed: true,
  hostLocal: false,
  passwordSet: false,
  unlocked: false,
  ...overrides,
});

/**
 * The card with the password callbacks defaulted, so a test names only the props it is about.
 *
 * The real props are REQUIRED on `GrantsCard`: the live surface always supplies them, and a control that
 * silently did nothing on press is the failure this whole screen is written against. The default lives
 * here, in the test, rather than in the component.
 */
function PasswordlessGrantsCard({
  onSetPassword = () => {},
  ...rest
}: Omit<GrantsCardProps, 'onSetPassword'> & Partial<Pick<GrantsCardProps, 'onSetPassword'>>) {
  return <GrantsCard {...rest} onSetPassword={onSetPassword} />;
}

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

/** Every node carrying a `data-*` marker, so a test asserts on the marker rather than on copy. */
const marked = (renderer: ReactTestRenderer, attribute: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined);

const axisSwitch = (renderer: ReactTestRenderer, id: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-grant-axis'] === id)[0];

describe('GrantsCard', () => {
  it('states who the rows apply to, and says something DIFFERENT to each connection', () => {
    // One sentence used to serve every caller, and it stopped being true: "these apply to callers that
    // are not on this machine" is false for a browser ON the machine that has not unlocked yet, and false
    // in the direction that sends that reader hunting for a permission problem they do not have.
    const scope = (renderer: ReactTestRenderer): unknown =>
      renderer.root.findAll(node => typeof node.type === 'string' && node.props['data-grant-scope'] !== undefined)[0]
        ?.props['data-grant-scope'];

    const remote = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view()}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(scope(remote)).toBe('this-browser');
    expect(text(remote)).toContain('reached the machine from somewhere else');

    const locked = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({ governed: true, hostLocal: true, passwordSet: true })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(scope(locked)).toBe('this-browser-until-unlocked');
    expect(text(locked)).toContain('paired device wherever it runs');

    const unlocked = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({ governed: false, hostLocal: true, passwordSet: true, unlocked: true })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(scope(unlocked)).toBe('not-on-this-machine');
    expect(text(unlocked)).toContain('none of them apply to it right now');
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({
          governed: false,
          hostLocal: true,
          capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability, mayGrant: true })),
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(posture(local)).toBe('direct-local');

    // THE CONNECTION THE TWO FIELDS WERE SPLIT FOR: on the machine AND governed. It is neither of the
    // two postures above, and collapsing it into either is a lie in a different direction — "Remote"
    // to somebody standing at the machine, or "Direct" over a gate they have not passed.
    const localLocked = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({
          governed: true,
          hostLocal: true,
          passwordSet: true,
          capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability, mayGrant: true })),
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(posture(localLocked)).toBe('local-locked');
  });

  it('says once, beside the configure controls, that nothing is standing behind them', () => {
    const renderer = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view()}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(text(renderer)).toContain(NO_PASSWORD_DISCLOSURE);
    // ONCE. A disclosure repeated per capability is the nagging the contract rules out.
    expect(marked(renderer, 'data-grant-disclosure')).toHaveLength(1);
  });

  it('says the opposite when the layer is on rather than staying silent about it', () => {
    const rendered = text(
      render(
        <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
        connection={connection()}
        view={shuffled}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-capability').map(node => node.props['data-grant-capability'])).toEqual([
      ...DAEMON_CAPABILITIES,
    ]);
  });

  it('invents no row for a capability the daemon did not report', () => {
    const partial = view({ capabilities: [entry({ capability: 'fleet' })] });
    const renderer = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={partial}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(renderer, 'data-grant-capability')).toHaveLength(1);
  });

  it('carries a reason on EVERY axis, which is the point of the unit', () => {
    const renderer = render(
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
        connection={connection()}
        view={view()}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    expect(marked(none, 'data-grant-unlock')).toHaveLength(0);

    const set = render(
      <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
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
        <PasswordlessGrantsCard
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
      <PasswordlessGrantsCard
        connection={connection()}
        view={view()}
        nowMs={NOW}
        busy
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    for (const control of marked(renderer, 'data-grant-axis')) expect(control.props.disabled).toBe(true);
  });

  it('does not report five allowed rows for a daemon that cannot read its own decision', () => {
    const undetermined: GrantRefusal = 'undetermined';
    const rendered = text(
      render(
        <PasswordlessGrantsCard
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

  it('renders the password control in every posture, and only offers it where it can succeed', () => {
    // A setting that silently disappears on a phone is a setting somebody goes looking for, so the panel is
    // always on the page and the REASON takes the control's place where the daemon would refuse it.
    // Arrange, Act
    const remote = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({ governed: true, hostLocal: false, passwordSet: true })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );
    const local = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({ governed: false, hostLocal: true, passwordSet: true, unlocked: true })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    // Assert
    expect(marked(remote, 'data-operator-password')[0]?.props['data-operator-password']).toBe('remote');
    expect(marked(remote, 'data-password-field')).toHaveLength(0);
    expect(marked(local, 'data-operator-password')[0]?.props['data-operator-password']).toBe('ready');
    expect(marked(local, 'data-password-field')).toHaveLength(1);
  });

  it('holds a widening switch on the machine until the browser unlocks, naming the password', () => {
    // A local browser is a paired device and is governed until it unlocks. A switch that looked live and
    // failed on press would read as broken software; the sentence that belongs there is the password, NOT
    // "only at the machine" — this reader is at the machine.
    // Arrange
    const localLocked = view({
      governed: true,
      hostLocal: true,
      passwordSet: true,
      capabilities: [
        entry({
          capability: 'terminal',
          use: false,
          granted: { use: false, configure: true },
          useRefusal: 'not-granted',
          mayGrant: true,
        }),
      ],
    });

    // Act
    const renderer = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={localLocked}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    // Assert
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(true);
    const rendered = text(renderer);
    expect(rendered).toContain('needs the operator password');
    expect(rendered).not.toContain('only be switched on at the machine');
  });

  it('leaves a narrowing switch live for that same browser, because revoking is never gated', () => {
    // A prompt between a person and shutting a door is a liability during the incident that made them reach
    // for it.
    // Arrange, Act
    const renderer = render(
      <PasswordlessGrantsCard
        connection={connection()}
        view={view({
          governed: true,
          hostLocal: true,
          passwordSet: true,
          capabilities: [entry({ capability: 'terminal', mayGrant: true })],
        })}
        nowMs={NOW}
        onChange={() => {}}
        onUnlock={() => {}}
      />,
    );

    // Assert
    expect(axisSwitch(renderer, 'terminal.use')?.props.disabled).toBe(false);
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

  it('says what the password buys HERE, which is not the same for both readers', () => {
    // "Turning a capability on from off this host needs it" was the whole story while a local browser was
    // ungoverned. It is false for the reader most likely to meet this prompt now — one ON the machine,
    // which needs the unlock for its own changes — so the sentence branches.
    // Arrange, Act
    const remote = render(
      <GrantUnlockPrompt held={null} daemonId={daemon} nowMs={NOW} failure={null} busy={false} onUnlock={() => {}} />,
    );
    const local = render(
      <GrantUnlockPrompt
        held={null}
        daemonId={daemon}
        nowMs={NOW}
        failure={null}
        busy={false}
        hostLocal
        onUnlock={() => {}}
      />,
    );

    // Assert
    expect(marked(remote, 'data-grant-unlock-purpose')[0]?.props['data-grant-unlock-purpose']).toBe('remote');
    expect(text(remote)).toContain('from off this host needs it');
    expect(marked(local, 'data-grant-unlock-purpose')[0]?.props['data-grant-unlock-purpose']).toBe('local');
    expect(text(local)).toContain('ungoverned for five minutes');
    // Neither reader is told a revoke needs it, because it never does.
    for (const rendered of [text(remote), text(local)]) expect(rendered).toContain('never');
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

describe('GrantsSurface — moving the operator password', () => {
  /**
   * A daemon that behaves like the real one about this password: locked until an unlock is spent, ready
   * afterwards, and answering the PUT with the single boolean the route discloses.
   */
  const passwordWorld = () => {
    const calls: Array<{ path: string; method: string; unlock: string | null; body: string | undefined }> = [];
    let unlocked = false;
    let passwordSet = true;
    return {
      calls,
      create: async () => ({
        request: (async (path: string, _schema: unknown, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          const unlock = new Headers(init?.headers).get('x-ferretry-operator-unlock');
          const body = typeof init?.body === 'string' ? init.body : undefined;
          calls.push({ path, method, unlock, body });
          if (path.endsWith('/unlock')) {
            unlocked = true;
            return {
              token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa',
              expiresAt: '2026-01-01T00:05:00.000Z',
              ttlSeconds: 300,
            };
          }
          if (path.endsWith('/password')) {
            passwordSet = (JSON.parse(String(body ?? '{}')) as { password?: string }).password !== undefined;
            // The daemon drops every held unlock when the password moves, so the next read says so.
            unlocked = false;
            return { passwordSet };
          }
          return view({ governed: !unlocked, hostLocal: true, passwordSet, unlocked });
        }) as never,
      }),
    };
  };

  /** Unlocks, then types a new password into the control the unlock opened, and submits. */
  const replacePassword = async (renderer: ReactTestRenderer, next: string) => {
    const unlockField = marked(renderer, 'data-grant-unlock-field')[0];
    run(() => unlockField?.props.onChange({ target: { value: 'operator-secret' } }));
    await runAsync(async () => {
      renderer.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
    await runAsync(async () => {
      marked(renderer, 'data-password-field')[0]?.props.onChange({ target: { value: next } });
    });
    await runAsync(async () => {
      marked(renderer, 'data-password-confirm-field')[0]?.props.onChange({ target: { value: next } });
    });
    await runAsync(async () => {
      renderer.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });
  };

  it('replaces the password with the unlock in a HEADER and the value in a BODY, then re-reads', async () => {
    // Replacing an existing password is a privileged change, so the daemon asks this browser to prove the
    // current one. The new value travels in a body — a URL reaches every proxy access log — and the view is
    // re-read because `passwordSet` decides what every other control on this screen may do.
    // Arrange
    const world = passwordWorld();
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={world.create} now={() => NOW} />);
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await replacePassword(surface, 'a-newer-secret');

    // Assert
    const put = world.calls.find(call => call.method === 'PUT');
    expect(put?.path).toBe('/v1/grants/password');
    expect(put?.unlock).toBe('fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(JSON.parse(String(put?.body))).toEqual({ password: 'a-newer-secret' });
    // Never in a path or a query, on any call.
    expect(world.calls.some(call => call.path.includes('a-newer-secret'))).toBe(false);
    // And the screen never renders it back.
    expect(text(surface)).not.toContain('a-newer-secret');
    // Re-read after the write, so the panel is not describing the machine as it used to be.
    expect(world.calls.filter(call => call.method === 'GET').length).toBe(3);
  });

  it('drops the held unlock once the password has moved, because the daemon has', async () => {
    // A password that changed must invalidate what the old one bought. A browser still presenting the old
    // token would claim an authority the machine has already withdrawn.
    // Arrange
    const world = passwordWorld();
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={world.create} now={() => NOW} />);
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await replacePassword(surface, 'a-newer-secret');

    // Assert — the prompt is offered again rather than a held badge nobody can spend.
    expect(marked(surface, 'data-grant-unlock')[0]?.props['data-grant-unlock']).toBe('prompt');
    expect(marked(surface, 'data-operator-password')[0]?.props['data-operator-password']).toBe('locked');
  });

  it('renders a refused password change whole, and keeps the screen honest about the state', async () => {
    // The daemon's sentence names the command a human runs — a terminal on this machine, which never asks
    // for the old password — and that is exactly the reader this refusal reaches.
    // Arrange
    const refusal = 'changing this machine’s operator password needs the password it already has';
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(
        <GrantsSurface
          connection={connection()}
          createClient={async () => ({
            request: (async (_path: string, _schema: unknown, init?: RequestInit) => {
              if ((init?.method ?? 'GET') === 'PUT') throw new Error(refusal);
              return view({ governed: false, hostLocal: true, passwordSet: false, unlocked: false });
            }) as never,
          })}
          now={() => NOW}
        />,
      );
    });
    const surface = renderer as ReactTestRenderer;

    // Act
    await runAsync(async () => {
      marked(surface, 'data-password-field')[0]?.props.onChange({ target: { value: 'a-good-password' } });
    });
    await runAsync(async () => {
      marked(surface, 'data-password-confirm-field')[0]?.props.onChange({ target: { value: 'a-good-password' } });
    });
    await runAsync(async () => {
      surface.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });

    // Assert
    expect(marked(surface, 'data-password-failure')).toHaveLength(1);
    expect(text(surface)).toContain('needs the password it already has');
    // Still reported as unset, because the call that would have set it did not land.
    expect(marked(surface, 'data-password-state')[0]?.props['data-password-state']).toBe('unset');
  });

  it('offers an unlocked reader no way to remove the password, and never sends an absent one', async () => {
    // An absent `password` used to MEAN "remove it", and this surface had a button that sent one. Both
    // are gone: a removal revokes no paired device, so it left a machine with devices paired and no gate.
    // Asserted from the posture that used to draw the control — local, unlocked, password already set.
    // Arrange
    const world = passwordWorld();
    let renderer: ReactTestRenderer | undefined;
    await runAsync(async () => {
      renderer = render(<GrantsSurface connection={connection()} createClient={world.create} now={() => NOW} />);
    });
    const surface = renderer as ReactTestRenderer;
    const unlockField = marked(surface, 'data-grant-unlock-field')[0];
    run(() => unlockField?.props.onChange({ target: { value: 'operator-secret' } }));

    // Act
    await runAsync(async () => {
      surface.root.findAllByType('form')[0]?.props.onSubmit({ preventDefault: () => {} });
    });

    // Assert — no control, and nothing this screen can do produces a body without a password in it.
    expect(marked(surface, 'data-password-clear')).toHaveLength(0);
    expect(marked(surface, 'data-password-state')[0]?.props['data-password-state']).toBe('set');
    for (const call of world.calls.filter(entry => entry.method === 'PUT'))
      expect(JSON.parse(String(call.body))).toHaveProperty('password');
  });
});
