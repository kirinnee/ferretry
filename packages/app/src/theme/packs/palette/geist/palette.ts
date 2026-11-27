export default {
  id: 'geist',
  label: 'Skyline',
  blurb: 'Near-absolute black and white, one blue accent.',
  order: 20,
  light: {
    'chrome-fg': 'var(--faint)',
    // Elevation is FLAT and honest. Controls rest flat on their hairline; panels
    // and popovers get a quiet neutral blur, no colour. The marketing glow was
    // removed (see header) so --glow-alpha stays 0 and the reduced-motion path is
    // a no-op. No offset ink (Neo), no rings-instead-of-shadow (Contrast) — the
    // third distinct read is planar: crisp thin edges, no float.
    'nav-hover': 'var(--surface-2)',
    'nav-sel-bg': 'var(--accent-soft)',
    'nav-sel-edge': 'var(--accent-border)',
    // ═══ structural token layer ═══
    // Quiet control edge, not black: the lightest grey that still clears 3:1 on
    // the palest surface (surface-3), so an input reads as a field without turning
    // into a Contrast border. Decorative hairlines use --border below.
    'border-strong': '#838383', // 3.35:1 on the palest surface (surface-3)
    // Off-white desk, white cards — a DECISIVE layered near-white. The steps are
    // wider than the docs-Geist so a card reads a clear tint off the page and a
    // raised tier off the card: on a 30-row console the FILL does the region
    // separating, not just the edge. Kept off Contrast's pure #fff so it reads as
    // paper, not a stark white box.
    bg: '#f4f4f5',
    surface: '#ffffff',
    'surface-2': '#f0f0f1',
    'surface-3': '#e6e6e8',
    fg: '#171717',
    'fg-soft': '#3d3d3d',
    muted: '#595959',
    // No aurora now, so no washed-ground margin to buy — but kept punchy anyway;
    // thin light-grey secondary text on near-white was half of why the old Geist
    // read as timid. 5.9:1 on white.
    faint: '#5e5e5e',
    // THE HAIRLINE — quiet but LEGIBLE. The docs-Geist #eaeaea nearly dissolved on
    // a dense console; #dcdcde is still a restrained Vercel grey (never a Contrast
    // edge) but it actually rules the rows. Decorative, so the audit tiers it
    // `decor`; the load-bearing edge is --border-strong.
    border: '#dcdcde',
    'border-soft': '#e8e8ea',
    // The single functional colour: Vercel blue, darkened just enough to clear
    // 4.5:1 as link text on every surface (incl. the palest). The brighter blue
    // lives in --accent-soft / --accent-border and dark mode.
    accent: '#0060df',
    'accent-rgb': [0, 96, 223],
    'accent-fg': '#ffffff',
    'accent-soft': '#e8f1fd',
    'accent-border': '#b6d4fb',
    'accent-strong': '#004ec0',
    'user-bg': '#f5f8fd',
    'user-border': '#0060df',
    'user-rail': '#b6d4fb',
    'bubble-bg': 'var(--user-bg)',
    'code-bg': '#f6f6f6',
    'code-border': '#eaeaea',
    'code-fg': '#1f1f1f',
    ok: '#067647',
    'ok-bg': '#e6f4ec',
    'ok-border': '#b3ddc6',
    warn: '#9a5b00',
    'warn-bg': '#fbf0e0',
    'warn-border': '#ecd4a8',
    pend: '#525252',
    'pend-bg': '#f0f0f0',
    'pend-border': '#dcdcdc',
    err: '#cc2f2f',
    'err-bg': '#fceceb',
    'err-border': '#f3c3c1',
    'tool-bash': '#067647',
    'tool-read': '#0060df',
    'tool-edit': '#9a5b00',
    'tool-write': '#6b30c4',
    'tool-patch': '#b02a76',
    'tool-search': '#0a7185',
    'tool-plan': '#3a45c4',
    'tool-wait': '#5f5f5f',
    'tool-generic': '#525252',
    'syn-comment': '#6b6b6b',
    'syn-keyword': '#6b30c4',
    'syn-string': '#067647',
    'syn-type': '#0a7185',
    'syn-number': '#9a5b00',
    'syn-meta': '#b02a76',
    'syn-addition': '#067647',
    'syn-deletion': '#cc2f2f',
    'bar-bg': 'rgba(244, 244, 245, 0.85)',
    'shadow-sm-1': 'rgba(0, 0, 0, 0.05)',
    'shadow-md-1': 'rgba(0, 0, 0, 0.05)',
    'shadow-md-2': 'rgba(20, 40, 90, 0.1)',
    'shadow-lg-1': 'rgba(0, 0, 0, 0.06)',
    'shadow-lg-2': 'rgba(20, 40, 90, 0.14)',
    scrim: 'rgba(15, 20, 40, 0.4)',
    // No wash. The marketing aurora was removed (see header): a clean flat ground
    // is the Vercel DASHBOARD, and it lets the layered surfaces + hairlines carry
    // the structure without a gradient competing with 30 rows of data.
    ring: 'rgba(0, 96, 223, 0.42)',
    'focus-color': '#0060df',
    'selection-bg': '#cfe3fd',
    'selection-fg': '#171717',
    'nav-sel-fg': 'var(--accent-strong)',
    'nav-sel-sub': 'var(--accent)',
    ground: '#ebebed',
    'step-seg-now': '#4f91e9',
  },
  dark: {
    'chrome-fg': 'var(--faint)',
    // Elevation is FLAT and honest. Controls rest flat on their hairline; panels
    // and popovers get a quiet neutral blur, no colour. The marketing glow was
    // removed (see header) so --glow-alpha stays 0 and the reduced-motion path is
    // a no-op. No offset ink (Neo), no rings-instead-of-shadow (Contrast) — the
    // third distinct read is planar: crisp thin edges, no float.
    'nav-hover': 'var(--surface-2)',
    'nav-sel-bg': 'var(--accent-soft)',
    'nav-sel-edge': 'var(--accent-border)',
    // ═══ structural token layer ═══
    // Quiet control edge on the dark stock — the lightest it can be while still
    // clearing 3:1 on the palest dark surface.
    'border-strong': '#7a7a7a', // 3.30:1 on surface-3
    // Near-absolute black, layered — kept off Contrast's pure #000 so the surfaces
    // read as stacked planes under the hairlines. The step from surface to
    // surface-2/3 is what separates a raised region from the card on this ground.
    bg: '#0a0a0a',
    surface: '#111111',
    'surface-2': '#1c1c1c',
    'surface-3': '#272727',
    fg: '#ededed',
    'fg-soft': '#b4b4b4',
    muted: '#a1a1a1',
    // No aurora now, so no washed-ground margin needed — #979797 kept for a
    // confident secondary ink (6.0:1 on surface).
    faint: '#979797',
    // THE HAIRLINE, dark — quiet but LEGIBLE. #2a2a2a dissolved on a dense
    // console; #363636 is still a restrained Vercel grey but rules the rows.
    // Decorative; the load-bearing edge is --border-strong.
    border: '#363636',
    'border-soft': '#242424',
    // The same functional blue, lifted for legibility on black. Dark text on the
    // bright accent (Studio/Notebook do the same) so a primary button stays
    // readable without a second accent token.
    accent: '#3b9eff',
    'accent-rgb': [59, 158, 255],
    'accent-fg': '#04121f',
    'accent-soft': '#0d2842',
    'accent-border': '#1e4d80',
    'accent-strong': '#6bb6ff',
    'user-bg': '#0e1a28',
    'user-border': '#3b9eff',
    'user-rail': '#1e4d80',
    'bubble-bg': 'var(--user-bg)',
    'code-bg': '#141414',
    'code-border': '#262626',
    'code-fg': '#e0e0e0',
    ok: '#3fcf7f',
    'ok-bg': '#0f2419',
    'ok-border': '#1f4632',
    warn: '#e0a63a',
    'warn-bg': '#2a2110',
    'warn-border': '#4c3d1c',
    pend: '#a1a1a1',
    'pend-bg': '#1a1a1a',
    'pend-border': '#2e2e2e',
    err: '#ff6166',
    'err-bg': '#2a1315',
    'err-border': '#4d262a',
    'tool-bash': '#3fcf7f',
    'tool-read': '#3b9eff',
    'tool-edit': '#e0a63a',
    'tool-write': '#b48cff',
    'tool-patch': '#ff7fb0',
    'tool-search': '#45c8dc',
    'tool-plan': '#8c96ff',
    'tool-wait': '#a1a1a1',
    'tool-generic': '#a1a1a1',
    'syn-comment': '#8f8f8f',
    'syn-keyword': '#b48cff',
    'syn-string': '#3fcf7f',
    'syn-type': '#45c8dc',
    'syn-number': '#e0a63a',
    'syn-meta': '#ff7fb0',
    'syn-addition': '#3fcf7f',
    'syn-deletion': '#ff6166',
    'bar-bg': 'rgba(9, 9, 12, 0.72)',
    'shadow-sm-1': 'rgba(0, 0, 0, 0.6)',
    'shadow-md-1': 'rgba(0, 0, 0, 0.6)',
    'shadow-md-2': 'rgba(0, 0, 0, 0.8)',
    'shadow-lg-1': 'rgba(0, 0, 0, 0.6)',
    'shadow-lg-2': 'rgba(0, 0, 0, 0.85)',
    scrim: 'rgba(0, 0, 0, 0.72)',
    // No wash. The marketing aurora was removed (see header): the clean near-black
    // canvas is the Vercel DASHBOARD, and the layered surfaces + legible hairlines
    // carry the structure without four radial spotlights behind the data.
    ring: 'rgba(59, 158, 255, 0.55)',
    'focus-color': '#3b9eff',
    'selection-bg': '#163a5f',
    'selection-fg': '#ededed',
    'nav-sel-fg': '#e6f1ff',
    'nav-sel-sub': 'var(--accent-strong)',
    ground: '#000000',
    'step-seg-now': '#2b67a2',
  },
} as const;
