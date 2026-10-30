import type { SessionContext } from '@ferretry/protocol';
import { contextReadout } from '../lib/context-ring.ts';

/**
 * HOW FULL THE CONTEXT WINDOW IS, as a ring about the size of a letter.
 *
 * The arc is filled to the share of the window the transcript last said was used; amber from 70% and red
 * from 90% (theme tokens, never a literal colour), and the tone is also in the words — the title and the
 * accessible name read `118k of 1M tokens (12%)`, so nothing rests on a colour. While the harness is
 * compacting, the ring spins instead of reporting a size that is about to be wrong (motion-gated in CSS).
 *
 * It is a button when the host gives it somewhere to go (Info › Usage), and a plain readout otherwise.
 */

export interface ContextRingProps {
  readonly context: SessionContext;
  readonly compacting?: boolean;
  readonly onOpen?: () => void;
}

const SIZE = 14;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const COMPACTING_FILL = 25;

export function ContextRing({ context, compacting = false, onOpen }: ContextRingProps) {
  const readout = contextReadout(context);
  const text = compacting ? 'Compacting context…' : readout.text;
  const fill = compacting ? COMPACTING_FILL : readout.fill;
  const ring = (
    <svg aria-hidden="true" focusable="false" height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE}>
      <circle
        className="fy-context-ring__track"
        cx={SIZE / 2}
        cy={SIZE / 2}
        fill="none"
        r={RADIUS}
        strokeWidth={STROKE}
      />
      <circle
        className="fy-context-ring__fill"
        cx={SIZE / 2}
        cy={SIZE / 2}
        fill="none"
        r={RADIUS}
        strokeDasharray={`${(CIRCUMFERENCE * fill) / 100} ${CIRCUMFERENCE}`}
        strokeWidth={STROKE}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
  const common = {
    className: 'fy-context-ring',
    'data-compacting': compacting ? '' : undefined,
    'data-context-ring': '',
    'data-tone': readout.tone,
    title: text,
  };
  return onOpen === undefined ? (
    <span {...common} aria-label={text} role="img">
      {ring}
    </span>
  ) : (
    <button {...common} aria-label={`${text}. Open usage`} onClick={onOpen} type="button">
      {ring}
    </button>
  );
}
