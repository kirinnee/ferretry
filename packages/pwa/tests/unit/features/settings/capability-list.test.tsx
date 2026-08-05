import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { CapabilityList } from '../../../../src/features/settings/capability-list.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { capabilityWeight, connectionPosture, openReason } from '../../../../src/lib/grants.ts';
import { render } from '../../../support/react.ts';

/**
 * The daemon is on loopback AS AN ADDRESS in every fixture here, deliberately.
 *
 * That is the trap this whole file exists to catch: `127.0.0.1` in a URL says nothing about how the
 * request arrived, because the relay terminates on the host it serves. Every test below builds a
 * connection that LOOKS local and then varies only what the daemon reported.
 */
const localLookingConnection = () =>
  daemonConnection({ daemonId: 'alpha', baseUrl: 'http://127.0.0.1:7431', deviceToken: 'token-alpha' });

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

const allCapabilities = (overrides: Partial<CapabilityGrantView> = {}): readonly CapabilityGrantView[] =>
  DAEMON_CAPABILITIES.map(capability => entry({ capability, ...overrides }));

const text = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const marked = (renderer: ReactTestRenderer, attribute: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props[attribute] !== undefined);

const attr = (renderer: ReactTestRenderer, attribute: string): unknown =>
  marked(renderer, attribute)[0]?.props[attribute];

describe('the direct-local mark', () => {
  /**
   * THE TEST THE WHOLE SURFACE EXISTS TO PASS.
   *
   * A browser on `127.0.0.1` reaching the daemon through the relay is a REMOTE caller. A screen that
   * decided this from its own address bar would tell that person they were standing at the machine —
   * the exact inversion the grant layer was built to prevent, re-introduced in the UI layer where
   * nobody would think to look for it.
   */
  it('does not claim direct local for a 127.0.0.1 page the daemon reported as governed', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );

    expect(attr(renderer, 'data-capability-posture')).toBe('governed-remote');
    expect(attr(renderer, 'data-capability-posture-badge')).toBe('governed-remote');
    // The words a person reads must agree with the marker.
    const rendered = text(renderer);
    expect(rendered).toContain('reached the machine from somewhere else');
    expect(rendered).not.toContain('standing at the machine, not because it was granted');
    // And not one row may claim the ungoverned reason.
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).not.toBe('ungoverned');
  });

  it('says direct local only when the daemon itself reported an ungoverned caller', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed={false} />,
    );
    expect(attr(renderer, 'data-capability-posture')).toBe('direct-local');
    expect(text(renderer)).toContain('standing at the machine');
    // Every open row is open for the ungoverned reason, which is the fact the owner asked to surface.
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).toBe('ungoverned');
  });

  /**
   * Absence is not evidence of loopback. The flattering assumption is the dangerous one here: it would
   * paint a remote phone as standing at the machine on any daemon too old to report the fact.
   */
  it('refuses to guess when the daemon did not say, and does not read the friendly answer', () => {
    // Nothing to read the posture FROM: no explicit prop, and no capabilities carrying `mayGrant`.
    // The friendly reading would be "local"; the safe one is "cannot tell", and this pins the safe one.
    const renderer = render(<CapabilityList connection={localLookingConnection()} capabilities={[]} />);
    expect(attr(renderer, 'data-capability-posture')).toBe('unknown');
    const rendered = text(renderer);
    expect(rendered).toContain('did not say how it saw this connection');
    // It explicitly tells the reader the address bar is not the answer.
    expect(rendered).toContain('does not answer this');
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).not.toBe('ungoverned');
  });

  /**
   * The posture is read from `mayGrant`, which the daemon computes as `!governed`. So the fact arrives
   * once, per capability, and the list reads it back rather than asking for a duplicate field that
   * could disagree with it.
   */
  it('reads the posture off the capabilities when no explicit answer is supplied', () => {
    const remote = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities({ mayGrant: false })} />,
    );
    expect(attr(remote, 'data-capability-posture')).toBe('governed-remote');

    const local = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities({ mayGrant: true })} />,
    );
    expect(attr(local, 'data-capability-posture')).toBe('direct-local');
  });

  it('will not name a posture when the capabilities disagree about it', () => {
    // Every capability on one connection derives from one request's carrier, so a split answer is
    // damaged evidence rather than a posture — and damaged evidence must not pick the friendly side.
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[
          entry({ capability: 'fleet', mayGrant: true }),
          entry({ capability: 'warden', mayGrant: false }),
        ]}
      />,
    );
    expect(attr(renderer, 'data-capability-posture')).toBe('unknown');
  });

  it('derives the posture from the daemon boolean alone, with no page input at all', () => {
    expect(connectionPosture(false)).toBe('direct-local');
    expect(connectionPosture(true)).toBe('governed-remote');
    expect(connectionPosture(undefined)).toBe('unknown');
  });

  /**
   * A structural guard, because the failure mode is a future edit rather than today's code: the moment
   * somebody reaches for `location` or a `baseUrl` to answer this question, the inversion is back.
   */
  it('contains no page-derived source for the posture', async () => {
    const source = await Bun.file(
      new URL('../../../../src/features/settings/capability-list.tsx', import.meta.url).pathname,
    ).text();
    // COMMENTS ARE STRIPPED FIRST. The module's own header explains why an address bar is not the
    // answer, and a bare substring search would fire on that explanation — a gate that punishes the
    // documentation of a rule for stating the rule. This asks about the CODE.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
    for (const forbidden of ['location.hostname', 'window.location', 'location.origin', 'daemon.baseUrl', '127.0.0.1'])
      expect(code).not.toContain(forbidden);
  });
});

describe('why each capability is open', () => {
  it('marks a closed axis as closed rather than leaving it to be inferred', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[
          entry({
            capability: 'terminal',
            use: false,
            configure: false,
            granted: { use: false, configure: false },
            useRefusal: 'not-granted',
            configureRefusal: 'not-granted',
          }),
        ]}
        governed
      />,
    );
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).toBe('closed');
  });

  it('distinguishes an axis nothing is standing behind from one the operator allowed', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[entry({ capability: 'fleet', configureRefusal: 'ungated' })]}
        governed
      />,
    );
    const reasons = marked(renderer, 'data-capability-open-reason').map(node => [
      node.props['data-capability-open-reason'],
      node.props['data-capability-reason'],
    ]);
    expect(reasons).toEqual([
      ['fleet.use', 'granted'],
      ['fleet.configure', 'ungated'],
    ]);
  });

  it('computes the reason from the axis and the posture, never from one alone', () => {
    const open = entry();
    expect(openReason(open, 'use', 'direct-local')).toBe('ungoverned');
    expect(openReason(open, 'use', 'governed-remote')).toBe('granted');
    expect(openReason(open, 'use', 'unknown')).toBe('unknown');
    // A closed axis reads closed on every posture: being at the machine does not reopen it.
    const shut = entry({ use: false, useRefusal: 'not-granted' });
    for (const posture of ['direct-local', 'governed-remote', 'unknown'] as const)
      expect(openReason(shut, 'use', posture)).toBe('closed');
  });
});

describe('how much each capability hands over', () => {
  it('does not render five rows that look alike', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    const weights = marked(renderer, 'data-capability-weight')
      .map(node => String(node.props['data-capability-weight']))
      // The legend carries one of each; the rows carry the real answers.
      .slice(3);
    expect(new Set(weights).size).toBeGreaterThan(1);
    expect(weights).toContain('broad');
    expect(weights).toContain('narrow');
  });

  it('weighs the two capabilities that run or write programs as the widest', () => {
    expect(capabilityWeight('fleet')).toBe('broad');
    expect(capabilityWeight('terminal')).toBe('broad');
    expect(capabilityWeight('filesystem')).toBe('narrow');
  });

  it('declares a weight for every capability the protocol has, so a sixth cannot render unmarked', () => {
    for (const capability of DAEMON_CAPABILITIES) expect(capabilityWeight(capability)).toBeTruthy();
  });

  /** Colour alone would make this an accessibility failure exactly where it matters most. */
  it('encodes the weight in form as well as colour, and carries a legend', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    expect(marked(renderer, 'data-capability-legend')).toHaveLength(1);
    const broad = marked(renderer, 'data-capability-weight').find(
      node => node.props['data-capability-weight'] === 'broad',
    );
    // Three pips for broad, one for narrow: a shape, not a hue.
    const pipsOf = (weight: string): number => {
      const mark = marked(renderer, 'data-capability-weight').find(
        node => node.props['data-capability-weight'] === weight,
      );
      return (
        mark
          ?.findAll(node => typeof node.type === 'string' && String(node.props.className ?? '').includes('h-2 w-2'))
          .filter(node => !String(node.props.className).includes('bg-transparent')).length ?? 0
      );
    };
    expect(broad).toBeDefined();
    expect(pipsOf('broad')).toBe(3);
    expect(pipsOf('narrow')).toBe(1);
    // The mark is readable by a screen reader too, not only by eye.
    expect(String(broad?.props['aria-label'])).toContain('Widens access most');
  });
});

describe('the list itself', () => {
  it('states once that this is about this browser on this machine', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    expect(marked(renderer, 'data-capability-scope-note')).toHaveLength(1);
    expect(text(renderer)).toContain('THIS browser');
    expect(text(renderer)).toContain('Another device paired to the same machine can have different answers');
  });

  it('renders rows in the protocol’s declared order rather than the order they arrived', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={[...allCapabilities()].reverse()} governed />,
    );
    expect(marked(renderer, 'data-capability-row').map(node => node.props['data-capability-row'])).toEqual([
      ...DAEMON_CAPABILITIES,
    ]);
  });

  it('invents no row for a capability the daemon did not report', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[entry({ capability: 'warden' })]}
        governed
      />,
    );
    expect(marked(renderer, 'data-capability-row')).toHaveLength(1);
  });

  it('calls an empty list a failed read rather than a machine with no limits', () => {
    const renderer = render(<CapabilityList connection={localLookingConnection()} capabilities={[]} governed />);
    expect(text(renderer)).toContain('failed read rather');
    expect(marked(renderer, 'data-capability-row')).toHaveLength(0);
  });

  it('is keyed by the daemon it describes, so one machine’s answers cannot read as another’s', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    expect(attr(renderer, 'data-capability-list')).toBe('alpha');
  });
});
