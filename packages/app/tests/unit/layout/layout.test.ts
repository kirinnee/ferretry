import { describe, expect, test } from 'bun:test';
import type { Manifest } from '@ferretry/kernel/manifest';
import { COMPACT_LAYOUT } from '@ferretry/plugin-layouts/contract';
import { planFrame, viewsOf } from '../../../src/layout/engine.ts';
import {
  checkLayout,
  chooseLayout,
  DEFAULT_LAYOUT,
  LayoutSchema,
  applyOverrides,
  layoutCandidates,
  resolveLayout,
  setDeviceOverride,
} from '../../../src/layout/layout.ts';
import { FRAME_SLOTS, FRAME_SLOTS_COMPLETE, isSlotName } from '../../../src/layout/slots.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';

function plugin(id: string, ui: NonNullable<Manifest['ui']>): SurfaceEntry {
  const manifest = { id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ui } as Manifest;
  return { id, title: id, core: false, contract: 'h', consumes: [], manifest };
}

const surfaces = [
  plugin('agenda', {
    screens: [{ id: 'agenda', path: 'agenda', nav: { label: 'Agenda', order: 1 } }],
    panels: [{ id: 'ferret-agenda', slot: 'ferret.side', order: 10 }],
  }),
  plugin('warden', { panels: [{ id: 'ferret-warden', slot: 'ferret.side', order: 30 }] }),
  // The ids the real manifests declare: Ferrets declares the list screen and the new-ferret and move ones.
  plugin('ferrets', {
    screens: [
      { id: 'ferrets', path: 'ferrets', nav: { label: 'Ferrets', order: 5 } },
      { id: 'new-ferret', path: 'new' },
      { id: 'move', path: 'ferrets/:ferret/move' },
    ],
    panels: [{ id: 'files', slot: 'ferret.side', order: 40 }],
  }),
  plugin('board', {
    screens: [{ id: 'board', path: 'board' }],
    panels: [{ id: 'cards-of-ferret', slot: 'ferret.side', order: 20 }],
  }),
  // The Projects screen the default layout's nav lists (its real manifest: path 'projects', nav order 35).
  plugin('projects', { screens: [{ id: 'projects', path: 'projects', nav: { label: 'Projects', order: 35 } }] }),
  plugin('usage', {
    screens: [{ id: 'insights', path: 'insights' }],
    panels: [
      { id: 'usage', slot: 'ferret.side', order: 65 },
      { id: 'insights', slot: 'ferret.side', order: 70 },
    ],
  }),
  plugin('conversation', {
    // O8-12: Conversation declares no screen with a nav entry any more (the past-conversation list is in New ferret).
    panels: [{ id: 'queue', slot: 'ferret.side', order: 10 }],
  }),
  // The rest of what the real manifests declare for `ferret.side` (the default layout lists every one of them).
  plugin('terminals', {
    panels: [
      { id: 'terminals', slot: 'ferret.side', order: 20 },
      { id: 'console', slot: 'ferret.side', order: 21 },
      { id: 'processes', slot: 'ferret.side', order: 22 },
    ],
  }),
  plugin('browsers', { panels: [{ id: 'browser', slot: 'ferret.side', order: 30 }] }),
  plugin('mcp', { panels: [{ id: 'mcp-servers', slot: 'ferret.side', order: 40 }] }),
  plugin('packs', { panels: [{ id: 'helpers', slot: 'ferret.side', order: 40 }] }),
  plugin('skills', { panels: [{ id: 'skills', slot: 'ferret.side', order: 50 }] }),
  plugin('ferrets-instructions', { panels: [{ id: 'instructions', slot: 'ferret.side', order: 41 }] }),
  // The ids and orders the real manifests declare for `composer.tools` (voice, conversation, runtimes, usage).
  plugin('voice', { panels: [{ id: 'dictation', slot: 'composer.tools', order: 20 }] }),
  plugin('conversation-files', { panels: [{ id: 'attachments', slot: 'composer.tools', order: 10 }] }),
  plugin('runtimes', { panels: [{ id: 'runtime-picker', slot: 'composer.tools', order: 10 }] }),
  plugin('quota', { panels: [{ id: 'composer-quota', slot: 'composer.tools', order: 90 }] }),
];
const views = viewsOf(surfaces);

describe('U-L: the default layout puts the ferret list on the left, and a saved layout is kept as it was', () => {
  const planOf = (layout: typeof DEFAULT_LAYOUT) => planFrame(resolveLayout(layout, 'wide'), viewsOf(surfaces));

  test('the built-in default is a side bar with the places docked at its foot, and the ferret column on the left', () => {
    const plan = planOf(DEFAULT_LAYOUT);
    expect(plan.nav).toMatchObject({ side: 'left', style: 'dock', labels: 'icons' });
    expect(plan.side.at).toBe('left');
    expect(plan.side.holds).toMatchObject({ kind: 'screen', screen: { id: 'ferrets' } });
  });

  test('a layout saved before the field names no edge, parses unchanged and keeps the column on the right', () => {
    const saved = LayoutSchema.parse({
      id: 'mine',
      nav: { side: 'left', style: 'list', items: ['ferrets', 'agenda'] },
      side: { show: 'wide-only', holds: 'ferrets' },
    });
    expect(saved.side).toEqual({ show: 'wide-only', holds: 'ferrets' });
    expect(planOf(saved).side.at).toBe('right');
    expect(planOf(saved).nav.side).toBe('left');
  });

  test('a phone follows the wide layout (the places in its menu, no bottom bar), and a device override that names an edge wins', () => {
    expect(resolveLayout(DEFAULT_LAYOUT, 'phone').nav).toEqual(resolveLayout(DEFAULT_LAYOUT, 'wide').nav);
    expect(resolveLayout(DEFAULT_LAYOUT, 'phone').nav.side).toBe('left');
    const moved = applyOverrides(DEFAULT_LAYOUT, { side: { at: 'right' } });
    expect(moved === undefined ? undefined : planOf(moved).side.at).toBe('right');
    const set = setDeviceOverride(DEFAULT_LAYOUT, {}, 'side.at', 'right');
    expect(set).toEqual({ ok: true, overrides: { side: { at: 'right' } } });
    expect(setDeviceOverride(DEFAULT_LAYOUT, {}, 'side.at', 'middle').ok).toBe(false);
  });
});

describe('slots', () => {
  test('the frame slot list matches the leaf', () => {
    expect(FRAME_SLOTS_COMPLETE).toBe(true);
    expect(FRAME_SLOTS).toContain('device.settings');
    expect(isSlotName('board.lanes')).toBe(true);
    expect(isSlotName('Board')).toBe(false);
  });
});

describe('the layout item', () => {
  test('the default layout parses and checks against these views', () => {
    expect(checkLayout(DEFAULT_LAYOUT, views.installed)).toEqual([]);
  });

  test('an unknown field is refused', () => {
    expect(LayoutSchema.safeParse({ ...DEFAULT_LAYOUT, sidebar: 'left' }).success).toBe(false);
  });

  test('an unknown view name is refused, naming where', () => {
    const layout = LayoutSchema.parse({ id: 'mine', nav: { side: 'bottom', items: ['agenda', 'nowhere'] } });
    expect(checkLayout(layout, views.installed)).toEqual([
      { at: 'nav.items', message: '"nowhere" is not an installed screen' },
    ]);
  });

  test('an unknown panel or top item is refused', () => {
    const layout = LayoutSchema.parse({
      id: 'mine',
      nav: { side: 'left', items: [] },
      top: ['clock'],
      panels: { 'ferret.side': ['ghost'] },
    });
    expect(checkLayout(layout, views.installed).map(issue => issue.at)).toEqual(['top', 'panels.ferret.side']);
  });

  test('phone overrides apply only on a phone', () => {
    expect(resolveLayout(DEFAULT_LAYOUT, 'wide').nav.side).toBe('left');
    const withBar = applyOverrides(DEFAULT_LAYOUT, { phone: { nav: { side: 'bottom' } } });
    if (withBar === undefined) throw new Error('the override is a layout');
    expect(resolveLayout(withBar, 'wide').nav.side).toBe('left');
    const phone = resolveLayout(withBar, 'phone');
    expect(phone.nav).toEqual({
      side: 'bottom',
      style: 'dock',
      labels: 'icons',
      items: ['ferrets', 'agenda', 'board', 'projects', 'insights', 'settings'],
    });
    // The ferret list is the first bottom-nav item on a phone (S-0231: no Ferrets drawer).
    const bottom = planFrame(phone, views).nav.entries[0];
    expect(bottom?.kind === 'screen' ? `${bottom.screen.plugin}.${bottom.screen.id}` : bottom?.item).toBe(
      'ferrets.ferrets',
    );
    // O8-12: no Conversations place; Agenda is the second default place.
    const second = planFrame(phone, views).nav.entries[1];
    expect(second?.kind === 'screen' ? `${second.screen.plugin}.${second.screen.id}` : second?.item).toBe(
      'agenda.agenda',
    );
    // A nav word the shell does not draw (`top`, `right`, `bar`) is refused, not read as another.
    for (const nav of [{ side: 'top' }, { side: 'right' }, { style: 'bar' }])
      expect(LayoutSchema.safeParse({ id: 'old', nav: { items: ['agenda'], side: 'left', ...nav } }).success).toBe(
        false,
      );
  });
});

describe('choosing a layout', () => {
  test('the device override wins, then the daemon, then the default', () => {
    const device = { id: 'device', nav: { side: 'bottom', items: ['board'] } };
    const daemon = { id: 'daemon', nav: { side: 'left', items: ['agenda'] } };
    expect(chooseLayout([device, daemon], views.installed)).toMatchObject({
      kind: 'applied',
      layout: { id: 'device' },
    });
    expect(chooseLayout([undefined, daemon], views.installed)).toMatchObject({ layout: { id: 'daemon' } });
    expect(chooseLayout([], views.installed)).toEqual({ kind: 'applied', layout: DEFAULT_LAYOUT });
  });

  test('a refused layout falls through and says why', () => {
    const broken = { id: 'broken', nav: { side: 'left', items: ['nowhere'] } };
    const choice = chooseLayout([broken], views.installed);
    expect(choice.kind).toBe('refused');
    if (choice.kind === 'refused') {
      expect(choice.refused).toBe('broken');
      expect(choice.layout).toBe(DEFAULT_LAYOUT);
    }
  });
});

describe('layout set --device', () => {
  test('moves the sidebar and chooses the nav items, as overrides of only those keys', () => {
    const bottom = setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.side', 'bottom');
    expect(bottom).toEqual({ ok: true, overrides: { nav: { side: 'bottom' } } });
    if (!bottom.ok) return;
    const items = setDeviceOverride(DEFAULT_LAYOUT, bottom.overrides, 'nav.items', 'agenda, board');
    expect(items).toEqual({ ok: true, overrides: { nav: { side: 'bottom', items: ['agenda', 'board'] } } });
  });

  test('refuses an unknown setting or value', () => {
    expect(setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.colour', 'red').ok).toBe(false);
    expect(setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.side', 'middle').ok).toBe(false);
  });
});

describe('the owner layout and this device (§5.3)', () => {
  const owner = LayoutSchema.parse({ id: 'owner', nav: { side: 'bottom', items: ['agenda'] } });

  test('the owner layout applies on every device when this device changed nothing', () => {
    expect(chooseLayout(layoutCandidates(owner, {}), views.installed)).toEqual({ kind: 'applied', layout: owner });
  });

  test('a device override sits on top of the owner layout, field by field', () => {
    const edited = setDeviceOverride(owner, {}, 'nav.style', 'list');
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const choice = chooseLayout(layoutCandidates(owner, edited.overrides), views.installed);
    // The device's field wins; every field it did not touch still follows the owner.
    expect(choice.layout).toMatchObject({ id: 'owner', nav: { side: 'bottom', style: 'list', items: ['agenda'] } });
  });

  test('an override the views refuse falls back to the owner layout alone', () => {
    const choice = chooseLayout(layoutCandidates(owner, { nav: { items: ['nowhere'] } }), views.installed);
    expect(choice).toMatchObject({ kind: 'refused', layout: { id: 'owner', nav: { items: ['agenda'] } } });
  });

  test('without an owner layout the overrides go on the built-in default', () => {
    expect(layoutCandidates(undefined, {})).toEqual([]);
    expect(layoutCandidates(undefined, { density: 'compact' })[0]).toMatchObject({ id: 'default', density: 'compact' });
  });

  test('applyOverrides lays phone fields over the phone overrides the layout has', () => {
    const laid = applyOverrides(DEFAULT_LAYOUT, { phone: { nav: { side: 'bottom' } } });
    // The built-in layout has no phone nav of its own (a phone follows the wide one), so the override is all there is.
    expect(laid?.phone?.nav).toEqual({ side: 'bottom' });
  });
});

describe('the frame plan', () => {
  test('every built-in layout draws the four composer.tools panels, in the order the composer always drew them', () => {
    for (const layout of [DEFAULT_LAYOUT, COMPACT_LAYOUT]) {
      for (const viewport of ['wide', 'phone'] as const) {
        const ids = planFrame(resolveLayout(layout, viewport), views)
          .panels('composer.tools')
          .map(panel => panel.id);
        expect(ids).toEqual(['attachments', 'dictation', 'runtime-picker', 'composer-quota']);
      }
    }
  });

  test('places nav entries, the side column and panels in layout order', () => {
    const plan = planFrame(resolveLayout(DEFAULT_LAYOUT, 'wide'), views);
    expect(plan.nav.entries.map(e => (e.kind === 'screen' ? `${e.screen.plugin}.${e.screen.id}` : e.item))).toEqual([
      'ferrets.ferrets',
      'agenda.agenda',
      'board.board',
      'projects.projects',
      'usage.insights',
      'settings',
    ]);
    // The side column holds the ferret list (today's left sessions bar); a layout naming `panels` still gets panels.
    expect(plan.side.holds).toMatchObject({ kind: 'screen', screen: { plugin: 'ferrets', id: 'ferrets' } });
    const kept = planFrame(
      resolveLayout({ ...DEFAULT_LAYOUT, side: { show: 'wide-only', holds: 'panels' } }, 'wide'),
      views,
    );
    expect(kept.side.holds).toMatchObject({ kind: 'panels' });
    // A listed slot draws exactly what it lists, in that order: the default lists every panel the plugins declare for it.
    expect(plan.panels('ferret.side').map(p => p.id)).toEqual([
      'ferret-agenda',
      'queue',
      'cards-of-ferret',
      'terminals',
      'console',
      'processes',
      'browser',
      'files',
      'ferret-warden',
      'mcp-servers',
      'helpers',
      'skills',
      'instructions',
      'usage',
      'insights',
    ]);
    expect(plan.panels('composer.tools').map(p => p.id)).toEqual([
      'attachments',
      'dictation',
      'runtime-picker',
      'composer-quota',
    ]);
  });

  test('a slot the layout does not list shows every declared panel by order', () => {
    const layout = resolveLayout(LayoutSchema.parse({ id: 'bare', nav: { side: 'left', items: [] } }), 'wide');
    expect(
      planFrame(layout, views)
        .panels('ferret.side')
        .map(p => p.id),
    ).toEqual([
      'ferret-agenda',
      'queue',
      'cards-of-ferret',
      'terminals',
      'console',
      'processes',
      'browser',
      'ferret-warden',
      'files',
      'mcp-servers',
      'helpers',
      'instructions',
      'skills',
      'usage',
      'insights',
    ]);
  });

  test('a screen id two plugins declare is reachable only qualified', () => {
    const twice = viewsOf([...surfaces, plugin('other', { screens: [{ id: 'board', path: 'x' }] })]);
    expect(twice.screens.get('board')).toBeUndefined();
    expect(twice.screens.get('board.board')?.plugin).toBe('board');
    expect(twice.screens.get('other.board')?.plugin).toBe('other');
  });
});
