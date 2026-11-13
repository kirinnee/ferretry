/**
 * THE TILE SOURCE, the one place its address is written. `public/_headers` names the same ORIGIN in
 * `img-src` (a unit test and `scripts/validate/pages-config.sh` hold the two together), and nothing else may
 * widen `img-src` — Markdown images stay requests the reader's CSP refuses. OpenStreetMap's standard
 * tiles need no key and allow light interactive use with attribution; docs/fy-render.md has the policy.
 */
export const MAP_TILE_ORIGIN = 'https://tile.openstreetmap.org';
export const MAP_TILE_URL = `${MAP_TILE_ORIGIN}/{z}/{x}/{y}.png`;
export const MAP_ATTRIBUTION = {
  href: 'https://www.openstreetmap.org/copyright',
  text: '© OpenStreetMap contributors',
};
