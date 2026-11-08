/**
 * The layouts and themes this plugin ships (§5.3). The same values as `layouts/*.yaml` and `themes/*.yaml`, which the
 * manifest names for the app and for catalogs; a unit test holds the two together. The daemon half has no file to
 * read them from, so it serves these.
 */
import { LayoutSchema, ThemeSchema } from './wire.ts';

/** The built-in default (design §5.3). With Layouts off, the app shell uses its own copy of the same layout. */
export const DEFAULT_LAYOUT = LayoutSchema.parse({
  id: 'default',
  nav: { side: 'left', style: 'rail', items: ['agenda', 'ferrets', 'board', 'insights', 'settings'] },
  side: { show: 'wide-only', holds: 'ferret' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['attachments', 'dictation', 'runtime-picker', 'composer-quota'],
  panels: { 'ferret.side': ['cards-of-ferret', 'files', 'sitrep', 'usage'] },
  density: 'comfortable',
  phone: { nav: { side: 'bottom', items: ['agenda', 'ferrets', 'board'] } },
});

/** A denser layout: `fy layout use compact`. */
export const COMPACT_LAYOUT = LayoutSchema.parse({
  id: 'compact',
  nav: { side: 'left', style: 'rail', items: ['agenda', 'ferrets', 'board', 'insights', 'settings'] },
  side: { show: 'never', holds: 'ferret' },
  top: ['daemon-picker', 'search'],
  'composer.tools': ['attachments', 'dictation', 'runtime-picker', 'composer-quota'],
  panels: { 'ferret.side': ['sitrep'] },
  density: 'compact',
  phone: { nav: { side: 'bottom', items: ['agenda', 'ferrets', 'board'] } },
});

/** The built-in theme: the house family with no token laid over it. */
export const DEFAULT_THEME = ThemeSchema.parse({ id: 'default', label: 'Default', base: 'studio' });

export const BUILT_IN_LAYOUTS: readonly (typeof DEFAULT_LAYOUT)[] = [DEFAULT_LAYOUT, COMPACT_LAYOUT];
export const BUILT_IN_THEMES: readonly (typeof DEFAULT_THEME)[] = [DEFAULT_THEME];
