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
import type { ConnectionChoice } from '@ferretry/relay';

import {
  DaemonSettingsFrame,
  type DaemonSettingsTabDefinition,
} from '../../../../src/features/settings/daemon-settings-frame.tsx';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
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
  { id: 'speedups', label: 'Speed-ups', description: 'Optional provider keys.', Surface: () => null },
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
      'accounts',
      'secure-copy',
      'devices',
      'grants',
      'security',
      'resource-limits',
      'doctor',
      'model-pricing',
      'speedups',
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
    expect(glyphs).toHaveLength(16);
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
      const headingId = must(section.getAttribute('aria-labelledby'), 'the heading id');
      expect(section.querySelector(`[id="${headingId}"]`)?.textContent).toBe('Connection and security');
      expect(section.textContent).toContain(
        'This machine: shared by every device paired to Alpha. Appearance and behaviour stay on each device.',
      );
      expect(section.querySelector('ul')?.getAttribute('aria-label')).toBe('Alpha connection and security');
      expect(section.querySelector('[data-daemon-panel-open]')).toBeNull();

      const warden = must(section.querySelector<HTMLButtonElement>('[data-daemon-panel="warden"]'), 'Warden row');
      expect(warden.textContent).toBe('WardenSupervision, AI login failover, and policy for this daemon.');

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

  it('has no Catalogs panel: Sharing owns them', async () => {
    const view = await mount(frame({ panel: 'catalogs' }));
    try {
      expect(view.container.querySelector('[data-daemon-panel-open]')).toBeNull();
      expect(view.container.querySelector('[data-daemon-panel="catalogs"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('lands on the list for a panel that does not exist, never on a blank frame', async () => {
    const view = await mount(frame({ panel: 'retired-panel' }));
    try {
      expect(view.container.querySelector('[data-daemon-panel-open]')).toBeNull();
      expect(view.container.querySelectorAll('[data-daemon-panel]')).toHaveLength(16);
    } finally {
      await view.unmount();
    }
  });

  it.each([
    ['secrets', '[aria-label="Loading secrets"], [aria-label="Secrets unavailable"]'],
    ['accounts', '[aria-label="Loading accounts"], [aria-label="Accounts unavailable"]'],
    ['secure-copy', '[aria-label="Loading approved pastes"], [aria-label="Approved pastes unavailable"]'],
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

describe('daemon settings panel group', () => {
  const opened: Array<string | null> = [];
  const grouped = (group: { label: string; panels: readonly string[] }, carrier?: ConnectionChoice) => (
    <DaemonSettingsFrame
      connection={alpha}
      name="Alpha"
      additionalTabs={PRODUCTION_ADDITIONAL_TABS}
      readWardenStatus={unavailable}
      createWardenClient={unavailable}
      onOpenPanel={panel => opened.push(panel)}
      group={group}
      {...(carrier === undefined ? {} : { carrier })}
    />
  );
  const chosen = (method: Extract<ConnectionChoice, { ok: true }>['method']): ConnectionChoice => ({
    ok: true,
    method,
    reason: 'Reached it.',
    passedOver: [],
  });

  beforeEach(() => {
    opened.length = 0;
  });

  it('is one titled run of compact rows, only the panels it was asked for, in the order asked', async () => {
    const view = await mount(grouped({ label: 'Sites and secrets', panels: ['secrets', 'accounts'] }));
    try {
      const section = must(view.container.querySelector<HTMLElement>('[data-daemon-panel-group]'), 'group');
      expect(section.getAttribute('data-daemon-panel-group')).toBe('Sites and secrets');
      const headingId = must(section.getAttribute('aria-labelledby'), 'the heading id');
      expect(section.querySelector(`[id="${headingId}"]`)?.textContent).toBe('Sites and secrets');
      expect(
        [...section.querySelectorAll('[data-daemon-panel]')].map(row => row.getAttribute('data-daemon-panel')),
      ).toEqual(['secrets', 'accounts']);
      expect(section.textContent).not.toContain('shared by every device');
      const secrets = must(section.querySelector<HTMLButtonElement>('[data-daemon-panel="secrets"]'), 'Secrets row');
      // The row's height is the theme's row floor (`.kt-grouprow`), not a fixed 44px on every screen.
      expect(secrets.className.split(' ')).toContain('kt-grouprow');
      expect(secrets.className).not.toMatch(/\bmin-h-/u);
      // The description rides as the row's tooltip, not as a second line.
      expect(secrets.getAttribute('title')).not.toBeNull();
      await interact(() => secrets.click());
      expect(opened).toEqual(['secrets']);
    } finally {
      await view.unmount();
    }
  });

  it('names a row by its short word, and claims a state only where it can read one', async () => {
    const view = await mount(grouped({ label: 'Devices and access', panels: ['security', 'carrier', 'devices'] }));
    try {
      const names = [...view.container.querySelectorAll('[data-daemon-panel]')].map(row => row.textContent);
      expect(names[0]).toContain('Passkeys');
      expect(names[1]).toContain('Connection');
      expect(view.container.querySelector('[data-daemon-panel-value="security"]')).toBeNull();
      expect(view.container.querySelector('[data-daemon-panel-value="devices"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says the live carrier on the Connection row, from what this browser already measured', async () => {
    const cases: Array<[Extract<ConnectionChoice, { ok: true }>['method'], string]> = [
      [{ kind: 'direct', daemonUrl: 'https://alpha.example.test' }, 'Direct'],
      [{ kind: 'webrtc' }, 'WebRTC'],
      [{ kind: 'relay', relayUrl: 'wss://relay.example.test/ws' }, 'Relay'],
    ];
    for (const [method, word] of cases) {
      const view = await mount(grouped({ label: 'Devices and access', panels: ['carrier'] }, chosen(method)));
      try {
        expect(view.container.querySelector('[data-daemon-panel-value="carrier"]')?.textContent).toBe(word);
      } finally {
        await view.unmount();
      }
    }
  });

  it('says nothing on the Connection row when no carrier is live', async () => {
    const failed: ConnectionChoice = { ok: false, reason: 'Nothing answered.', passedOver: [] };
    const view = await mount(grouped({ label: 'Devices and access', panels: ['carrier'] }, failed));
    try {
      expect(view.container.querySelector('[data-daemon-panel="carrier"]')).not.toBeNull();
      expect(view.container.querySelector('[data-daemon-panel-value="carrier"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('draws the rows it is handed at the head of the group, ahead of the panels', async () => {
    const lead = <li data-lead-row="">Claude Code</li>;
    const view = await mount(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        additionalTabs={PRODUCTION_ADDITIONAL_TABS}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
        onOpenPanel={() => undefined}
        group={{ label: 'Tools', panels: ['secrets'] }}
        lead={lead}
      />,
    );
    try {
      const section = must(view.container.querySelector<HTMLElement>('[data-daemon-panel-group]'), 'group');
      expect(section.querySelector('li')?.hasAttribute('data-lead-row')).toBe(true);
      expect(section.querySelectorAll('[data-lead-row]')).toHaveLength(1);
      expect(section.querySelector('[data-daemon-panel="secrets"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('still draws the group for its lead rows when none of its panels is available', async () => {
    const view = await mount(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        additionalTabs={PRODUCTION_ADDITIONAL_TABS}
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
        onOpenPanel={() => undefined}
        group={{ label: 'Only lead', panels: ['retired-panel'] }}
        lead={<li data-lead-row="">Only</li>}
      />,
    );
    try {
      expect(view.container.querySelector('[data-daemon-panel-group="Only lead"] [data-lead-row]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('draws nothing when none of its panels is available', async () => {
    const view = await mount(grouped({ label: 'Nothing here', panels: ['retired-panel'] }));
    try {
      expect(view.container.querySelector('[data-daemon-panel-group]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe('daemon settings Secure copy panel', () => {
  const frame = () => (
    <DaemonSettingsFrame
      connection={alpha}
      name="Alpha"
      additionalTabs={PRODUCTION_ADDITIONAL_TABS}
      readWardenStatus={unavailable}
      createWardenClient={unavailable}
      createSecretClient={unavailable}
      onOpenPanel={() => undefined}
      panel="secure-copy"
    />
  );
  const settled = () =>
    interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

  it('lists the task plans', async () => {
    const mounted = await mount(frame());
    try {
      await settled();
      expect(mounted.container.querySelector('[data-task-plans]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

describe('daemon settings Connection panel', () => {
  it('says reconnecting from the health it is handed, for this frame’s machine', () => {
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
        panel="carrier"
        onOpenPanel={() => undefined}
        connectionHealth={{
          kind: 'reconnecting',
          since: 0,
          attempt: 1,
          nextAttemptAt: null,
          failures: [],
          cause: 'unknown',
          stalled: false,
        }}
      />,
    );

    const status = must(view.root.findAll(node => node.props.role === 'status')[0], 'the connection status');
    expect(status.props['data-connection-status']).toBe('reconnecting');
    expect(JSON.stringify(view.toJSON())).toContain('Can’t reach Alpha');

    run(() => view.unmount());
  });

  it('offers this machine’s connection preference beside its status when it is handed one', () => {
    const chosen: string[] = [];
    const view = render(
      <DaemonSettingsFrame
        connection={alpha}
        name="Alpha"
        readWardenStatus={unavailable}
        createWardenClient={unavailable}
        panel="carrier"
        onOpenPanel={() => undefined}
        carrierPreference={{
          value: 'tunnel',
          onChange: preference => chosen.push(preference),
          availability: { webrtc: true },
        }}
      />,
    );

    const group = must(view.root.findAllByType('fieldset')[0], 'the preference group');
    expect(group.props['data-carrier-preference']).toBe('tunnel');
    const auto = must(
      view.root.findAllByType('input').find(input => input.props.value === 'auto'),
      'the Auto choice',
    );
    run(() => auto.props.onChange());
    expect(chosen).toEqual(['auto']);

    run(() => view.unmount());
  });
});

/**
 * "IT KEEPS REFRESHING, ESP AFTER I TYPED". The app re-renders Settings on every background session
 * poll, and the page hands the frame fresh callbacks each time. A panel written as an arrow inside the
 * frame became a new component type on each of those renders, so React unmounted the open panel: the
 * text being typed vanished. The frame's own panels are now declared once; a re-render reaches them as
 * new values, never as a new mount.
 */
describe('an open panel across the frame re-rendering', () => {
  const record: DaemonConnectionRecord = { ...alpha, label: 'Alpha', pairedAt: 0, lastSelectedAt: 0 };
  const frame = (generation: number, connectionRecord: DaemonConnectionRecord = record) => (
    <DaemonSettingsFrame
      connection={alpha}
      connectionRecord={connectionRecord}
      name="Alpha"
      createWardenClient={unavailable}
      panel="host-checks"
      onOpenPanel={() => undefined}
      probeDaemon={async () => ({ ok: true })}
      // A new arrow per render, exactly as the composition root hands them down.
      onRenameDaemon={() => generation}
      onRemoveDaemon={() => generation}
      carrier={generation % 2 === 0 ? undefined : { ok: false, reason: 'Reconnecting.', passedOver: [] }}
    />
  );
  const nameInput = (container: HTMLElement): HTMLInputElement =>
    must(container.querySelector<HTMLInputElement>('[data-daemon-host-checks] form input'), 'the display name');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  it('keeps what is being typed, and the same field, through re-renders with new callbacks', async () => {
    const shown = await mount(frame(0));
    const input = nameInput(shown.container);
    await interact(() => {
      setValue?.call(input, 'Alpha workstation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    for (const generation of [1, 2, 3]) await shown.render(frame(generation));

    expect(nameInput(shown.container)).toBe(input);
    expect(input.value).toBe('Alpha workstation');
    await shown.unmount();
  });

  it('keeps it when the pairing record is republished, and says so only when the name really moved', async () => {
    const shown = await mount(frame(0));
    const input = nameInput(shown.container);
    await interact(() => {
      setValue?.call(input, 'Mine');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The same record, republished (a carrier change, the machine's name learned again).
    await shown.render(frame(1, { ...record }));
    expect(input.value).toBe('Mine');
    expect(shown.container.querySelector('[data-changed-elsewhere]')).toBeNull();

    // Renamed from another tab: the typing stays and loading the new name is offered.
    await shown.render(frame(2, { ...record, label: 'Theirs' }));
    expect(input.value).toBe('Mine');
    expect(shown.container.querySelector('[data-changed-elsewhere="daemon-label"]')).not.toBeNull();
    await interact(() => shown.container.querySelector<HTMLButtonElement>('[data-changed-elsewhere-reload]')?.click());
    expect(input.value).toBe('Theirs');
    await shown.unmount();
  });
});
