import { describe, expect, it } from 'bun:test';
import { type CapabilityGrantView, DAEMON_CAPABILITIES, type DaemonCapability } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { CapabilityList, WeightMark } from '../../../../src/features/settings/capability-list.tsx';
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
  daemonConnection({ daemonId: 'alpha', baseUrl: 'http://127.0.0.1:7431', deviceId: 'token-alpha' });

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

/**
 * The weight marks the CAPABILITY ROWS carry, never the legend's own keys.
 *
 * Both render a `data-capability-weight`, so a flat query answers with the legend's marks first and a
 * count that skipped a fixed number of them silently re-aimed at the legend the moment the legend
 * stopped carrying one of each. Every mark here is found inside a `data-capability-row`, so these
 * assertions are about the machine's real answers.
 */
const rowWeights = (renderer: ReactTestRenderer): string[] =>
  marked(renderer, 'data-capability-row').flatMap(row =>
    row
      .findAll(node => typeof node.type === 'string' && node.props['data-capability-weight'] !== undefined)
      .map(node => String(node.props['data-capability-weight'])),
  );

/** The keys the legend offers, in the order it offers them. */
const legendWeights = (renderer: ReactTestRenderer): string[] =>
  marked(renderer, 'data-capability-legend').flatMap(legend =>
    legend
      .findAll(node => typeof node.type === 'string' && node.props['data-capability-weight'] !== undefined)
      .map(node => String(node.props['data-capability-weight'])),
  );

/** One capability ROW's weight mark, or undefined when that capability rendered no row. */
const rowWeightMark = (renderer: ReactTestRenderer, capability: DaemonCapability) =>
  marked(renderer, 'data-capability-row')
    .find(node => node.props['data-capability-row'] === capability)
    ?.findAll(node => typeof node.type === 'string' && node.props['data-capability-weight'] !== undefined)[0];

/** Filled pips inside one mark: the shape a reader who cannot use the hue is left with. */
const filledPips = (mark: ReturnType<typeof rowWeightMark>): number =>
  mark
    ?.findAll(node => typeof node.type === 'string' && String(node.props.className ?? '').includes('h-2 w-2'))
    .filter(node => !String(node.props.className).includes('bg-transparent')).length ?? 0;

describe('there is no direct-local mark', () => {
  /**
   * THE TEST THE WHOLE SURFACE EXISTS TO PASS.
   *
   * A browser on `127.0.0.1` is a paired device like any other: only the CLI holding the admin token is
   * the owner at the machine. A screen that told a local browser its limits do not apply would invite it
   * to expect a widening it can never get, so even a daemon that reports "not governed" to this browser
   * must not be read as "you are at the machine".
   */
  it('reads a 127.0.0.1 page the daemon reported as governed as governed, never as at the machine', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );

    expect(attr(renderer, 'data-capability-posture')).toBe('governed');
    expect(attr(renderer, 'data-capability-posture-badge')).toBe('governed');
    const rendered = text(renderer);
    expect(rendered).toContain('even when it runs on the machine itself');
    expect(rendered).not.toContain('standing at the machine');
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).toBe('granted');
  });

  it('does not flatter a browser the daemon reported as not governed', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed={false} />,
    );
    expect(attr(renderer, 'data-capability-posture')).toBe('unknown');
    expect(text(renderer)).not.toContain('standing at the machine');
    for (const mark of marked(renderer, 'data-capability-reason'))
      expect(mark.props['data-capability-reason']).toBe('unknown');
  });

  /** Absence is not evidence of anything: the safe reading is that the limits apply. */
  it('refuses to guess when the daemon did not say', () => {
    const renderer = render(<CapabilityList connection={localLookingConnection()} capabilities={[]} />);
    expect(attr(renderer, 'data-capability-posture')).toBe('unknown');
    const rendered = text(renderer);
    expect(rendered).toContain('did not say how it saw this connection');
    expect(rendered).toContain('applying to this browser');
  });

  it('does not read the posture off the capabilities: only the daemon’s own answer counts', () => {
    const local = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities({ mayGrant: true })} />,
    );
    expect(attr(local, 'data-capability-posture')).toBe('unknown');
  });

  it('derives the posture from the daemon boolean alone, with no page input at all', () => {
    expect(connectionPosture(true)).toBe('governed');
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

  it('distinguishes an axis waiting on a passkey from one the operator allowed outright', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[entry({ capability: 'fleet', configure: false, configureRefusal: 'step-up-required' })]}
        governed
      />,
    );
    const reasons = marked(renderer, 'data-capability-open-reason').map(node => [
      node.props['data-capability-open-reason'],
      node.props['data-capability-reason'],
    ]);
    expect(reasons).toEqual([
      ['fleet.use', 'granted'],
      ['fleet.configure', 'step-up'],
    ]);
  });

  it('labels a step-up row with the passkey, and never with a password', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[entry({ capability: 'terminal', use: false, useRefusal: 'step-up-required' })]}
        governed
      />,
    );
    const rendered = text(renderer);
    expect(rendered).toContain('Open — after your passkey');
    expect(rendered).not.toMatch(/password|unlock/iu);
  });

  it('always shows the one-way notice, and never a two-way one, even for a 127.0.0.1 page', () => {
    for (const governed of [true, false, undefined]) {
      const renderer = render(
        <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed={governed} />,
      );
      expect(text(renderer)).toContain('never back on');
      expect(text(renderer)).toContain('even on the machine itself');
      expect(text(renderer)).not.toContain('both ways');
    }
  });

  it('says a switched-off capability a remote caller may not widen can only be turned on at the machine', () => {
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
            mayGrant: false,
          }),
        ]}
        governed
      />,
    );
    expect(marked(renderer, 'data-capability-only-at-machine')).toHaveLength(1);
  });

  it('computes the reason from the axis and the posture, never from one alone', () => {
    const open = entry();
    expect(openReason(open, 'use', 'governed')).toBe('granted');
    expect(openReason(open, 'use', 'unknown')).toBe('unknown');
    const shut = entry({ use: false, useRefusal: 'not-granted' });
    for (const posture of ['governed', 'unknown'] as const) expect(openReason(shut, 'use', posture)).toBe('closed');
  });
});

describe('how much each capability hands over', () => {
  it('does not render five rows that look alike', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    const weights = rowWeights(renderer);
    expect(new Set(weights).size).toBeGreaterThan(1);
    expect(weights).toContain('broad');
    expect(weights).toContain('moderate');
  });

  it('weighs every capability that runs programs or writes host files as the widest', () => {
    expect(capabilityWeight('fleet')).toBe('broad');
    expect(capabilityWeight('terminal')).toBe('broad');
    expect(capabilityWeight('filesystem')).toBe('broad');
  });

  it('lists the secret store as a seventh row with its own label and the dangerous tier, then catalog sharing', () => {
    // Arrange, Act
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );

    // Assert
    const rows = marked(renderer, 'data-capability-row');
    expect(rows).toHaveLength(8);
    expect(rows[6]?.props['data-capability-row']).toBe('secrets');
    expect(text(renderer)).toContain('Secrets');
    expect(text(renderer)).toContain('code on this machine');
    expect(rowWeights(renderer)[6]).toBe('broad');
    expect(rows[7]?.props['data-capability-row']).toBe('sharing');
    expect(text(renderer)).toContain('Sharing');
    expect(text(renderer)).toContain('exporting them as signed files');
    expect(rowWeights(renderer)[7]).toBe('moderate');
  });

  it('says which axis THIS device’s own grant withholds, only on a row where that is true', () => {
    // Arrange
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[
          entry({ capability: 'fleet', deviceGranted: { use: true, configure: true } }),
          entry({ capability: 'terminal', deviceGranted: { use: false, configure: false } }),
          entry({ capability: 'browser' }),
        ]}
        governed
      />,
    );

    // Assert — one note, on the terminal row alone, and it names the remedy.
    expect(marked(renderer, 'data-capability-device-note')).toHaveLength(1);
    expect(attr(renderer, 'data-capability-device-note')).toBe('terminal');
    expect(text(renderer)).toContain('has not been given use or configure of session terminals');
    expect(text(renderer)).toContain('fy device grant <device> terminal --use');
  });

  it('declares a weight for every capability the protocol has, so a sixth cannot render unmarked', () => {
    for (const capability of DAEMON_CAPABILITIES) expect(capabilityWeight(capability)).toBeTruthy();
  });

  /** Colour alone would make this an accessibility failure exactly where it matters most. */
  it('encodes the weight in form as well as colour on the rows themselves', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    expect(marked(renderer, 'data-capability-legend')).toHaveLength(1);
    // A ROW's mark, not the legend's: `fleet` is `broad`, and its pips must say so without the hue.
    const fleetMark = rowWeightMark(renderer, 'fleet');
    expect(fleetMark?.props['data-capability-weight']).toBe('broad');
    expect(filledPips(fleetMark)).toBe(3);
    // The mark is readable by a screen reader too, not only by eye.
    expect(String(fleetMark?.props['aria-label'])).toContain('Widens access most');
    // And a lighter class still renders fewer pips, so the shape carries the difference.
    const browserMark = rowWeightMark(renderer, 'browser');
    expect(browserMark?.props['data-capability-weight']).toBe('moderate');
    expect(filledPips(browserMark)).toBe(2);
  });

  /**
   * A key for a class nobody is in sends a reader hunting for the row that must be read-only.
   *
   * This is the assertion that would have caught `filesystem` moving to `broad` while the legend went
   * on advertising "Reads only" against no row at all.
   */
  it('keys only the weights the rendered rows actually carry', () => {
    const renderer = render(
      <CapabilityList connection={localLookingConnection()} capabilities={allCapabilities()} governed />,
    );
    expect(new Set(legendWeights(renderer))).toEqual(new Set(rowWeights(renderer)));
  });

  it('shrinks the legend to the one class a single-row daemon reported', () => {
    const renderer = render(
      <CapabilityList
        connection={localLookingConnection()}
        capabilities={[entry({ capability: 'warden' })]}
        governed
      />,
    );
    expect(rowWeights(renderer)).toEqual(['moderate']);
    expect(legendWeights(renderer)).toEqual(['moderate']);
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

describe('the access-weight mark on its own', () => {
  it('draws one pip in the "safe" colour and says it only reads, for the narrow class no row carries today', () => {
    const mark = render(<WeightMark weight="narrow" />);
    const root = mark.root.findByProps({ 'data-capability-weight': 'narrow' });
    const pips = mark.root.findAll(
      node => typeof node.type === 'string' && String(node.props.className ?? '').includes('h-2 w-2'),
    );
    const filled = pips.filter(pip => !String(pip.props.className).includes('bg-transparent'));

    expect(String(root.props['aria-label'])).toContain('Reads only');
    expect(pips).toHaveLength(3);
    expect(filled).toHaveLength(1);
    expect(String(filled[0]?.props.className)).toContain('border-ok-border bg-ok');
  });

  it('colours the other classes warm so the three never read alike', () => {
    const colourOf = (weight: 'broad' | 'moderate') => {
      const mark = render(<WeightMark weight={weight} />);
      return String(
        mark.root.findAll(
          node => typeof node.type === 'string' && String(node.props.className ?? '').includes('h-2 w-2'),
        )[0]?.props.className,
      );
    };

    expect(colourOf('broad')).toContain('bg-err');
    expect(colourOf('moderate')).toContain('bg-warn');
  });
});
