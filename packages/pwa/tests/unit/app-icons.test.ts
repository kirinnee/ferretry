/**
 * The app's identity is a set of static files nothing else in the repo checks.
 *
 * `tests/unit/host-document.test.ts` already proves every root-absolute reference
 * in `app/index.html` resolves to a file the bundle contains. That is necessary and
 * not sufficient: the icon set can be complete, resolvable and still wrong in
 * three ways a build would never notice.
 *
 *   1. A PNG that CLAIMS a size it is not. `sizes` is a promise to the browser,
 *      not something it measures — Chrome picks by the declared value and then
 *      scales whatever arrives, so a mislabelled 192 silently ships as a blurry
 *      icon. The bytes are read and the real IHDR dimensions compared.
 *   2. A MASKABLE icon whose art does not survive the mask. Android crops
 *      `purpose: maskable` to a circle of 80% of the canvas and adds no padding
 *      of its own; art that reaches the corners loses them. This is geometry, so
 *      it is checked as geometry — the brand source's own transform and shapes
 *      are read and the furthest painted point measured against the crop radius.
 *   3. A MANIFEST LINK the theme hook silently repoints at a 404. `useTheme`
 *      rewrites this link's href on every mode flip, guarded by
 *      `manifestHrefFor`. That guard is what makes shipping ONE static manifest
 *      safe while the 14 generated ones remain unported, and the guard is only
 *      correct for hrefs that do not look generated. So the real href from the
 *      real document is run through the real function for every family and mode.
 *
 * Everything here reads committed files rather than importing app code, because
 * these are facts about the published artifact.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANIFEST_LINK_ID,
  manifestHrefFor,
  type ResolvedMode,
  THEME_FAMILIES,
} from '../../src/lib/theme-preferences.ts';

const packageDir = join(import.meta.dir, '../..');
const publicDir = join(packageDir, 'public');

/** Comments carry example markup; none of it is what the browser sees. */
const document = readFileSync(join(packageDir, 'app/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** A `public/`-relative read of a root-absolute reference, the way Vite serves it. */
const publicFile = (reference: string): Buffer => readFileSync(join(publicDir, reference.slice(1)));

interface LinkTag {
  readonly rel: string;
  readonly href: string;
  readonly attributes: string;
}

const links: readonly LinkTag[] = [...document.matchAll(/<link\b([^>]*)>/g)].map(match => {
  const attributes = match[1] ?? '';
  const attribute = (name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? '';
  return { rel: attribute('rel'), href: attribute('href'), attributes };
});

const linksWithRel = (rel: string): readonly LinkTag[] => links.filter(link => link.rel === rel);

/**
 * PNG dimensions straight out of the IHDR chunk — the first chunk of every PNG,
 * at a fixed offset after the 8-byte signature, width and height as big-endian
 * u32. No decoder needed to answer "how big is this really".
 */
const pngSize = (bytes: Buffer): { readonly width: number; readonly height: number } => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(0, 8).equals(signature)).toBe(true);
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

interface ManifestIcon {
  readonly src: string;
  readonly type: string;
  readonly sizes: string;
  readonly purpose: string;
}

interface Manifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color?: string;
  readonly icons: readonly ManifestIcon[];
}

const MANIFEST_HREF = '/manifest.webmanifest';
const manifest = JSON.parse(publicFile(MANIFEST_HREF).toString('utf8')) as Manifest;

/**
 * The furthest distance from the canvas centre that a shape in a maskable SVG
 * actually paints, in canvas units.
 *
 * Read from the brand file rather than asserted about the PNG for a reason that
 * matters: the PNG is a render, and a render cannot tell you whether the padding
 * was intentional or whether the next edit will eat it. The SVG carries the
 * decision. `logomark-maskable.svg` is one `translate(x y) scale(s)` group around
 * the 64-unit logomark, so the bounding box is the union of its shapes mapped
 * through that one transform — the VIEWBOX is deliberately not used, because the
 * grid cells stop at 60 of 64 and that 4-unit inset is a real part of the margin.
 */
const paintedRadius = (svg: string, canvas: number): number => {
  const transform = /transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+)\)"/.exec(svg);
  expect(transform).not.toBeNull();
  const offsetX = Number(transform?.[1]);
  const offsetY = Number(transform?.[2]);
  const scale = Number(transform?.[3]);

  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x0: number, y0: number, x1: number, y1: number): void => {
    box.minX = Math.min(box.minX, x0);
    box.minY = Math.min(box.minY, y0);
    box.maxX = Math.max(box.maxX, x1);
    box.maxY = Math.max(box.maxY, y1);
  };
  for (const rect of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    const x = Number(rect[1]);
    const y = Number(rect[2]);
    grow(x, y, x + Number(rect[3]), y + Number(rect[4]));
  }
  for (const circle of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
    const cx = Number(circle[1]);
    const cy = Number(circle[2]);
    const r = Number(circle[3]);
    grow(cx - r, cy - r, cx + r, cy + r);
  }
  expect(Number.isFinite(box.minX)).toBe(true);

  // The four corners of the painted box, in canvas units, measured from the
  // canvas centre. The corner is what a circular crop takes first.
  const centre = canvas / 2;
  const corners = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ] as const;
  return Math.max(
    ...corners.map(([x, y]) => {
      const dx = offsetX + x * scale - centre;
      const dy = offsetY + y * scale - centre;
      return Math.hypot(dx, dy);
    }),
  );
};

describe('the app icon set', () => {
  it('offers the tab a scheme-aware SVG before any raster fallback', () => {
    const icons = linksWithRel('icon');
    // Order is the whole point: browsers take the last supported candidate they
    // understand for an unsized icon, but a sized PNG never outranks an
    // `image/svg+xml` one they can render. Losing the SVG loses dark-mode ink.
    expect(icons.map(icon => icon.href)).toEqual(['/icons/favicon.svg', '/icons/favicon-32.png']);
    expect(icons[0]?.attributes).toInclude('type="image/svg+xml"');
    expect(icons[0]?.attributes).not.toInclude('sizes=');

    const svg = publicFile('/icons/favicon.svg').toString('utf8');
    // The one clause that makes a single favicon file work in both schemes. A
    // hard-coded ink here is invisible ink for half the readers.
    expect(svg).toInclude('prefers-color-scheme: dark');
    // The same shape count as the brand source: seven drawn cells, the eighth
    // perimeter slot deliberately absent, and the hub circle in the centre. A
    // dropped or added cell would still be a valid SVG and still look like a
    // grid, which is exactly why the count is asserted — the absence IS the mark.
    expect([...svg.matchAll(/<rect /g)]).toHaveLength(7);
    expect([...svg.matchAll(/<circle /g)]).toHaveLength(1);
  });

  it('gives iOS its own PNG, because iOS does not read the manifest', () => {
    const touch = linksWithRel('apple-touch-icon');
    expect(touch).toHaveLength(1);
    const size = pngSize(publicFile(touch[0]?.href ?? ''));
    expect(size).toEqual({ width: 180, height: 180 });
  });

  it('declares every PNG at the size it really is', () => {
    const declared = [
      ...linksWithRel('icon')
        .filter(icon => icon.href.endsWith('.png'))
        .map(icon => ({ src: icon.href, sizes: /\bsizes="([^"]*)"/.exec(icon.attributes)?.[1] ?? '' })),
      ...manifest.icons.filter(icon => icon.type === 'image/png'),
    ];
    expect(declared.length).toBeGreaterThan(0);
    for (const icon of declared) {
      const claimed = /^(\d+)x(\d+)$/.exec(icon.sizes);
      // A PNG entry with no `WxH` at all is the same defect in a different
      // disguise, so the shape of the claim is asserted before its value.
      expect(claimed).not.toBeNull();
      expect(pngSize(publicFile(icon.src))).toEqual({
        width: Number(claimed?.[1]),
        height: Number(claimed?.[2]),
      });
    }
  });
});

describe('the web app manifest', () => {
  it('identifies the app by a path that outlives a start_url change', () => {
    // `id` defaults to `start_url`, so an app that never declares one is
    // re-identified — and re-installed as a stranger — the day its landing route
    // moves. `/` is the pairing surface and the only route that needs no daemon.
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.name).toBe('Ferretry');
    expect(manifest.short_name).toBe('Ferretry');
    expect(manifest.display).toBe('standalone');
  });

  it('leaves the window colour to the theme, and only names the splash field', () => {
    // The same decision `index.html` records for `theme-color`: seven families
    // ship light and dark token sets, so one static window colour is wrong for
    // six of them and `useTheme` mints the meta from the resolved `--bg`.
    expect(manifest.theme_color).toBeUndefined();
    // `background_color` is not a theme claim. It is the field the maskable icon
    // itself paints, and the launch splash sits directly behind that icon — a
    // different value would draw a visible square around it.
    expect(manifest.background_color).toBe('#0b0b0d');
    const maskable = publicFile('/icons/icon-512.png');
    expect(pngSize(maskable)).toEqual({ width: 512, height: 512 });
  });

  it('serves a maskable icon at both sizes Android asks for', () => {
    const maskable = manifest.icons.filter(icon => icon.purpose.split(' ').includes('maskable'));
    expect(maskable.map(icon => icon.sizes).sort()).toEqual(['192x192', '512x512']);
    // Declared `any maskable` rather than `maskable` alone: the art carries its
    // own opaque field and safe zone, so it is correct unmasked too, and an icon
    // set with no `any` candidate leaves contexts that do not mask with nothing.
    for (const icon of maskable) expect(icon.purpose.split(' ')).toContain('any');
    expect(manifest.icons.some(icon => icon.type === 'image/svg+xml')).toBe(true);
  });

  it('keeps the maskable art inside the circle Android crops to', () => {
    const canvas = 512;
    const svg = readFileSync(join(packageDir, '../../docs/brand/fleet-grid/logomark-maskable.svg'), 'utf8');
    expect(svg).toInclude(`viewBox="0 0 ${canvas} ${canvas}"`);
    // The maskable safe zone is a centred circle of 80% of the canvas, so the
    // radius the crop keeps is 40% of the edge. Every painted corner has to sit
    // inside it — the corner cells of a 3x3 grid are the tightest case there is.
    expect(paintedRadius(svg, canvas)).toBeLessThan(canvas * 0.4);
  });

  it('is a href the theme hook will not repoint at a file nobody generates', () => {
    const link = links.find(candidate => candidate.attributes.includes(`id="${MANIFEST_LINK_ID}"`));
    expect(link?.rel).toBe('manifest');
    expect(link?.href).toBe(MANIFEST_HREF);
    // Exhaustive on purpose: `useTheme` runs this on every family and mode flip,
    // and one family that rewrote the href would 404 the manifest for that theme
    // alone — a failure only visible in an install prompt nobody is watching.
    const modes: readonly ResolvedMode[] = ['light', 'dark'];
    // An empty family list would make the loop below vacuous and this test a
    // green assertion about nothing.
    expect(THEME_FAMILIES.length).toBe(11);
    for (const family of THEME_FAMILIES) {
      for (const mode of modes) {
        expect(manifestHrefFor(MANIFEST_HREF, family.id, mode)).toBe(MANIFEST_HREF);
      }
    }
  });
});
