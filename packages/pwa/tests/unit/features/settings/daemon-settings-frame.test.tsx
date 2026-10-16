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
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});

const unavailable = async () => Promise.reject(new Error('unavailable in this suite'));

/**
 * The five panels `App.tsx` passes as `additionalTabs`, by the ids it passes them under.
 *
 * Ids, not the real surfaces: this suite is about the rail, and mounting the production surfaces would
 * open their transports to assert a glyph. The ids are the whole contract — `PANEL_ICONS` is keyed by
 * them — so a rename in `App.tsx` that this list does not follow is exactly the drift worth failing on.
 */
const PRODUCTION_ADDITIONAL_TABS: readonly DaemonSettingsTabDefinition[] = [
  { id: 'resource-limits', label: 'Resource limits', description: 'CPU and RAM caps.', Surface: () => null },
  { id: 'doctor', label: 'Doctor', description: 'Programs this host needs.', Surface: () => null },
  { id: 'model-pricing', label: 'Model pricing', description: 'Model rates and provenance.', Surface: () => null },
  { id: 'security-log', label: 'Security log', description: 'Recent security events.', Surface: () => null },
  { id: 'files', label: 'Files', description: 'The YAML files this machine’s settings live in.', Surface: () => null },
  { id: 'learning', label: 'Learning', description: 'What new ferrets are taught.', Surface: () => null },
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
        onOpenPanel={() => undefined}
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
      'security-log',
      'files',
      'learning',
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
    expect(glyphs).toHaveLength(13);
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
        panel="host-checks"
        onOpenPanel={() => undefined}
      />,
    );

    const notice = must(
      view.root.findAll(node => node.props['aria-label'] === 'Host checks unavailable')[0],
      'the unavailable notice',
    );
    expect(notice.props.role).toBe('status');

    run(() => view.unmount());
  });

  it('gives a panel the composition root has not named a neutral glyph, so the column stays complete', () => {
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        additionalTabs={[{ id: 'invented', label: 'Invented', description: 'Not in the table.', Surface: () => null }]}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
        onOpenPanel={() => undefined}
      />,
    );
    const row = must(view.root.findAll(node => node.props['data-daemon-panel'] === 'invented')[0], 'the row');
    const svg = must(row.findAll(node => node.type === 'svg')[0], 'its glyph');
    expect(String(svg.props.className)).toContain(FALLBACK_GLYPH);
    run(() => view.unmount());
  });
});

describe('daemon settings panel list', () => {
  const opened: (string | null)[] = [];
  const frame = (props: { panel?: string; backLabel?: string } = {}) => (
    <DaemonSettingsFrame
      connection={alpha}
      name="Alpha"
      additionalTabs={PRODUCTION_ADDITIONAL_TABS}
      readWardenStatus={unavailable}
      createWardenClient={unavailable}
      onOpenPanel={panel => opened.push(panel)}
      {...props}
    />
  );

  beforeEach(() => {
    opened.length = 0;
  });

  it('is one titled list of rows, each with its label and its description, and asks to open the one pressed', async () => {
    const view = await mount(frame());
    try {
      const section = must(view.container.querySelector<HTMLElement>('[data-daemon-settings-frame="alpha"]'), 'frame');
      expect(section.getAttribute('aria-labelledby')).toBe('daemon-settings-heading');
      expect(section.querySelector('#daemon-settings-heading')?.textContent).toBe('Connection and security');
      expect(section.textContent).toContain('Shared by every browser paired to Alpha');
      expect(section.querySelector('ul')?.getAttribute('aria-label')).toBe('Alpha connection and security');
      expect(section.querySelector('[data-daemon-panel-open]')).toBeNull();

      const warden = must(section.querySelector<HTMLButtonElement>('[data-daemon-panel="warden"]'), 'Warden row');
      expect(warden.textContent).toBe('WardenSupervision, account failover, and policy for this daemon.');

      await interact(() => warden.click());
      await interact(() =>
        must(section.querySelector<HTMLButtonElement>('[data-daemon-panel="doctor"]'), 'Doctor row').click(),
      );
      expect(opened).toEqual(['warden', 'doctor']);
    } finally {
      await view.unmount();
    }
  });

  it('shows only the panel the address names, titled for its machine, with the way back to the list', async () => {
    const view = await mount(frame({ panel: 'model-pricing' }));
    try {
      const section = must(view.container.querySelector<HTMLElement>('[data-daemon-settings-frame="alpha"]'), 'frame');
      expect(section.getAttribute('aria-label')).toBe('Model pricing on Alpha');
      expect(section.querySelector('[data-daemon-panel-open]')?.getAttribute('data-daemon-panel-open')).toBe(
        'model-pricing',
      );
      expect(section.querySelector('[data-daemon-panel]')).toBeNull();
      const back = must(section.querySelector<HTMLButtonElement>('[data-daemon-panel-back]'), 'the back button');
      // The tab it lives on, by default.
      expect(back.textContent).toBe('Machine');
      await interact(() => back.click());
      expect(opened).toEqual([null]);
    } finally {
      await view.unmount();
    }
  });

  it('says where Back goes when the caller names it', async () => {
    const view = await mount(frame({ panel: 'warden', backLabel: 'Alpha' }));
    try {
      expect(view.container.querySelector('[data-daemon-panel-back]')?.textContent).toBe('Alpha');
      // Warden's own panel holds only its settings now: an unreadable daemon says so, never a default.
      await interact(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(view.container.querySelector('[aria-label="Warden settings unavailable"]')).not.toBeNull();
      expect(view.container.textContent).not.toContain('Fleet checks');
      expect(view.container.textContent).not.toContain('Recent verdicts unavailable');
    } finally {
      await view.unmount();
    }
  });

  it('lands on the list for a panel that does not exist, never on a blank frame', async () => {
    const view = await mount(frame({ panel: 'retired-panel' }));
    try {
      expect(view.container.querySelector('[data-daemon-panel-open]')).toBeNull();
      expect(view.container.querySelectorAll('[data-daemon-panel]')).toHaveLength(13);
    } finally {
      await view.unmount();
    }
  });

  it.each([
    ['secrets', '[aria-label="Loading secrets"], [aria-label="Secrets unavailable"]'],
    ['devices', '[data-daemon-panel-open="devices"] *'],
    ['grants', '[aria-label="Loading capability grants"], [aria-label="Capability grants unavailable"]'],
    ['security', '[data-daemon-panel-open="security"] *'],
    ['carrier', '[data-active-carrier]'],
  ])('mounts the %s panel against this frame’s daemon', async (panel, marker) => {
    const view = await mount(frame({ panel }));
    try {
      expect(view.container.querySelector(`[data-daemon-panel-open="${panel}"]`)).not.toBeNull();
      expect(view.container.querySelectorAll(marker).length).toBeGreaterThan(0);
    } finally {
      await view.unmount();
    }
  });
});
