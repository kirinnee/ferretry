/**
 * THE APP'S LOOK, HANDED TO A PAGE THAT CANNOT SEE THE APP.
 *
 * An interactive `html` block runs in an opaque frame (`fy-render-html-frame.tsx`): no custom
 * property of the app's document reaches it, so a page written with `var(--fg)` used to draw in the
 * browser's defaults and look bolted on. This module is the one owner of what crosses instead:
 *
 *   - {@link FY_RENDER_HTML_TOKENS}: the app tokens a page may use, by their app names, so the same
 *     `var(--accent)` works in a static fragment (which inherits them) and in a live page (which is
 *     sent them). The parent reads each from the column's computed style and posts the values; the
 *     shell admits each with {@link admitFyRenderHtmlToken} and sets it on its root.
 *   - {@link FY_RENDER_HTML_KIT_CSS}: element defaults and a small component set (`.fy-btn`,
 *     `.fy-range`, `.fy-toggle`, `.fy-bars`, …) written ONLY in those tokens, inlined into the shell
 *     document at build time. It sits in `@layer fy`, so any unlayered author rule beats it.
 *   - {@link FY_RENDER_HTML_KIT_CLASSES}: the documented class names, which the guide teaches and a
 *     unit test holds the stylesheet to.
 *
 * TRANSPARENT BY DEFAULT. The page sits on the chat or agenda surface, so its root paints nothing:
 * every colour on it comes from a token, and a page sets a colour of its own only when the colour IS
 * the content (a swatch). That needs the frame element and the page to agree on `color-scheme` —
 * a mismatch makes the browser paint an opaque backdrop behind the frame — so the parent sets the
 * frame's scheme and the shell sets the page's from the same `paint.scheme`.
 *
 * A TOKEN IS PAINT, NEVER A REQUEST. Values come from the app's own stylesheet, but the shell still
 * refuses anything that could name a resource (`url(`, `image-set(`, …), a CSS escape that could
 * spell one, or a character that could close a declaration — and the shell's policy refuses remote
 * images and fonts regardless. Web fonts the app loads are NOT available inside (`font-src data:`),
 * so a theme's font stack falls back to the reader's installed fonts there; see `docs/fy-render.md`.
 */

/** Every app token a page may read, by its app name (without the `--`). */
export const FY_RENDER_HTML_TOKENS = [
  // Colour: ink, surfaces, lines, the accent and the status tones.
  'fg',
  'fg-soft',
  'muted',
  'faint',
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-strong',
  'border-soft',
  'divider-color',
  'accent',
  'accent-soft',
  'accent-fg',
  'accent-border',
  'ok',
  'ok-bg',
  'warn',
  'warn-bg',
  'err',
  'err-bg',
  // The data-visualisation series, in order.
  'viz-1',
  'viz-2',
  'viz-3',
  'viz-4',
  'viz-5',
  'viz-6',
  'viz-7',
  'viz-8',
  // Type.
  'font-body',
  'font-ui',
  'font-mono',
  'text-2xs',
  'text-xs',
  'text-sm',
  'text-base',
  'text-md',
  'text-lg',
  'leading-base',
  'leading-tight',
  'weight-normal',
  'weight-medium',
  'weight-strong',
  'code-font-size',
  // Shape and space.
  'radius-xs',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-pill',
  'radius-control',
  'radius-input',
  'border-width',
  'gap-xs',
  'gap-sm',
  'gap-md',
  'pad-control-x',
  'control-h-sm',
  'focus-shadow',
  // The column the page sits in: its ink and font, which a page's root inherits.
  'page-fg',
  'page-font',
] as const;

export type FyRenderHtmlToken = (typeof FY_RENDER_HTML_TOKENS)[number];

/** Tokens a parent reads under another name: the column's own ink and font are not app tokens. */
export const FY_RENDER_HTML_PAGE_TOKENS = ['page-fg', 'page-font'] as const satisfies readonly FyRenderHtmlToken[];

/** The longest value admitted — a font stack or a two-layer focus shadow fits with room to spare. */
export const FY_RENDER_HTML_TOKEN_MAX_LENGTH = 400;

const TOKEN_SET: ReadonlySet<string> = new Set(FY_RENDER_HTML_TOKENS);

/**
 * Anything that could make a value name a resource or leave its declaration. `\` because a CSS
 * escape can spell `url(` in characters this check would not see; `;{}` because they end or open a
 * declaration in a context that concatenates; `<>` and `@` because no token needs them.
 */
const REFUSED_VALUE = /url\(|image-set\(|image\(|cross-fade\(|element\(|paint\(|src\(|\\|[;{}<>@]/iu;

/**
 * Whether `(name, value)` may be set on the page's root as `--name: value`: a listed token and a
 * bounded value that can only be paint. The ONE rule, used by the shell on every token it is sent.
 */
export function admitFyRenderHtmlToken(name: unknown, value: unknown): value is string {
  if (typeof name !== 'string' || !TOKEN_SET.has(name)) return false;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FY_RENDER_HTML_TOKEN_MAX_LENGTH) return false;
  return !REFUSED_VALUE.test(trimmed);
}

/**
 * The admitted subset of what a parent sent, in list order. Anything not an object, an unlisted
 * name or a refused value is dropped silently: the page then keeps the kit's own fallback for it.
 */
export function admittedFyRenderHtmlTokens(tokens: unknown): ReadonlyArray<readonly [FyRenderHtmlToken, string]> {
  if (tokens === null || typeof tokens !== 'object') return [];
  const record = tokens as Record<string, unknown>;
  const admitted: Array<readonly [FyRenderHtmlToken, string]> = [];
  for (const name of FY_RENDER_HTML_TOKENS) {
    const value = Object.hasOwn(record, name) ? record[name] : undefined;
    if (admitFyRenderHtmlToken(name, value)) admitted.push([name, value.trim()]);
  }
  return admitted;
}

/** The documented component classes. The guide teaches exactly these; the stylesheet defines each. */
export const FY_RENDER_HTML_KIT_CLASSES = [
  'fy-btn',
  'fy-btn--primary',
  'fy-btn--quiet',
  'fy-segmented',
  'fy-input',
  'fy-select',
  'fy-range',
  'fy-toggle',
  'fy-field',
  'fy-card',
  'fy-row',
  'fy-stack',
  'fy-grid',
  'fy-muted',
  'fy-num',
  'fy-chip',
  'fy-stat',
  'fy-bars',
  'fy-bar',
  'fy-meter',
  'fy-legend',
  'fy-swatch',
  'fy-table',
] as const;

/** The tone names `data-tone` takes on a bar, a swatch, a chip, a meter or an SVG mark. */
const NAMED_TONES = { accent: 'accent', bad: 'err', good: 'ok', muted: 'muted', warn: 'warn' } as const;

const toneRules = (): string => {
  const pairs: Array<readonly [string, string]> = [
    ...Array.from({ length: 8 }, (_, index) => [String(index + 1), `viz-${index + 1}`] as const),
    ...Object.entries(NAMED_TONES),
  ];
  const chipRule = (tone: string, token: string): string =>
    tone === 'muted'
      ? `.fy-chip[data-tone="muted"]{color:var(--muted)}`
      : /^[1-8]$/u.test(tone)
        ? `.fy-chip[data-tone="${tone}"]{background:color-mix(in srgb,var(--${token}) 18%,transparent);color:var(--fg)}`
        : '';
  return pairs
    .map(
      ([tone, token]) =>
        chipRule(tone, token) +
        `.fy-bar[data-tone="${tone}"],.fy-swatch[data-tone="${tone}"],.fy-meter[data-tone="${tone}"]{--fy-tone:var(--${token})}` +
        `svg [data-tone="${tone}"]{fill:var(--${token})}svg [data-tone="${tone}"][fill="none"]{fill:none;stroke:var(--${token})}`,
    )
    .join('\n');
};

/**
 * THE COMPONENT RULES, which also apply inside a static fragment's shadow root: class selectors
 * only, so they never restyle an author's plain markup there.
 */
const COMPONENT_CSS = `
.fy-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:var(--text-sm,13px);line-height:1;min-height:var(--control-h-sm,28px);padding:0 var(--pad-control-x,10px);border:var(--border-width,1px) solid var(--border-strong,currentColor);border-radius:var(--radius-control,var(--radius-sm,6px));background:var(--surface-2,transparent);color:var(--fg,inherit);cursor:pointer;white-space:nowrap}
.fy-btn:hover{background:var(--surface-3,transparent)}
.fy-btn:disabled{opacity:.5;cursor:default}
.fy-btn[aria-pressed="true"]{background:var(--accent-soft,transparent);border-color:var(--accent,currentColor)}
.fy-btn--primary{background:var(--accent);border-color:var(--accent-border,var(--accent));color:var(--accent-fg,var(--bg))}
.fy-btn--primary:hover{background:var(--accent);filter:brightness(1.08)}
.fy-btn--quiet{background:transparent;border-color:transparent;color:var(--fg-soft,inherit)}
.fy-btn--quiet:hover{background:var(--surface-2,transparent);color:var(--fg,inherit)}
.fy-segmented{display:inline-flex;flex-wrap:wrap}
.fy-segmented>.fy-btn{border-radius:0;margin-left:calc(-1 * var(--border-width,1px))}
.fy-segmented>.fy-btn:first-child{margin-left:0;border-radius:var(--radius-control,var(--radius-sm,6px)) 0 0 var(--radius-control,var(--radius-sm,6px))}
.fy-segmented>.fy-btn:last-child{border-radius:0 var(--radius-control,var(--radius-sm,6px)) var(--radius-control,var(--radius-sm,6px)) 0}
.fy-input,.fy-select{font:inherit;font-size:var(--text-sm,13px);min-height:var(--control-h-sm,28px);max-width:100%;padding:0 8px;border:var(--border-width,1px) solid var(--border-strong,currentColor);border-radius:var(--radius-input,var(--radius-sm,6px));background:transparent;color:var(--fg,inherit)}
.fy-input:focus,.fy-select:focus{border-color:var(--accent,currentColor);outline:none;box-shadow:var(--focus-shadow,none)}
.fy-range{appearance:none;-webkit-appearance:none;width:100%;min-width:80px;height:20px;margin:0;background:transparent;accent-color:var(--accent);cursor:pointer}
.fy-range::-webkit-slider-runnable-track{height:4px;border-radius:var(--radius-pill,999px);background:var(--surface-3,var(--border))}
.fy-range::-moz-range-track{height:4px;border-radius:var(--radius-pill,999px);background:var(--surface-3,var(--border))}
.fy-range::-moz-range-progress{height:4px;border-radius:var(--radius-pill,999px);background:var(--accent)}
.fy-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;border:2px solid var(--accent);background:var(--bg,Canvas)}
.fy-range::-moz-range-thumb{width:12px;height:12px;border-radius:50%;border:2px solid var(--accent);background:var(--bg,Canvas)}
.fy-range:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--radius-pill,999px)}
.fy-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--accent-soft)}
.fy-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm,13px)}
.fy-toggle>input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:30px;height:18px;margin:0;border-radius:var(--radius-pill,999px);background:var(--surface-3,var(--border));transition:background .15s;cursor:pointer}
.fy-toggle>input::before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--fg-soft,CanvasText);transition:transform .15s,background .15s}
.fy-toggle>input:checked{background:var(--accent)}
.fy-toggle>input:checked::before{transform:translateX(12px);background:var(--accent-fg,var(--bg,Canvas))}
.fy-toggle>input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fy-field{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr) auto;align-items:center;gap:4px 10px;font-size:var(--text-sm,13px);color:var(--fg-soft,inherit)}
.fy-field>output{min-width:3ch;text-align:right;color:var(--fg,inherit);font-variant-numeric:tabular-nums}
.fy-card{padding:12px;border:var(--border-width,1px) solid var(--border-soft,var(--border));border-radius:var(--radius-md,9px);background:transparent}
.fy-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--gap-sm,8px)}
.fy-stack{display:flex;flex-direction:column;gap:var(--gap-sm,8px)}
.fy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:var(--gap-sm,8px)}
.fy-muted{color:var(--fg-soft,inherit)}
.fy-num{font-variant-numeric:tabular-nums;text-align:right}
.fy-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:var(--radius-pill,999px);background:var(--surface-2,transparent);color:var(--fg-soft,inherit);font-size:var(--text-xs,12px)}
.fy-chip[data-tone="good"]{background:var(--ok-bg);color:var(--ok)}
.fy-chip[data-tone="warn"]{background:var(--warn-bg);color:var(--warn)}
.fy-chip[data-tone="bad"]{background:var(--err-bg);color:var(--err)}
.fy-chip[data-tone="accent"]{background:var(--accent-soft);color:var(--accent)}
.fy-stat{display:flex;flex-direction:column;gap:2px;font-size:var(--text-xs,12px);color:var(--fg-soft,inherit)}
.fy-stat>b,.fy-stat>strong{font-size:var(--text-lg,18px);font-weight:var(--weight-strong,600);color:var(--fg,inherit);font-variant-numeric:tabular-nums}
.fy-bars{--fy-bars-height:160px;display:flex;align-items:flex-end;gap:6px;height:var(--fy-bars-height);padding:18px 0 20px;border-bottom:var(--border-width,1px) solid var(--border,currentColor)}
.fy-bar{--fy-tone:var(--viz-1,var(--accent));position:relative;flex:1 1 0;min-width:0;height:calc(clamp(0,var(--v,0),100) * 1%);border-radius:var(--radius-xs,3px) var(--radius-xs,3px) 0 0;background:var(--fy-tone);transition:height .2s ease}
.fy-bar[data-value]::before{content:attr(data-value);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding-bottom:2px;font-size:var(--text-2xs,11px);color:var(--fg,inherit);white-space:nowrap;font-variant-numeric:tabular-nums}
.fy-bar[data-label]::after{content:attr(data-label);position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);max-width:calc(100% + 6px);overflow:hidden;text-overflow:ellipsis;font-size:var(--text-2xs,11px);color:var(--fg-soft,inherit);white-space:nowrap}
.fy-meter{--fy-tone:var(--accent);position:relative;height:8px;border-radius:var(--radius-pill,999px);background:var(--surface-3,var(--border));overflow:hidden}
.fy-meter::before{content:"";position:absolute;inset:0 auto 0 0;width:calc(clamp(0,var(--v,0),100) * 1%);border-radius:inherit;background:var(--fy-tone);transition:width .2s ease}
.fy-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:var(--text-xs,12px);color:var(--fg-soft,inherit)}
.fy-legend>*{display:inline-flex;align-items:center;gap:6px}
.fy-swatch{--fy-tone:var(--viz-1,var(--accent));display:inline-block;flex:none;width:10px;height:10px;border-radius:var(--radius-xs,2px);background:var(--fy-tone)}
.fy-table{width:100%;border-collapse:collapse;font-size:var(--text-sm,13px)}
.fy-table th,.fy-table td{padding:5px 8px;border-bottom:var(--border-width,1px) solid var(--border-soft,var(--border));text-align:left;vertical-align:top;overflow-wrap:anywhere}
.fy-table th{color:var(--fg-soft,inherit);font-weight:var(--weight-medium,500)}
.fy-table .fy-num{text-align:right}
${toneRules()}
@media (prefers-reduced-motion: reduce){.fy-bar,.fy-meter::before,.fy-toggle>input,.fy-toggle>input::before{transition:none}}
`;

/**
 * THE PAGE'S DEFAULTS, for the live page only: a transparent root in the column's ink and font,
 * plain controls already in the kit's look, nothing wider than the frame and no inner scroll.
 * `html[data-fy-fullscreen]` is the one state that may scroll — the whole screen is the page there.
 */
const PAGE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{background:transparent;color:var(--page-fg,var(--fg,CanvasText));font-family:var(--page-font,var(--font-body,ui-sans-serif,system-ui,sans-serif));font-size:var(--text-base,14px);line-height:var(--leading-base,1.5);-webkit-text-size-adjust:100%;overflow:hidden}
html[data-fy-fullscreen]{overflow:auto}
body{margin:0;max-width:100%;overflow-wrap:anywhere}
img,video{max-width:100%;height:auto}
svg,canvas{max-width:100%}
canvas{height:auto}
pre{white-space:pre-wrap}
code,kbd,pre,samp{font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--code-font-size,.92em)}
a{color:var(--accent)}
h1,h2,h3,h4{margin:0 0 .4em;font-weight:var(--weight-strong,600);line-height:var(--leading-tight,1.25)}
h1{font-size:var(--text-lg,18px)}h2{font-size:var(--text-md,16px)}h3,h4{font-size:var(--text-base,14px)}
p{margin:0 0 .6em}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:var(--text-sm,13px);line-height:1;min-height:var(--control-h-sm,28px);padding:0 var(--pad-control-x,10px);border:var(--border-width,1px) solid var(--border-strong,currentColor);border-radius:var(--radius-control,var(--radius-sm,6px));background:var(--surface-2,transparent);color:var(--fg,inherit);cursor:pointer}
button:hover{background:var(--surface-3,transparent)}
button:disabled{opacity:.5;cursor:default}
button[aria-pressed="true"]{background:var(--accent-soft,transparent);border-color:var(--accent,currentColor)}
input,select,textarea{font:inherit;font-size:var(--text-sm,13px);color:var(--fg,inherit);max-width:100%}
input:not([type]),input[type="text"],input[type="number"],input[type="search"],select,textarea{min-height:var(--control-h-sm,28px);padding:0 8px;border:var(--border-width,1px) solid var(--border-strong,currentColor);border-radius:var(--radius-input,var(--radius-sm,6px));background:transparent}
textarea{padding:6px 8px}
input[type="range"],input[type="checkbox"],input[type="radio"],progress,meter{accent-color:var(--accent)}
table{border-collapse:collapse;max-width:100%}
th,td{padding:4px 8px;border-bottom:var(--border-width,1px) solid var(--border-soft,var(--border));text-align:left;overflow-wrap:anywhere}
output{font-variant-numeric:tabular-nums}
`;

/** The live page's whole kit: its defaults and the components, in the layer every author rule beats. */
export const FY_RENDER_HTML_KIT_CSS = `@layer fy{${PAGE_CSS}${COMPONENT_CSS}}`;

/** The components alone, for a static fragment's shadow root — which inherits the tokens already. */
export const FY_RENDER_HTML_COMPONENT_CSS = `@layer fy{${COMPONENT_CSS}}`;
