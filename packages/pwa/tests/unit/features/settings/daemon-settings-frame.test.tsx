/**
 * THE PANEL RAIL'S ICON CONTRACT — all the rows or none of them, one glyph each.
 *
 * The rail shipped with three of its ten rows carrying an icon. Because a row without one does not
 * indent its label, the column's left edge alternated between two x positions the whole way down; that
 * is what "the icons were uneven" and "some has icon and some don't" were describing, and it read as an
 * unfinished list because it was one.
 *
 * A SCREENSHOT CANNOT DEFEND THIS, which is why these assertions exist. The rail's built-in panels and
 * the panels the composition root supplies through `additionalTabs` come from different files, so the
 * way this regresses is somebody adding an eleventh panel and not the icon for it — on a branch whose
 * captures were all taken before that panel existed. The set is asserted against the ids `App.tsx`
 * really mounts, so a new panel with no icon fails here rather than in a review.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  DaemonSettingsFrame,
  type DaemonSettingsTabDefinition,
  orderedDaemonPanels,
} from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});

const unavailable = async () => Promise.reject(new Error('unavailable in this suite'));

/**
 * The five panels `App.tsx` passes as `additionalTabs`, by the ids it passes them under.
 *
 * Ids, not the real surfaces: this suite is about the rail, and mounting the production pricing,
 * fleet and accounts surfaces would open their transports to assert a glyph. The ids are the whole
 * contract — `PANEL_ICONS` is keyed by them — so a rename in `App.tsx` that this list does not follow
 * is exactly the drift worth failing on. `parentId` is part of that contract now too: it is what makes
 * Accounts a level under Fleet rather than a twelfth row beside it.
 */
const PRODUCTION_ADDITIONAL_TABS: readonly DaemonSettingsTabDefinition[] = [
  { id: 'resource-limits', label: 'Resource limits', description: 'CPU and RAM caps.', Surface: () => null },
  { id: 'doctor', label: 'Doctor', description: 'Programs this host needs.', Surface: () => null },
  { id: 'model-pricing', label: 'Model pricing', description: 'Model rates and provenance.', Surface: () => null },
  { id: 'fleet', label: 'Fleet', description: 'The accounts this host runs.', Surface: () => null },
  {
    id: 'accounts',
    parentId: 'fleet',
    label: 'Accounts',
    description: 'Each account’s login.',
    Surface: () => null,
  },
];

/** The glyph a panel gets when the table does not name its id. Present here means an entry is missing. */
const FALLBACK_GLYPH = 'lucide-sliders-horizontal';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // No panel's transport is the subject here; the rail is.
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('daemon settings panel rail', () => {
  it('draws exactly one distinct icon for every panel the composition root mounts', () => {
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        connections={[alpha]}
        name="Alpha"
        additionalTabs={PRODUCTION_ADDITIONAL_TABS}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
      />,
    );

    const rows = view.root.findAll(node => node.props['data-daemon-panel'] !== undefined);
    expect(rows.map(row => String(row.props['data-daemon-panel']))).toEqual([
      'warden',
      'secrets',
      'devices',
      'grants',
      'environment',
      'resource-limits',
      'doctor',
      'model-pricing',
      'fleet',
      // DIRECTLY UNDER ITS PARENT, and that placement is `orderedDaemonPanels`' doing rather than the
      // composition root's ordering. A child drawn indented under a row it does not follow would be a
      // hierarchy the rail claims and the list contradicts.
      'accounts',
      'carrier',
      'host-checks',
    ]);

    const glyphs = rows.map(row => {
      const svg = must(
        row.findAll(node => node.type === 'svg')[0],
        `panel ${String(row.props['data-daemon-panel'])} has no icon`,
      );
      return String(svg.props.className);
    });

    // ALL of them, so the label column has one left edge.
    expect(glyphs).toHaveLength(12);
    // NONE of them the fallback, so every panel was named deliberately rather than caught by the net.
    expect(glyphs.filter(glyph => glyph.includes(FALLBACK_GLYPH))).toEqual([]);
    // ONE EACH, so two panels cannot claim the same landmark and stop being distinguishable.
    expect(new Set(glyphs).size).toBe(glyphs.length);

    run(() => view.unmount());
  });

  /**
   * THE SECOND LEVEL, drawn where the rail actually is.
   *
   * The owner's complaint was that Accounts read as the wrong LEVEL, so the fix is only real if the
   * child is indented under its parent on screen. Asserted through the frame rather than the rail
   * alone because the frame is what turns a tab definition's `parentId` into a rail item's — and a
   * frame that dropped the field would pass every rail test and ship the flat list back.
   */
  it('draws the accounts panel indented under Fleet rather than beside it', () => {
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        connections={[alpha]}
        name="Alpha"
        additionalTabs={PRODUCTION_ADDITIONAL_TABS}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
      />,
    );

    const rowFor = (id: string) =>
      must(view.root.findAll(node => node.props['data-daemon-panel'] === id)[0], `the ${id} row`);

    expect(String(rowFor('accounts').props.className)).toContain('ml-md');
    // Its parent is not indented, so the two are genuinely at different levels rather than both
    // pushed in by a rail-wide change.
    expect(String(rowFor('fleet').props.className)).not.toContain('ml-md');

    run(() => view.unmount());
  });

  /**
   * A PANEL CAN SHOW A SIBLING, and that is what replaced the accounts ROUTE.
   *
   * Accounts' "Add an account" and the new-account sequence's two mentions of Accounts all move
   * between panels of one frame now. An id the frame does not mount is ignored rather than blanking
   * the frame or falling back to the first panel — a caller with a typo leaves the reader where they
   * are, which is the least surprising of the three.
   */
  it('lets a panel open a sibling by id, and ignores an id it does not mount', () => {
    const asked: ((id: string) => void)[] = [];
    const Prober = ({ openPanel }: { readonly openPanel: (id: string) => void }) => {
      asked.push(openPanel);
      return <p data-prober="">prober</p>;
    };
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        connections={[alpha]}
        name="Alpha"
        additionalTabs={[
          { id: 'fleet', label: 'Fleet', description: 'The accounts this host runs.', Surface: Prober },
          { id: 'accounts', parentId: 'fleet', label: 'Accounts', description: 'Logins.', Surface: () => null },
        ]}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
      />,
    );

    const openFleet = () => {
      const row = must(view.root.findAll(node => node.props['data-daemon-panel'] === 'fleet')[0], 'the fleet row');
      run(() => (row.props as { onClick: () => void }).onClick());
    };
    const openPanelId = (): string | undefined => {
      const panel = view.root.findAll(node => node.props.role === 'tabpanel')[0];
      return panel === undefined ? undefined : String(panel.props.id);
    };

    openFleet();
    expect(openPanelId()).toBe('daemon-settings-tab-fleet');

    // The move Fleet really makes.
    const move = asked[asked.length - 1];
    run(() => move?.('accounts'));
    expect(openPanelId()).toBe('daemon-settings-tab-accounts');

    // And an id nothing mounts leaves the reader on the panel they are reading.
    openFleet();
    const again = asked[asked.length - 1];
    run(() => again?.('not-a-panel'));
    expect(openPanelId()).toBe('daemon-settings-tab-fleet');

    run(() => view.unmount());
  });
});

/**
 * THE ORDERING RULE, ON ITS OWN.
 *
 * `orderedDaemonPanels` is what stops a rail from drawing a level its list contradicts, and the cases
 * that matter are the malformed ones: they must all come back as ordinary rows, because a settings
 * panel that vanished for declaring a relation badly would be unreachable with nothing on screen to
 * say so.
 */
describe('orderedDaemonPanels', () => {
  const tab = (id: string, parentId?: string): DaemonSettingsTabDefinition => ({
    id,
    label: id,
    description: id,
    ...(parentId === undefined ? {} : { parentId }),
    Surface: () => null,
  });
  const ids = (tabs: readonly DaemonSettingsTabDefinition[]): string[] => tabs.map(entry => entry.id);

  it('puts a child directly under its parent wherever the caller listed it', () => {
    expect(ids(orderedDaemonPanels([tab('a'), tab('child', 'a'), tab('b')]))).toEqual(['a', 'child', 'b']);
    // Listed BEFORE its parent, and still drawn under it: the relation decides, not the array.
    expect(ids(orderedDaemonPanels([tab('child', 'a'), tab('b'), tab('a')]))).toEqual(['b', 'a', 'child']);
    // Two children keep the caller's order among themselves.
    expect(ids(orderedDaemonPanels([tab('a'), tab('one', 'a'), tab('two', 'a')]))).toEqual(['a', 'one', 'two']);
  });

  it('keeps every panel in the list when the relation is one it cannot draw', () => {
    // A parent this frame does not mount.
    expect(ids(orderedDaemonPanels([tab('a'), tab('orphan', 'absent')]))).toEqual(['a', 'orphan']);
    // A panel naming itself.
    expect(ids(orderedDaemonPanels([tab('a'), tab('self', 'self')]))).toEqual(['a', 'self']);
    // Two panels naming each other, which no caller can mean and none may lose a panel to.
    expect(ids(orderedDaemonPanels([tab('x', 'y'), tab('y', 'x')]))).toEqual(['x', 'y']);
    // A grandchild: nesting is ONE level, so it stays a row rather than disappearing under a child.
    expect(ids(orderedDaemonPanels([tab('a'), tab('b', 'a'), tab('c', 'b')]))).toEqual(['a', 'b', 'c']);
  });
});
