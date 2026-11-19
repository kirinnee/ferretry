/**
 * THE SPECIMEN: one panel that shows every detail of the look in force, so a person sees what a choice does instead of
 * reading about it. It draws with the real shared classes (`kt-btn`, `kt-input`) and the same tokens the app reads, so
 * it can never drift from the app:
 *
 *   type · buttons at rest / hover / press · an input with its real focus ring · a panel and its shadow ·
 *   radius and border widths · spacing rulers · a toggle and a selected tile · a list row at both densities
 *
 * It follows the page's own look by default; give it `look` and `scoped` to render a look of its own (a screenshot, the
 * matrix test). Picking anything replays it ONCE: the press, the toggle and the tile pop play when the look changes,
 * never on mount and never with motion off. Hover and press cannot be forced on a real button, so those two are drawn
 * from the same tokens the button's `:hover` and `:active` rules read (`appearance-specimen.css`).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/primitives.tsx';
import { useMotionAllowed } from '../ui/use-motion-allowed.ts';
import { type Look, lookAttributes } from './appearance-pickers.tsx';
import './appearance-specimen.css';

export interface AppearanceSpecimenProps {
  /** The look this specimen shows. It decides when the specimen replays; with `scoped` it is also what is drawn. */
  readonly look: Look & { readonly textScale?: string };
  /** Draw `look` itself rather than whatever the page is in. */
  readonly scoped?: boolean;
}

/** The weights a style sets, by token, so a style that has no medium weight shows that it has none. */
const WEIGHTS: readonly { readonly name: string; readonly token: string }[] = [
  { name: 'Normal', token: 'var(--weight-normal)' },
  { name: 'Medium', token: 'var(--weight-medium)' },
  { name: 'Strong', token: 'var(--weight-strong)' },
  { name: 'Display', token: 'var(--weight-display)' },
];

/** The spacing tokens as rulers: a bar as wide as the token. */
const RULERS: readonly { readonly name: string; readonly token: string }[] = [
  { name: 'Control padding', token: 'var(--pad-control-x)' },
  { name: 'Panel padding', token: 'var(--pad-panel)' },
  { name: 'Gap', token: 'var(--gap-md)' },
  { name: 'Flow', token: 'var(--flow-4)' },
];

/** How many times the look has changed since this specimen mounted (0 = never: nothing plays). */
function useReplay(key: string): number {
  const [count, setCount] = useState(0);
  const motion = useMotionAllowed();
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    if (motion) setCount(value => value + 1);
  }, [key, motion]);
  return count;
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="fy-spec__section" data-spec-section={title}>
      <h4 className="fy-spec__title">{title}</h4>
      {children}
    </section>
  );
}

export function AppearanceSpecimen({ look, scoped = false }: AppearanceSpecimenProps) {
  const replays = useReplay(`${look.style}|${look.palette}|${look.mode}|${look.textScale ?? ''}`);
  const play = replays > 0;
  return (
    <div
      className="fy-spec"
      data-specimen=""
      data-spec-replays={replays}
      data-spec-style={look.style}
      data-spec-palette={look.palette}
      {...(scoped ? lookAttributes(look) : {})}
    >
      <Section title="Type">
        <p className="fy-spec__display">Ferretry</p>
        <p className="fy-spec__body">The quick ferret opens a project.</p>
        <p className="fy-spec__mono">fy run --fast 0123</p>
        <p className="fy-spec__label">Label text</p>
        <ul className="fy-spec__weights" aria-label="Weights">
          {WEIGHTS.map(weight => (
            <li key={weight.name} style={{ fontWeight: weight.token }}>
              {weight.name}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Buttons">
        <div className="fy-spec__row">
          <Button size="sm" data-spec-state="rest">
            Rest
          </Button>
          <Button size="sm" data-spec-state="hover">
            Hover
          </Button>
          {/* A press plays once when the look changes: the same translate and shadow the real :active uses. */}
          <Button
            size="sm"
            data-spec-state="press"
            data-spec-play={play ? replays : undefined}
            key={`press-${replays}`}
          >
            Press
          </Button>
          <Button size="sm" variant="primary">
            Primary
          </Button>
        </div>
      </Section>

      <Section title="Input">
        <input
          className="kt-input fy-spec__input"
          data-spec-state="focus"
          value="Focused field"
          readOnly
          tabIndex={-1}
          aria-label="Specimen focused field"
        />
      </Section>

      <Section title="Panel">
        <div className="fy-spec__card">
          <b>Panel title</b>
          <span>Its border, radius and shadow.</span>
        </div>
      </Section>

      <Section title="Shape">
        <div className="fy-spec__row">
          <i className="fy-spec__shape fy-spec__shape--control" title="Control radius" />
          <i className="fy-spec__shape fy-spec__shape--panel" title="Panel radius" />
          <i className="fy-spec__shape fy-spec__shape--badge" title="Badge radius" />
          <i className="fy-spec__shape fy-spec__shape--heavy" title="Heavy border" />
        </div>
      </Section>

      <Section title="Spacing">
        <ul className="fy-spec__rulers" aria-label="Spacing">
          {RULERS.map(ruler => (
            <li key={ruler.name}>
              <i style={{ width: ruler.token }} />
              <span>{ruler.name}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Select">
        <div className="fy-spec__row">
          <span
            className="fy-spec__toggle"
            data-on="true"
            data-spec-play={play ? replays : undefined}
            key={`toggle-${replays}`}
            aria-hidden="true"
          >
            <i />
          </span>
          <span
            className="fy-spec__tile"
            data-spec-play={play ? replays : undefined}
            key={`tile-${replays}`}
            aria-hidden="true"
          >
            Selected
          </span>
        </div>
      </Section>

      <Section title="Rows">
        <ul className="fy-spec__rows" aria-label="Row density">
          <li className="fy-spec__listrow" data-density="pointer">
            <span>Pointer row</span>
            <em>desktop</em>
          </li>
          <li className="fy-spec__listrow" data-density="touch">
            <span>Touch row</span>
            <em>44px floor</em>
          </li>
        </ul>
      </Section>
    </div>
  );
}
