/**
 * THE LOOK PICKERS: Style as choice cards, each drawn IN its own style, and Palette as a row of two-colour chips.
 * Both are previews of the real thing, never a description: a `data-swatch` scope re-declares every token locally
 * (`styles/themes.css`), so a card shows that style's real type, radius, stroke and shadow in the palette and mode the
 * person already has, and a chip shows that palette's real background and accent in the style they already have.
 */
import { type KeyboardEvent, useId, useRef } from 'react';
import { ChoiceCards } from '../compose/choice-cards.tsx';
import type { PaletteEntry, PaletteId, StyleEntry, StyleId } from '../theme/catalog.ts';
import type { ResolvedMode } from '../theme/preferences.ts';
import './appearance-pickers.css';

/** The three axes a preview wears. */
export interface Look {
  readonly style: StyleId;
  readonly palette: PaletteId;
  readonly mode: ResolvedMode;
}

/** The attributes that make an element render in `look` whatever the page around it is. */
export function lookAttributes(look: Look): Readonly<Record<string, string>> {
  return {
    'data-swatch': `${look.palette}-${look.mode}`,
    'data-style': look.style,
    'data-palette': look.palette,
    'data-mode': look.mode,
  };
}

/** A tiny scene drawn in a style: a heading, a button (radius, stroke, press shadow) and a card corner with its shadow. */
function StyleMini({ look }: { readonly look: Look }) {
  return (
    <span className="fy-ap-mini" {...lookAttributes(look)}>
      <span className="fy-ap-mini__text">
        <b className="fy-ap-mini__type">Aa</b>
        <em className="fy-ap-mini__label">Label</em>
      </span>
      <i className="fy-ap-mini__button" />
      <i className="fy-ap-mini__card" />
    </span>
  );
}

export function StylePicker({
  styles,
  value,
  palette,
  mode,
  onChange,
}: {
  readonly styles: readonly StyleEntry[];
  readonly value: StyleId;
  readonly palette: PaletteId;
  readonly mode: ResolvedMode;
  readonly onChange: (style: StyleId) => void;
}) {
  return (
    <ChoiceCards
      label="Style"
      value={value}
      onChange={id => onChange(id as StyleId)}
      options={styles.map(style => ({
        id: style.id,
        title: style.label,
        line: style.blurb,
        demo: <StyleMini look={{ style: style.id, palette, mode }} />,
      }))}
    />
  );
}

const KEYS = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

/** One chip: the palette's light half and its dark half, each with its own background and accent. */
function Chip({ palette, style }: { readonly palette: PaletteId; readonly style: StyleId }) {
  return (
    <span className="fy-ap-chip__swatch" aria-hidden="true">
      {(['light', 'dark'] as const).map(mode => (
        <span key={mode} className="fy-ap-chip__half" {...lookAttributes({ style, palette, mode })}>
          <i className="fy-ap-chip__accent" />
          <i className="fy-ap-chip__ink" />
        </span>
      ))}
    </span>
  );
}

/** Roving radios like `Segmented`: the checked chip is the one tab stop, the arrow keys move AND select. */
export function PalettePicker({
  palettes,
  value,
  style,
  onChange,
}: {
  readonly palettes: readonly PaletteEntry[];
  readonly value: PaletteId;
  readonly style: StyleId;
  readonly onChange: (palette: PaletteId) => void;
}) {
  const group = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!KEYS.includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(
      0,
      palettes.findIndex(option => option.id === value),
    );
    const last = palettes.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? Math.min(last, index + 1)
            : Math.max(0, index - 1);
    const target = palettes[next];
    if (target === undefined) return;
    onChange(target.id);
    ref.current?.querySelector<HTMLInputElement>(`input[value="${target.id}"]`)?.focus({ preventScroll: true });
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label="Palette"
      onKeyDown={onKeyDown}
      className="fy-ap-chips"
      data-palette-chips=""
    >
      {palettes.map(option => {
        const checked = option.id === value;
        return (
          <label
            key={option.id}
            className="fy-ap-chip"
            data-selected={checked}
            data-palette-chip={option.id}
            title={option.blurb}
          >
            <input
              type="radio"
              name={`${group}-palette`}
              value={option.id}
              checked={checked}
              aria-label={`${option.label} — ${option.blurb}`}
              tabIndex={checked ? 0 : -1}
              onChange={() => onChange(option.id)}
              className="sr-only"
            />
            <Chip palette={option.id} style={style} />
            <span className="fy-ap-chip__name">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
