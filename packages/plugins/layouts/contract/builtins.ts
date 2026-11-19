/**
 * The layouts and themes this plugin ships (§5.3). The same values as `layouts/*.yaml` and `themes/*.yaml`, which the
 * manifest names for the app and for catalogs; a unit test holds the two together. The daemon half has no file to
 * read them from, so it serves these.
 */
import { LayoutSchema, ThemeSchema } from './wire.ts';

/** The built-in default (design §5.3). With Layouts off, the app shell uses its own copy of the same layout. */
export const DEFAULT_LAYOUT = LayoutSchema.parse({
  id: 'default',
  nav: { side: 'top', style: 'bar', items: ['ferrets', 'agenda', 'board', 'projects', 'insights', 'settings'] },
  side: { show: 'wide-only', holds: 'ferrets', at: 'left' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['attachments', 'dictation', 'runtime-picker', 'composer-quota'],
  // Every panel a plugin declares for the ferret's side pane: a slot a layout lists draws exactly what it lists, so an
  // omitted panel is never drawn (`default-side-panels.test.ts` reads the real manifests and fails on a missing one).
  panels: {
    'ferret.side': [
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
    ],
  },
  density: 'comfortable',
  // Every place the wide bar offers, so a phone can reach Projects, Insights and Settings too (v4's phone bar did).
  phone: { nav: { side: 'bottom', items: ['ferrets', 'agenda', 'board', 'projects', 'insights', 'settings'] } },
});

/** A denser layout: `fy layout use compact`. */
export const COMPACT_LAYOUT = LayoutSchema.parse({
  id: 'compact',
  nav: { side: 'left', style: 'rail', items: ['ferrets', 'agenda', 'board', 'projects', 'insights', 'settings'] },
  side: { show: 'never', holds: 'panels' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['attachments', 'dictation', 'runtime-picker', 'composer-quota'],
  panels: { 'ferret.side': ['queue'] },
  density: 'compact',
  // Every place the wide bar offers, so a phone can reach Projects, Insights and Settings too (v4's phone bar did).
  phone: { nav: { side: 'bottom', items: ['ferrets', 'agenda', 'board', 'projects', 'insights', 'settings'] } },
});

/** The stock theme names no style, palette or `base`: this device's own axes apply and no token is laid over them. */
export const DEFAULT_THEME = ThemeSchema.parse({ id: 'default', label: 'Default' });

export const BUILT_IN_LAYOUTS: readonly (typeof DEFAULT_LAYOUT)[] = [DEFAULT_LAYOUT, COMPACT_LAYOUT];
export const BUILT_IN_THEMES: readonly (typeof DEFAULT_THEME)[] = [DEFAULT_THEME];
