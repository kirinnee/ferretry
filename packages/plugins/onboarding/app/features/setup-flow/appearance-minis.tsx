/**
 * THE APPEARANCE CARDS' LITTLE PICTURES (C59 O6c): each Style and Palette card carries a tiny scene drawn IN what it names, so a
 * card is a preview of the thing and not a description of it. A `data-swatch` scope re-declares every token locally
 * (`styles/themes.css` in the app), so a Style mini shows that style's real type, radius and shadow in the palette it comes with
 * and the mode in force, and a Palette mini shows that palette's real page and accent in BOTH modes, in the style in force.
 * Decorative: the card's own title is its name (the frame's slot is read as radio cards; the picture is `aria-hidden`).
 */
import type { PaletteId, StyleId } from '@ferretry/app';
import type { ReactNode } from 'react';

type Mode = 'light' | 'dark';

/** The attributes that make an element render in a look of its own, whatever the page around it is. */
const wear = (style: StyleId, palette: PaletteId, mode: Mode): Readonly<Record<string, string>> => ({
  'data-swatch': `${palette}-${mode}`,
  'data-style': style,
  'data-palette': palette,
  'data-mode': mode,
});

/** A style, drawn in itself: its display face, a button (radius, stroke) and a card (radius, shadow). */
export function StyleMini({
  style,
  palette,
  mode,
}: {
  readonly style: StyleId;
  readonly palette: PaletteId;
  readonly mode: Mode;
}): ReactNode {
  return (
    <span className="fy-astep__mini" {...wear(style, palette, mode)}>
      <span className="fy-astep__mini-top">
        <b className="fy-astep__mini-type">Ag</b>
        <i className="fy-astep__mini-button" />
      </span>
      <i className="fy-astep__mini-card" />
    </span>
  );
}

/** A palette, drawn in itself: its light half and its dark half, each with its own page, accent and ink. */
export function PaletteMini({ style, palette }: { readonly style: StyleId; readonly palette: PaletteId }): ReactNode {
  return (
    <span className="fy-astep__chip">
      {(['light', 'dark'] as const).map(mode => (
        <span key={mode} className="fy-astep__half" {...wear(style, palette, mode)}>
          <i className="fy-astep__half-accent" />
          <i className="fy-astep__half-ink" />
        </span>
      ))}
    </span>
  );
}
