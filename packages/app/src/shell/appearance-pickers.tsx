/**
 * THE LOOK PICKERS: Style as choice cards, each drawn IN its own style, and Palette as a row of two-colour chips.
 * Both are previews of the real thing, never a description: a `data-swatch` scope re-declares every token locally
 * (`styles/themes.css`), so a card shows that style's real type, radius, stroke and shadow in the palette and mode the
 * person already has, and a chip shows that palette's real background and accent in the style they already have.
 */
import { type KeyboardEvent, useId, useRef } from 'react';
import { ChoiceCards, revealChoice } from '../compose/choice-cards.tsx';
import { SettingSwitch } from '../compose/setting-row.tsx';
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

/**
 * A tiny scene drawn in a style, so two close styles differ at a glance: a display "Ag" (the display face, weight and
 * tracking), a body word (the body face) and a label (the label face, case and tracking) on top; a button (radius,
 * stroke, press shadow) and a card (radius, stroke, shadow, and the style's own blur over a colour blob) below.
 * Only the faces the style's own tokens name are drawn: no mini asks for a file a style card did not already load.
 */
function StyleMini({ look }: { readonly look: Look }) {
  return (
    <span className="fy-ap-mini" {...lookAttributes(look)}>
      <span className="fy-ap-mini__top">
        <b className="fy-ap-mini__type">Ag</b>
        <span className="fy-ap-mini__text">
          <span className="fy-ap-mini__body">Quick fox</span>
          <em className="fy-ap-mini__label">Label</em>
        </span>
      </span>
      <span className="fy-ap-mini__bottom">
        <i className="fy-ap-mini__button" />
        <i className="fy-ap-mini__card" />
      </span>
    </span>
  );
}

/**
 * The palette a style card is drawn in: the one a pick GIVES. That is the style's own default palette, unless the person
 * kept their colours ("Don't change my colours when I change style"), when a pick leaves the palette alone and the card
 * therefore shows the palette they have.
 */
export function cardPalette(style: StyleEntry, current: PaletteId, keepPalette: boolean): PaletteId {
  return keepPalette ? current : style.defaultPalette;
}

export function StylePicker({
  styles,
  value,
  palette,
  keepPalette = false,
  mode,
  onChange,
}: {
  readonly styles: readonly StyleEntry[];
  readonly value: StyleId;
  /** The palette in force: what a card wears when colours are kept. */
  readonly palette: PaletteId;
  /** The device flag: a pick leaves the palette alone, so a card wears the palette in force. Off when left out. */
  readonly keepPalette?: boolean;
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
        demo: <StyleMini look={{ style: style.id, palette: cardPalette(style, palette, keepPalette), mode }} />,
      }))}
    />
  );
}

/** "Don't change my colours when I change style": the one flag under the style grid. */
export function KeepPaletteSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (keep: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="fy-ap-keep" data-keep-palette="">
      <SettingSwitch checked={checked} onChange={onChange} labelledBy={`${id}-name`} describedBy={`${id}-hint`} />
      <span className="fy-ap-keep__text">
        <span id={`${id}-name`} className="fy-ap-keep__name">
          Don't change my colours when I change style
        </span>
        <span id={`${id}-hint`} className="fy-ap-keep__hint">
          {checked ? 'A new style keeps your palette.' : 'A new style brings its own palette. You can change it after.'}
        </span>
      </span>
    </div>
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
    revealChoice(ref.current?.querySelector<HTMLInputElement>(`input[value="${target.id}"]`));
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
