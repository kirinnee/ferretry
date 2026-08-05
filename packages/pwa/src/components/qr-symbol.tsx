/**
 * A QR symbol as SVG, drawn from a matrix this bundle computed.
 *
 * ## WHY SVG AND NOT AN IMAGE
 *
 * There is no request. The modules come from `encodeQr` in this tab, so the credential inside the symbol
 * never leaves the browser that legitimately holds it — an `<img src>` pointing at any encoder service
 * would hand it to a stranger. SVG also scales without resampling, which matters because the reader may
 * be aiming a phone at a laptop screen at whatever zoom the page happens to be at.
 *
 * ## THE QUIET ZONE IS PART OF THE SYMBOL, NOT PADDING
 *
 * The standard's four-module margin is inside the `viewBox`, so it survives any layout the parent
 * imposes. A QR flush against a dark panel edge is one a scanner cannot find, and that failure looks
 * exactly like a broken code.
 *
 * ## IT IS ALWAYS DARK-ON-LIGHT, IN BOTH THEMES
 *
 * The white background is painted rather than inherited. A scanner reads luminance and expects dark
 * modules on light, so a symbol that inverted itself in dark mode would be unreadable on half the
 * devices this product runs on — and the person aiming the camera would have no way to know why.
 */

import type { QrMatrix } from '../lib/qr-code.ts';

/** The standard's margin, in modules. Four, and it is not a style choice. */
const QUIET_ZONE = 4;

export interface QrSymbolProps {
  readonly matrix: QrMatrix;
  /**
   * What the symbol IS, for anybody not looking at it.
   *
   * Never the encoded value. A screen reader announcing a pairing URL reads a live credential aloud, and
   * a credential in the accessibility tree is a credential in every tool that walks it.
   */
  readonly label: string;
  readonly className?: string;
}

/**
 * The rendered symbol.
 *
 * ONE PATH FOR EVERY DARK MODULE rather than a rect each. A version-8 symbol has around 1,200 dark
 * modules, and 1,200 elements is a layout cost a phone pays on every re-render of the panel around it —
 * the countdown beside this ticks once a second.
 */
export function QrSymbol({ matrix, label, className }: QrSymbolProps) {
  const span = matrix.size + QUIET_ZONE * 2;
  const path = matrix.modules
    .flatMap((row, y) =>
      row.flatMap((dark, x) => (dark ? [`M${String(x + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h1v1h-1z`] : [])),
    )
    .join('');

  return (
    <svg
      viewBox={`0 0 ${String(span)} ${String(span)}`}
      role="img"
      aria-label={label}
      data-qr-version={String(matrix.version)}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
