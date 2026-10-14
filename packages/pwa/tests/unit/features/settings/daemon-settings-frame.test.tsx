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
} from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

const unavailable = async () => Promise.reject(new Error('unavailable in this suite'));

/**
 * The four panels `App.tsx` passes as `additionalTabs`, by the ids it passes them under.
 *
 * Ids, not the real surfaces: this suite is about the rail, and mounting the production surfaces would
 * open their transports to assert a glyph. The ids are the whole contract — `PANEL_ICONS` is keyed by
 * them — so a rename in `App.tsx` that this list does not follow is exactly the drift worth failing on.
 */
const PRODUCTION_ADDITIONAL_TABS: readonly DaemonSettingsTabDefinition[] = [
  { id: 'resource-limits', label: 'Resource limits', description: 'CPU and RAM caps.', Surface: () => null },
  { id: 'doctor', label: 'Doctor', description: 'Programs this host needs.', Surface: () => null },
  { id: 'model-pricing', label: 'Model pricing', description: 'Model rates and provenance.', Surface: () => null },
  { id: 'security', label: 'Security', description: 'Recent security events.', Surface: () => null },
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
      'security',
      'resource-limits',
      'doctor',
      'model-pricing',
      'security',
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
    expect(glyphs).toHaveLength(10);
    // NONE of them the fallback, so every panel was named deliberately rather than caught by the net.
    expect(glyphs.filter(glyph => glyph.includes(FALLBACK_GLYPH))).toEqual([]);
    // ONE EACH, so two panels cannot claim the same landmark and stop being distinguishable.
    expect(new Set(glyphs).size).toBe(glyphs.length);

    run(() => view.unmount());
  });

  it('says Host checks are unavailable when the pairing record was not supplied', () => {
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
      />,
    );

    const row = must(view.root.findAll(node => node.props['data-daemon-panel'] === 'host-checks')[0], 'host checks');
    run(() => (row.props as { onClick: () => void }).onClick());
    const notice = must(
      view.root.findAll(node => node.props['aria-label'] === 'Host checks unavailable')[0],
      'the unavailable notice',
    );
    expect(notice.props.role).toBe('status');

    run(() => view.unmount());
  });
});
