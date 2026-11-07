/** What `fy layout` and `fy theme` print. Pure: the verbs hand it what the daemon answered. */
import type { CurrentLayout, Layout, LayoutList, ThemeList } from '../../contract/index.ts';

const join = (items: readonly string[] | undefined): string =>
  items === undefined || items.length === 0 ? 'none' : items.join(', ');

export function layoutLines(layout: Layout): readonly string[] {
  const lines = [
    `layout   ${layout.id}`,
    `nav      ${layout.nav.side}, ${layout.nav.style}: ${join(layout.nav.items)}`,
    `side     ${layout.side.show}, holds ${layout.side.holds}`,
    `top      ${join(layout.top)}`,
    `composer ${join(layout['composer.tools'])}`,
    `density  ${layout.density}`,
  ];
  for (const [slot, ids] of Object.entries(layout.panels)) lines.push(`panels   ${slot}: ${join(ids)}`);
  if (layout.phone !== undefined) {
    const nav = layout.phone.nav;
    if (nav !== undefined) lines.push(`phone    nav ${nav.side ?? 'same side'}: ${join(nav.items)}`);
  }
  return lines;
}

export function currentLines(current: CurrentLayout): readonly string[] {
  return [
    ...layoutLines(current.layout),
    `theme    ${current.theme.id} (${current.theme.label}, on ${current.theme.base})`,
  ];
}

export function listLines(list: LayoutList): readonly string[] {
  const mark = (id: string, now: string): string => (id === now ? '*' : ' ');
  return [
    'layouts',
    ...list.layouts.map(item => `  ${mark(item.id, list.current.layout)} ${item.id}  (${item.origin})`),
    'themes',
    ...list.themes.map(item => `  ${mark(item.id, list.current.theme)} ${item.id}  (${item.origin})`),
  ];
}

export function themeLines(list: ThemeList): readonly string[] {
  return list.themes.map(item => `${item.id === list.current ? '*' : ' '} ${item.id}  (${item.origin})`);
}
