/**
 * ONE ENGINE, ONE SHORT CARD — the choice Settings › Voice and the first-run "How should this device hear you?" page
 * both draw (fixes the owner's "voice options TOO much … hard to look across all": hide most info, fixed length, a simple
 * system as bars).
 *
 * WHAT IS ON THE CARD, and nothing else: the name, one plain line, three bars (Speed / Accuracy / Size, `engine-numbers.ts`),
 * two chips, and — for an engine that downloads — one small Install button. The measured paragraph, licence and languages
 * sit behind the "i" disclosure, which covers the card in place so the card never changes height. The card is a fixed
 * 132 px tall (`engine-card.css`), however long the name.
 *
 * THE SELECTION IS THE WHOLE CARD. A real radio input is stretched over the card (`.fy-engine-radio`), so the group is
 * one tab stop, the arrow keys move the choice, and a click anywhere on the card chooses it. The Install and "i" buttons
 * sit above that input, so pressing them never changes the choice, and no interactive control is nested inside a label.
 * The check badge pops once when the card is chosen (`data-pop`), and not at all when motion is reduced.
 *
 * NO AUTOFOCUS (this app's touch rules). The small buttons keep a 44 px hit area through an extended touch target.
 */

import { Check, Download, Info, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { EngineBars } from './engine-bars.tsx';
import { barsText, type EngineBar } from './engine-numbers.ts';
import './engine-card.css';

/** What the install slot shows. `none` draws no slot (the browser's own voice and Off have nothing to download). */
export type InstallView =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'idle'; readonly size: string; onInstall(): void }
  | { readonly kind: 'partial'; readonly left: string; onInstall(): void }
  | { readonly kind: 'installing'; readonly percent: number; readonly size: string; onCancel(): void }
  | { readonly kind: 'installed' };

export interface EngineCardProps {
  /** The engine id; also the radio's value and the card's `data-engine`. */
  readonly id: string;
  readonly name: string;
  /** The one line under the name. */
  readonly line: string;
  /** Three bars, or `null` for a card with nothing to compare (Off). */
  readonly bars: readonly EngineBar[] | null;
  readonly chips: readonly string[];
  /** The paragraphs behind the "i" disclosure. */
  readonly details: readonly string[];
  readonly selected: boolean;
  /** True on the one card the person just chose, so its pop plays once and a first paint does not animate. */
  readonly justChosen: boolean;
  /** The radio group's name. */
  readonly group: string;
  onChoose(id: string): void;
  readonly install: InstallView;
  /** A small mark on the card ("Recommended"). */
  readonly badge?: string;
  /** The last install failure, said in place of the line (the card never grows). */
  readonly error?: string;
  /** A card that cannot work here: it is drawn, and says why in its install slot, but cannot be chosen. */
  readonly disabled?: boolean;
}

function InstallSlot({ install, name }: { readonly install: InstallView; readonly name: string }) {
  switch (install.kind) {
    case 'none':
      return null;
    case 'unavailable':
      return (
        <span className="fy-engine-state" data-state="unavailable" title={install.reason}>
          Not available here
        </span>
      );
    case 'checking':
      return (
        <span className="fy-engine-state" data-state="checking">
          Checking…
        </span>
      );
    case 'installed':
      return (
        <span className="fy-engine-state" data-state="installed">
          <Check size={12} aria-hidden="true" /> Installed
        </span>
      );
    case 'installing':
      return (
        <span className="fy-engine-progress" data-state="installing">
          <span
            className="fy-engine-progress-track"
            role="progressbar"
            aria-label={`Downloading ${name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={install.percent}
            aria-valuetext={`${install.percent}% of ${install.size}`}
          >
            <span className="fy-engine-progress-fill" style={{ width: `${install.percent}%` }} />
          </span>
          <span className="fy-engine-progress-text">{install.percent}%</span>
          <button
            type="button"
            className="fy-engine-mini fy-engine-hit"
            aria-label={`Cancel the ${name} download`}
            onClick={install.onCancel}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      );
    case 'partial':
      return (
        <button type="button" className="fy-engine-mini fy-engine-hit" data-state="partial" onClick={install.onInstall}>
          <Download size={12} aria-hidden="true" /> Resume ({install.left})
        </button>
      );
    case 'idle':
      return (
        <button
          type="button"
          className="fy-engine-mini fy-engine-hit"
          data-state="idle"
          aria-label={`Install ${name} (${install.size})`}
          onClick={install.onInstall}
        >
          <Download size={12} aria-hidden="true" /> Install ({install.size})
        </button>
      );
  }
}

export function EngineCard({
  id,
  name,
  line,
  bars,
  chips,
  details,
  selected,
  justChosen,
  group,
  onChoose,
  install,
  badge,
  error,
  disabled = false,
}: EngineCardProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const infoRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) return undefined;
    // Escape closes the long text, and only that: it is the one thing open.
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  useEffect(() => {
    // Closing the disclosure hands the focus back to the "i" that opened it.
    if (wasOpen.current && !open) infoRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const describedBy = useId();
  const description = bars === null ? line : `${line} ${barsText(bars)}`;

  return (
    <div
      className="fy-engine-card"
      data-engine={id}
      data-selected={selected ? 'true' : 'false'}
      data-pop={justChosen ? 'true' : 'false'}
    >
      <input
        type="radio"
        className="fy-engine-radio"
        name={group}
        value={id}
        checked={selected}
        disabled={disabled}
        aria-label={name}
        aria-describedby={describedBy}
        onChange={() => onChoose(id)}
      />
      <span id={describedBy} hidden>
        {description}
      </span>
      <div className="fy-engine-body">
        <div className="fy-engine-head">
          <span className="fy-engine-check" aria-hidden="true">
            <Check size={10} strokeWidth={3} />
          </span>
          <span className="fy-engine-name">{name}</span>
          {badge === undefined ? null : <span className="fy-engine-badge">{badge}</span>}
        </div>
        {error === undefined ? (
          <p className="fy-engine-line">{line}</p>
        ) : (
          <p className="fy-engine-line fy-engine-line-error" role="alert" title={error}>
            {error}
          </p>
        )}
        {bars === null ? <p className="fy-engine-none">{details[0]}</p> : <EngineBars bars={bars} />}
        <div className="fy-engine-foot">
          <span className="fy-engine-chips">
            {chips.map(chip => (
              <span key={chip} className="fy-engine-chip">
                {chip}
              </span>
            ))}
          </span>
          <InstallSlot install={install} name={name} />
        </div>
      </div>
      <button
        ref={infoRef}
        type="button"
        className="fy-engine-info fy-engine-hit"
        aria-label={`About ${name}`}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(current => !current)}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open ? (
        <section id={detailsId} className="fy-engine-details" aria-label={`About ${name}`}>
          {details.map(paragraph => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <button type="button" className="fy-engine-mini" onClick={() => setOpen(false)}>
            Close
          </button>
        </section>
      ) : null}
    </div>
  );
}
