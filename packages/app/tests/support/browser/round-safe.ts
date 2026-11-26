/**
 * THE ROUND-SAFE GATE: content never leaves the inner rounded rectangle of the box it sits in.
 *
 * The owner's rule (r11-3 Themes gate line 3, then again 2026-11-25: "for high rounded, we need to take that into
 * consideration when writing — now its just looks buggy"): every surface is written for the HIGHEST rounding, not just
 * for the default. The theme owns two halves of that rule (`styles/tokens/base-style.css`, "ROUND-SAFE GEOMETRY"):
 *
 *   1. the radius a box really gets is CAPPED by `--radius-cap`, so a tall or multi-line box is never a stadium;
 *   2. the inline padding of a themed box GROWS with that radius (`--inset-round`), so text meets no curve.
 *
 * This file is the proof, geometric and not a human look. A page is read in a real browser by `collectRoundBoxes`
 * (serialised into the page: no closure), and the pure `roundMisses` judges what it read: for every rounded box, every
 * piece of content inside it (a line of text, an image, a nested painted box such as a button) must have its four
 * corners inside the box's INNER rounded rectangle (the border box inset by its borders, with the used radii: the
 * computed radii scaled down together when two corners would overlap, as CSS does).
 *
 * In-flow content that is only PARTLY inside its box fails too, wherever it pokes out (a button 4px past a banner's left edge near
 * its bottom corner is the owner's bug, and a gate that skipped it passed green): an edge it crosses is a miss, as is a corner it
 * is past. Only content that sits outside the box altogether, or out of flow (absolute, fixed), or that a clipping or scrolling
 * box cuts (`overflow` other than `visible`, an ellipsis), is judged just where it sits inside.
 *
 * What it does not judge, on purpose: a box that paints nothing (no fill, border or shadow: it shows no curve), an inline phrase
 * that wraps over lines, content that sits outside the box altogether (a popover, an overflow: that is
 * the overflow checks' business), a box under 28px a side (a dot, a badge, a check mark), and a painted child or an
 * icon in a box that clips its content to its own curve (`overflow` other than `visible`); a line of TEXT is judged in
 * a clipping box too, because a clipped letter is still a cut-off letter.
 */
import type { Page } from 'playwright-core';

/** A corner's horizontal and vertical radius, in px. */
interface CornerRadius {
  readonly x: number;
  readonly y: number;
}

export interface Corners {
  readonly tl: CornerRadius;
  readonly tr: CornerRadius;
  readonly br: CornerRadius;
  readonly bl: CornerRadius;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** One piece of content: a line of text, or a painted child. `radii` is the child's own rounding (a button's pill). */
interface RawLeaf {
  readonly what: string;
  readonly kind: 'text' | 'painted';
  readonly rect: Rect;
  readonly radii?: Corners;
  /**
   * True for content in the box's normal flow that nothing clips: it must stay inside the box altogether, so a part of it past
   * an EDGE is a miss too (the owner's bug: a button poking out of a banner's corner). False for an out-of-flow or clipped
   * piece (a popover, a badge, text a scroller cuts), which is judged only where it sits inside the box.
   */
  readonly inFlow?: boolean;
}

/** One rounded box, as the page reports it, with only the content that reaches one of its corner zones. */
export interface RawBox {
  readonly what: string;
  /** The padding box (the border box inset by its borders), in viewport px. */
  readonly inner: Rect;
  /** The border box, in viewport px: what in-flow content may not leave. */
  readonly outer?: Rect;
  /** The USED radii of the inner edge, in px (scaled, then reduced by the border widths). */
  readonly radii: Corners;
  readonly leaves: readonly RawLeaf[];
}

export interface RoundMiss {
  readonly box: string;
  readonly leaf: string;
  /** A corner the content is past the curve of, or the side of the box it pokes out of. */
  readonly corner: 'tl' | 'tr' | 'br' | 'bl' | 'left' | 'right' | 'top' | 'bottom';
  /** How far past the curve the corner of the content is, in px. */
  readonly outsideBy: number;
  readonly radius: string;
}

/** Sub-pixel layout noise is not a miss. */
const ROUND_TOLERANCE_PX = 0.75;
/** How far in-flow content may sit past its box's border edge before it is a protrusion (borders and sub-pixel rounding). */
const EDGE_TOLERANCE_PX = 1;

/**
 * How far a point is OUTSIDE the inner rounded rectangle, measured along the corner arc's radius, in px; 0 or less when
 * it is inside. Only the four corner zones can say "outside": everywhere else the rectangle is straight.
 */
export const outsideCurveBy = (x: number, y: number, rect: Rect, radii: Corners): number => {
  const zones = [
    {
      c: radii.tl,
      cx: rect.left + radii.tl.x,
      cy: rect.top + radii.tl.y,
      inX: x < rect.left + radii.tl.x,
      inY: y < rect.top + radii.tl.y,
    },
    {
      c: radii.tr,
      cx: rect.right - radii.tr.x,
      cy: rect.top + radii.tr.y,
      inX: x > rect.right - radii.tr.x,
      inY: y < rect.top + radii.tr.y,
    },
    {
      c: radii.br,
      cx: rect.right - radii.br.x,
      cy: rect.bottom - radii.br.y,
      inX: x > rect.right - radii.br.x,
      inY: y > rect.bottom - radii.br.y,
    },
    {
      c: radii.bl,
      cx: rect.left + radii.bl.x,
      cy: rect.bottom - radii.bl.y,
      inX: x < rect.left + radii.bl.x,
      inY: y > rect.bottom - radii.bl.y,
    },
  ];
  let worst = Number.NEGATIVE_INFINITY;
  for (const zone of zones) {
    if (!zone.inX || !zone.inY || zone.c.x <= 0 || zone.c.y <= 0) continue;
    // Normalised to a circle: distance from the arc's centre, in units of the horizontal radius.
    const dx = (x - zone.cx) / zone.c.x;
    const dy = (y - zone.cy) / zone.c.y;
    worst = Math.max(worst, (Math.hypot(dx, dy) - 1) * Math.min(zone.c.x, zone.c.y));
  }
  // A point in no corner zone is on a straight edge: inside as far as this check goes.
  return worst === Number.NEGATIVE_INFINITY ? 0 : worst;
};

const NAMES = ['tl', 'tr', 'br', 'bl'] as const;

/** The point of a painted child's corner that must be inside: the point of its own arc at 45 degrees, not its square corner. */
const cornerPoint = (
  rect: Rect,
  corner: (typeof NAMES)[number],
  own: CornerRadius | undefined,
): readonly [number, number] => {
  // 1 - cos(45 degrees): how far in from each edge the arc is at its middle.
  const k = 1 - Math.SQRT1_2;
  const dx = own === undefined ? 0 : own.x * k;
  const dy = own === undefined ? 0 : own.y * k;
  switch (corner) {
    case 'tl':
      return [rect.left + dx, rect.top + dy];
    case 'tr':
      return [rect.right - dx, rect.top + dy];
    case 'br':
      return [rect.right - dx, rect.bottom - dy];
    case 'bl':
      return [rect.left + dx, rect.bottom - dy];
  }
};

const describeRadius = (c: CornerRadius): string => `${Math.round(c.x * 10) / 10}x${Math.round(c.y * 10) / 10}px`;

/** Every corner of every piece of content that is past the curve of the box it sits in. Pure. */
export const roundMisses = (boxes: readonly RawBox[]): readonly RoundMiss[] => {
  const out: RoundMiss[] = [];
  for (const box of boxes) {
    for (const leaf of box.leaves) {
      if (leaf.inFlow === true && box.outer !== undefined) {
        const sides = [
          ['left', box.outer.left - leaf.rect.left],
          ['right', leaf.rect.right - box.outer.right],
          ['top', box.outer.top - leaf.rect.top],
          ['bottom', leaf.rect.bottom - box.outer.bottom],
        ] as const;
        for (const [side, past] of sides)
          if (past > EDGE_TOLERANCE_PX)
            out.push({
              box: box.what,
              leaf: leaf.what,
              corner: side,
              outsideBy: Math.round(past * 10) / 10,
              radius: describeRadius(box.radii.tl),
            });
      }
      for (const corner of NAMES) {
        const [x, y] = cornerPoint(leaf.rect, corner, leaf.radii?.[corner]);
        const past = outsideCurveBy(x, y, box.inner, box.radii);
        if (past > ROUND_TOLERANCE_PX)
          out.push({
            box: box.what,
            leaf: leaf.what,
            corner,
            outsideBy: Math.round(past * 10) / 10,
            radius: describeRadius(box.radii[corner]),
          });
      }
    }
  }
  return out;
};

/**
 * Reads every rounded box of the page. SERIALISED INTO THE PAGE by `page.evaluate`: it closes over nothing.
 * It keeps only the content whose rectangle reaches one of a box's corner zones, so the result stays small.
 */
const collectRoundBoxes = (): RawBox[] => {
  const MIN_SIDE = 28;
  const describe = (element: Element): string => {
    const html = element as HTMLElement;
    const hooks = Array.from(html.attributes)
      .filter(attribute => attribute.name.startsWith('data-') && attribute.name !== 'data-reactroot')
      .slice(0, 2)
      .map(attribute => `[${attribute.name}${attribute.value === '' ? '' : `=${attribute.value.slice(0, 16)}`}]`)
      .join('');
    const classes = String(html.getAttribute('class') ?? '')
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 3)
      .map(name => `.${name}`)
      .join('');
    const text = (html.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 24);
    return `${element.tagName.toLowerCase()}${hooks}${classes}${text === '' ? '' : ` "${text}"`}`;
  };
  const px = (value: string, basis: number): number => {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return value.trim().endsWith('%') ? (n / 100) * basis : n;
  };
  const cornerOf = (style: CSSStyleDeclaration, name: string, w: number, h: number): { x: number; y: number } => {
    const parts = style.getPropertyValue(name).trim().split(/\s+/u);
    return { x: px(parts[0] ?? '0', w), y: px(parts[1] ?? parts[0] ?? '0', h) };
  };
  const used = (style: CSSStyleDeclaration, w: number, h: number) => {
    const tl = cornerOf(style, 'border-top-left-radius', w, h);
    const tr = cornerOf(style, 'border-top-right-radius', w, h);
    const br = cornerOf(style, 'border-bottom-right-radius', w, h);
    const bl = cornerOf(style, 'border-bottom-left-radius', w, h);
    // CSS scales ALL radii by one factor when two neighbours would overlap.
    const ratios = [
      tl.x + tr.x > 0 ? w / (tl.x + tr.x) : 1,
      bl.x + br.x > 0 ? w / (bl.x + br.x) : 1,
      tl.y + bl.y > 0 ? h / (tl.y + bl.y) : 1,
      tr.y + br.y > 0 ? h / (tr.y + br.y) : 1,
    ];
    const f = Math.min(1, ...ratios);
    const scale = (c: { x: number; y: number }) => ({ x: c.x * f, y: c.y * f });
    return { tl: scale(tl), tr: scale(tr), br: scale(br), bl: scale(bl) };
  };
  const visible = (element: Element): boolean => {
    // Content a browser skips (inside a closed `<details>`, `content-visibility: hidden`) has geometry but is not on screen.
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const r = element.getBoundingClientRect();
    // 1px or less is a visually-hidden element (`sr-only`), not content.
    return r.width > 1 && r.height > 1;
  };
  /** What a box paints. `all`: a fill or a border on all four sides (the whole shape is drawn); `some`: a border on one side only (a hairline, a rule). */
  const paint = (element: Element, style: CSSStyleDeclaration): 'all' | 'some' | 'none' => {
    if (['IMG', 'CANVAS', 'VIDEO', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return 'all';
    if (element instanceof SVGElement) return element.tagName.toLowerCase() === 'svg' ? 'all' : 'none';
    const bg = style.backgroundColor;
    if ((bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || style.backgroundImage !== 'none') return 'all';
    const sides = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(
      width => Number.parseFloat(width) > 0,
    );
    if (sides.every(Boolean)) return 'all';
    return sides.some(Boolean) ? 'some' : 'none';
  };

  const boxes: RawBox[] = [];
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (element instanceof SVGElement && element.tagName.toLowerCase() !== 'svg') continue;
    const style = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    if (r.width < MIN_SIDE || r.height < MIN_SIDE || !visible(element)) continue;
    // A phrase that wraps (an inline mark across two lines) has no one box: its curves are at its two ends, not at the corners of the union.
    if (style.display === 'inline' && element.getClientRects().length > 1) continue;
    const radii = used(style, r.width, r.height);
    if (Object.values(radii).every(c => c.x < 2 && c.y < 2)) continue;
    // A box that paints nothing (no fill, no border, no shadow) shows no curve for content to meet.
    if (paint(element, style) === 'none' && style.boxShadow === 'none') continue;
    const bw = {
      t: Number.parseFloat(style.borderTopWidth) || 0,
      r: Number.parseFloat(style.borderRightWidth) || 0,
      b: Number.parseFloat(style.borderBottomWidth) || 0,
      l: Number.parseFloat(style.borderLeftWidth) || 0,
    };
    const inner = { left: r.left + bw.l, top: r.top + bw.t, right: r.right - bw.r, bottom: r.bottom - bw.b };
    const innerRadii = {
      tl: { x: Math.max(0, radii.tl.x - bw.l), y: Math.max(0, radii.tl.y - bw.t) },
      tr: { x: Math.max(0, radii.tr.x - bw.r), y: Math.max(0, radii.tr.y - bw.t) },
      br: { x: Math.max(0, radii.br.x - bw.r), y: Math.max(0, radii.br.y - bw.b) },
      bl: { x: Math.max(0, radii.bl.x - bw.l), y: Math.max(0, radii.bl.y - bw.b) },
    };
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    const reachesACorner = (rect: { left: number; top: number; right: number; bottom: number }): boolean =>
      (rect.left < inner.left + innerRadii.tl.x && rect.top < inner.top + innerRadii.tl.y) ||
      (rect.right > inner.right - innerRadii.tr.x && rect.top < inner.top + innerRadii.tr.y) ||
      (rect.right > inner.right - innerRadii.br.x && rect.bottom > inner.bottom - innerRadii.br.y) ||
      (rect.left < inner.left + innerRadii.bl.x && rect.bottom > inner.bottom - innerRadii.bl.y);
    // Content outside the box altogether (a popover, an overflow) is another check's business.
    const within = (rect: { left: number; top: number; right: number; bottom: number }): boolean =>
      rect.left >= r.left - 1 && rect.top >= r.top - 1 && rect.right <= r.right + 1 && rect.bottom <= r.bottom + 1;
    const overlaps = (rect: { left: number; top: number; right: number; bottom: number }): boolean =>
      rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top;
    // In-flow content that nothing clips must stay inside the box: a part of it past an edge is a PROTRUSION, judged, not skipped
    // (a button poking 4px out of a banner's corner is the owner's bug). Out-of-flow pieces (absolute, fixed, a popover) and
    // content a clipping or scrolling box cuts are judged only where they sit inside the box.
    // `overflow` clips an element's CONTENTS, never its own box: when `start` is the painted child itself (`own`), its own overflow
    // exempts nothing (its border box is still checked against the rounded ancestor); only the ancestors it sits in can clip it.
    const inFlowOf = (start: Element | null, own = false): boolean => {
      for (let at = start; at !== null; at = at.parentElement) {
        const s = getComputedStyle(at);
        if (at !== element && (s.position === 'absolute' || s.position === 'fixed')) return false;
        const clipsItself = own && at === start;
        if (!clipsItself && (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.textOverflow === 'ellipsis'))
          return false;
        if (at === element) return true;
      }
      return false;
    };
    const judged = (rect: { left: number; top: number; right: number; bottom: number }, flows: boolean): boolean =>
      flows ? overlaps(rect) && (within(rect) ? reachesACorner(rect) : true) : within(rect) && reachesACorner(rect);

    const leaves: RawLeaf[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (
          parent !== null &&
          (node.textContent ?? '').trim() !== '' &&
          visible(parent) &&
          !parent.closest('svg, script, style')
        ) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const line of Array.from(range.getClientRects())) {
            const rect = { left: line.left, top: line.top, right: line.right, bottom: line.bottom };
            // A line a descendant clips (a truncated title: its text runs on under an ellipsis) is judged where it is SEEN, not
            // where it would run to. The box's own clipping is not taken: a clipped letter in the box itself is still cut off.
            for (let at: Element | null = parent; at !== null && at !== element; at = at.parentElement) {
              const cs = getComputedStyle(at);
              if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
              const cr = at.getBoundingClientRect();
              rect.left = Math.max(rect.left, cr.left);
              rect.top = Math.max(rect.top, cr.top);
              rect.right = Math.min(rect.right, cr.right);
              rect.bottom = Math.min(rect.bottom, cr.bottom);
            }
            if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
            const flows = inFlowOf(parent);
            if (judged(rect, flows))
              leaves.push({
                what: `text "${(node.textContent ?? '').trim().slice(0, 24)}"`,
                kind: 'text',
                rect,
                inFlow: flows,
              });
          }
        }
      } else {
        const child = node as Element;
        if (child instanceof SVGElement && child.tagName.toLowerCase() !== 'svg') {
          node = walker.nextNode();
          continue;
        }
        const childStyle = getComputedStyle(child);
        // A child that paints one rule (a header's bottom hairline) fills no corner, so its square corner shows nothing.
        if (!clips && visible(child) && paint(child, childStyle) === 'all') {
          const cr = child.getBoundingClientRect();
          const rect = { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom };
          const flows = inFlowOf(child, true);
          if (judged(rect, flows)) {
            // A child that fills its parent's whole box is the same box, not content: skip a twin of the parent.
            const twin =
              Math.abs(cr.left - r.left) < 1 &&
              Math.abs(cr.right - r.right) < 1 &&
              Math.abs(cr.top - r.top) < 1 &&
              Math.abs(cr.bottom - r.bottom) < 1;
            if (!twin)
              leaves.push({
                what: describe(child),
                kind: 'painted',
                rect,
                radii: used(childStyle, cr.width, cr.height),
                inFlow: flows,
              });
          }
        }
      }
      node = walker.nextNode();
    }
    if (leaves.length > 0)
      boxes.push({
        what: describe(element),
        inner,
        outer: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        radii: innerRadii,
        leaves,
      });
  }
  return boxes;
};

/** Reads a page and judges it: the misses, by box and corner (empty = round-safe). */
export const roundSafeMisses = async (page: Page): Promise<readonly RoundMiss[]> =>
  roundMisses(await page.evaluate(collectRoundBoxes));

/** A readable line per miss, for an assertion message. */
export const describeRoundMisses = (misses: readonly RoundMiss[]): string =>
  misses
    .map(m => `  ${m.box}\n    <- ${m.leaf} pokes ${m.outsideBy}px past its ${m.corner} corner (radius ${m.radius})`)
    .join('\n');
