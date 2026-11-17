/**
 * OPTION B — "The missing slot": playful, bold, motion-led.
 *
 * The Fleet Grid logomark has ONE slot deliberately empty ("the report that never arrived"). This page makes that the
 * story: the empty slot is THIS device, waiting. Pairing drops it into place, the grid ripples outward from it, a ring
 * pulses off the hub and a little confetti of the same rounded squares pops. It reuses the brand geometry exactly (the
 * 4-unit grid, the round hub); it does not invent a mark. Heavy type, a hard offset shadow and a full-bleed accent
 * panel give it the loud, toy-like register.
 */
import type { CSSProperties } from 'react';
import { Actions, CheckBadge, FAKE, Lockup, MachineCard, NameField, type OptionProps } from './shared.tsx';

/** The brand's seven filled cells, with how far each is from the empty slot (drives the ripple delay). */
const CELLS = [
  { x: 4, y: 4, ring: 2 },
  { x: 24, y: 4, ring: 1 },
  { x: 44, y: 4, ring: 0 },
  { x: 4, y: 24, ring: 3 },
  { x: 4, y: 44, ring: 2 },
  { x: 24, y: 44, ring: 1 },
  { x: 44, y: 44, ring: 0 },
] as const;

const CONFETTI = [
  { x: 26, y: -22, r: 40, s: 5 },
  { x: 38, y: -4, r: -30, s: 4 },
  { x: 30, y: 24, r: 70, s: 5 },
  { x: 10, y: -34, r: 15, s: 3 },
  { x: 12, y: 38, r: -50, s: 4 },
  { x: 44, y: -26, r: 90, s: 3 },
  { x: 46, y: 14, r: 20, s: 3 },
  { x: -6, y: -40, r: -70, s: 3 },
] as const;

function Grid({ stage }: { readonly stage: OptionProps['stage'] }) {
  return (
    <svg className="p3b-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false" data-stage={stage}>
      <g className="p3b-cells">
        {CELLS.map(cell => (
          <rect
            key={`${cell.x}:${cell.y}`}
            className="p3b-cell"
            x={cell.x}
            y={cell.y}
            width="16"
            height="16"
            rx="4"
            style={{ '--ring': cell.ring } as CSSProperties}
          />
        ))}
      </g>
      <circle className="p3b-hub-ring" cx="32" cy="32" r="8" />
      <circle className="p3b-hub" cx="32" cy="32" r="8" />
      <circle className="p3b-hub-dot" cx="32" cy="32" r="3" />

      {/* The empty slot — this device, waiting. */}
      <g className="p3b-slot">
        <rect x="44.75" y="24.75" width="14.5" height="14.5" rx="3.4" />
        <path d="M52 29.5 V34.5 M49.5 32 H54.5" />
      </g>

      {/* The device arriving into it. */}
      <g className="p3b-arrival">
        <rect className="p3b-arrival-cell" x="44" y="24" width="16" height="16" rx="4" />
        <path className="p3b-arrival-check" d="M48.2 32.4 L51.2 35.4 L56 29.2" />
      </g>

      <circle className="p3b-shock" cx="52" cy="32" r="9" />
      <g className="p3b-confetti">
        {CONFETTI.map(piece => (
          <rect
            key={`${piece.x}:${piece.y}`}
            className="p3b-bit"
            x={-piece.s / 2}
            y={-piece.s / 2}
            width={piece.s}
            height={piece.s}
            rx="1"
            style={
              {
                '--dx': `${piece.x}px`,
                '--dy': `${piece.y}px`,
                '--rot': `${piece.r}deg`,
              } as CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}

export function OptionB({ stage, onPair, onCancel, detailsOpen = false }: OptionProps) {
  const done = stage === 'paired';
  return (
    <main className="p3 p3b" data-pairing-stage={stage} aria-labelledby="p3-title">
      <Lockup />
      <div className="p3b-hero">
        <Grid stage={stage} />
      </div>
      <div className="p3b-copy">
        <p className="p3b-eyebrow">
          <span className="p3b-dot" aria-hidden="true" />
          {done ? 'Slot filled' : 'One slot open'}
        </p>
        <h1 id="p3-title" className="p3-title">
          {done ? 'Connected' : 'Pair this device?'}
        </h1>
        {done ? (
          <p className="p3-sub">
            <CheckBadge size={16} /> Paired with <strong>{FAKE.machine}</strong>.
          </p>
        ) : (
          <p className="p3-sub">Join the fleet. It takes one tap.</p>
        )}
      </div>
      {done ? null : (
        <>
          <MachineCard startOpen={detailsOpen} />
          <NameField busy={stage === 'pairing'} />
          <Actions stage={stage} onPair={onPair} onCancel={onCancel} />
        </>
      )}
    </main>
  );
}
