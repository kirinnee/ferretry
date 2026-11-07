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
  plugin('agenda', { screens: [{ id: 'agenda', path: 'agenda', nav: { label: 'Agenda', order: 1 } }] }),
  plugin('ferrets', {
    screens: [
      { id: 'ferrets', path: 'ferrets' },
      { id: 'ferret', path: 'ferret/:id' },
    ],
  }),
  plugin('board', {
    screens: [{ id: 'board', path: 'board' }],
    panels: [{ id: 'cards-of-ferret', slot: 'ferret.side', order: 1 }],
  }),
  plugin('usage', {
    screens: [{ id: 'insights', path: 'insights' }],
    panels: [{ id: 'usage', slot: 'ferret.side', order: 3 }],
  }),
  plugin('conversation', { panels: [{ id: 'sitrep', slot: 'ferret.side', order: 2 }] }),
  // The ids and orders the real manifests declare for `composer.tools` (voice, conversation, usage).
  plugin('voice', { panels: [{ id: 'dictation', slot: 'composer.tools', order: 20 }] }),
  plugin('conversation-files', { panels: [{ id: 'attachments', slot: 'composer.tools', order: 10 }] }),
  plugin('quota', { panels: [{ id: 'composer-quota', slot: 'composer.tools', order: 90 }] }),
];
const views = viewsOf(surfaces);

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
    const layout = LayoutSchema.parse({ id: 'mine', nav: { side: 'right', items: ['agenda', 'nowhere'] } });
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
    const phone = resolveLayout(DEFAULT_LAYOUT, 'phone');
    expect(phone.nav).toEqual({ side: 'bottom', style: 'rail', items: ['agenda', 'ferrets', 'board'] });
  });
});

describe('choosing a layout', () => {
  test('the device override wins, then the daemon, then the default', () => {
    const device = { id: 'device', nav: { side: 'top', items: ['board'] } };
    const daemon = { id: 'daemon', nav: { side: 'right', items: ['agenda'] } };
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
    const right = setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.side', 'right');
    expect(right).toEqual({ ok: true, overrides: { nav: { side: 'right' } } });
    if (!right.ok) return;
    const items = setDeviceOverride(DEFAULT_LAYOUT, right.overrides, 'nav.items', 'agenda, board');
    expect(items).toEqual({ ok: true, overrides: { nav: { side: 'right', items: ['agenda', 'board'] } } });
  });

  test('refuses an unknown setting or value', () => {
    expect(setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.colour', 'red').ok).toBe(false);
    expect(setDeviceOverride(DEFAULT_LAYOUT, {}, 'nav.side', 'middle').ok).toBe(false);
  });
});

describe('the owner layout and this device (§5.3)', () => {
  const owner = LayoutSchema.parse({ id: 'owner', nav: { side: 'right', items: ['agenda'] } });

  test('the owner layout applies on every device when this device changed nothing', () => {
    expect(chooseLayout(layoutCandidates(owner, {}), views.installed)).toEqual({ kind: 'applied', layout: owner });
  });

  test('a device override sits on top of the owner layout, field by field', () => {
    const edited = setDeviceOverride(owner, {}, 'nav.style', 'bar');
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const choice = chooseLayout(layoutCandidates(owner, edited.overrides), views.installed);
    // The device's field wins; every field it did not touch still follows the owner.
    expect(choice.layout).toMatchObject({ id: 'owner', nav: { side: 'right', style: 'bar', items: ['agenda'] } });
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
    const laid = applyOverrides(DEFAULT_LAYOUT, { phone: { nav: { side: 'top' } } });
    expect(laid?.phone?.nav).toEqual({ side: 'top', items: ['agenda', 'ferrets', 'board'] });
  });
});

describe('the frame plan', () => {
  test('every built-in layout draws the three composer.tools panels, in the order the composer always drew them', () => {
    for (const layout of [DEFAULT_LAYOUT, COMPACT_LAYOUT]) {
      for (const viewport of ['wide', 'phone'] as const) {
        const ids = planFrame(resolveLayout(layout, viewport), views)
          .panels('composer.tools')
          .map(panel => panel.id);
        expect(ids).toEqual(['attachments', 'dictation', 'composer-quota']);
      }
    }
  });

  test('places nav entries, the side column and panels in layout order', () => {
    const plan = planFrame(resolveLayout(DEFAULT_LAYOUT, 'wide'), views);
    expect(plan.nav.entries.map(e => (e.kind === 'screen' ? `${e.screen.plugin}.${e.screen.id}` : e.item))).toEqual([
      'agenda.agenda',
      'ferrets.ferrets',
      'board.board',
      'usage.insights',
      'settings',
    ]);
    expect(plan.side.holds).toMatchObject({ kind: 'screen', screen: { plugin: 'ferrets', id: 'ferret' } });
    expect(plan.panels('ferret.side').map(p => p.id)).toEqual(['cards-of-ferret', 'sitrep', 'usage']);
    expect(plan.panels('composer.tools').map(p => p.id)).toEqual(['attachments', 'dictation', 'composer-quota']);
  });

  test('a slot the layout does not list shows every declared panel by order', () => {
    const layout = resolveLayout(LayoutSchema.parse({ id: 'bare', nav: { side: 'left', items: [] } }), 'wide');
    expect(
      planFrame(layout, views)
        .panels('ferret.side')
        .map(p => p.id),
    ).toEqual(['cards-of-ferret', 'sitrep', 'usage']);
  });

  test('a screen id two plugins declare is reachable only qualified', () => {
    const twice = viewsOf([...surfaces, plugin('other', { screens: [{ id: 'board', path: 'x' }] })]);
    expect(twice.screens.get('board')).toBeUndefined();
    expect(twice.screens.get('board.board')?.plugin).toBe('board');
    expect(twice.screens.get('other.board')?.plugin).toBe('other');
  });
});
