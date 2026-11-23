/**
 * The picture beside the Voice page (decorative, aria-hidden; the cards and the test carry the words). TWO parts, one pick:
 *
 *   TOP     a sound wave that turns into text: the bars speak, settle to a line, and the words arrive: as you speak for an
 *           engine with live words, or all at once after Stop for the rest. Off draws a flat line and says so.
 *   BOTTOM  the picked engine's spec as a small radar chart: Speed, Accuracy, Light (a small download) and Live words, each
 *           the same measure the card's bars draw (`engine-numbers.ts`), so a bigger shape is a better engine. The browser's
 *           own voice has no measurements and draws an empty frame that says so.
 *
 * The wave loops while the page is open. With motion off, by the OS or by Settings, it is one still frame: wave and words.
 * The page re-keys it on a new pick so the radar redraws for the engine now chosen.
 */
import { MicOff } from 'lucide-react';
import { ON_DEVICE_MODELS, type OnDeviceModel } from '../../lib/stt/model-catalog.ts';
import { type EngineBar, engineBars, MIN_BAR } from '../engine-card/engine-numbers.ts';
import type { EngineChoice } from '../engine-card/engine-card-grid.tsx';
import './voice-step.css';

export type VoiceDemoKind = 'live' | 'after' | 'off';

const WORDS = 'Move the deploy to Friday.';
const BARS = 28;

/** How the pick returns words: the browser's own and the streaming engines show them as you speak, the rest after Stop. */
const demoKindOf = (pick: EngineChoice | null): VoiceDemoKind => {
  if (pick === null) return 'after';
  if (pick === 'off') return 'off';
  if (pick === 'browser') return 'live';
  return ON_DEVICE_MODELS.find(model => model.id === pick)?.streaming === true ? 'live' : 'after';
};

/** One bar's resting height (0.25–1): a fixed, uneven pattern so the wave reads as speech and never as a ramp. */
const barHeight = (index: number): number => 0.25 + 0.75 * Math.abs(Math.sin(index * 1.7) * Math.cos(index * 0.6));

/** The wave's bars, fixed: an id each, so the list never reorders. */
const WAVE = Array.from({ length: BARS }, (_, index) => ({ id: `bar-${index}`, index, height: barHeight(index) }));

export interface RadarAxis {
  readonly label: string;
  /** 0–1: how far out the shape reaches on this axis (better is further). */
  readonly value: number;
}

/** The four spokes of a pick's radar, or `null` for a pick with no measurements (the browser's voice, Off, nothing). */
const radarOf = (model: OnDeviceModel | undefined, bars: readonly EngineBar[]): readonly RadarAxis[] | null => {
  if (model === undefined) return null;
  const [speed, accuracy, size] = bars;
  if (speed === undefined || accuracy === undefined || size === undefined) return null;
  return [
    { label: 'Speed', value: speed.value },
    { label: 'Accuracy', value: accuracy.value },
    // A small download is a plus here, so the chart's rule stays "further out is better".
    { label: 'Light', value: Math.max(MIN_BAR, 1 - size.value + MIN_BAR) },
    { label: 'Live words', value: model.streaming ? 1 : 0.2 },
  ];
};

const CENTER = { x: 120, y: 66 } as const;
const RADIUS = 46;
/** Top, right, bottom, left. */
const TOP = { id: 'top', x: 0, y: -1, anchor: 'middle' as const };
const DIRECTIONS = [
  TOP,
  { id: 'right', x: 1, y: 0, anchor: 'start' as const },
  { id: 'bottom', x: 0, y: 1, anchor: 'middle' as const },
  { id: 'left', x: -1, y: 0, anchor: 'end' as const },
];
const directionOf = (axis: number): (typeof DIRECTIONS)[number] => DIRECTIONS[axis] ?? TOP;
const at = (axis: number, reach: number): { x: number; y: number } => {
  const direction = directionOf(axis);
  return { x: CENTER.x + direction.x * RADIUS * reach, y: CENTER.y + direction.y * RADIUS * reach };
};
const pointsOf = (reach: (axis: number) => number): string =>
  DIRECTIONS.map((_, axis) => {
    const point = at(axis, reach(axis));
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');

function Radar({ axes }: { readonly axes: readonly RadarAxis[] | null }) {
  const labels = axes ?? ['Speed', 'Accuracy', 'Light', 'Live words'].map(label => ({ label, value: 0 }));
  return (
    <svg className="fy-wd__radar" viewBox="0 0 240 134" role="presentation" data-radar={axes === null ? 'none' : ''}>
      {[1, 0.66, 0.33].map(ring => (
        <polygon key={ring} className="fy-wd__ring" points={pointsOf(() => ring)} />
      ))}
      {DIRECTIONS.map((direction, axis) => {
        const tip = at(axis, 1);
        return <line key={direction.id} className="fy-wd__spoke" x1={CENTER.x} y1={CENTER.y} x2={tip.x} y2={tip.y} />;
      })}
      {axes === null ? null : (
        <>
          <polygon className="fy-wd__shape" points={pointsOf(axis => axes[axis]?.value ?? 0)} />
          {axes.map((axis, index) => {
            const point = at(index, axis.value);
            return <circle key={axis.label} className="fy-wd__vertex" cx={point.x} cy={point.y} r={2.6} />;
          })}
        </>
      )}
      {labels.map((axis, index) => {
        const direction = directionOf(index);
        const tip = at(index, 1);
        const gap = direction.y === 0 ? 7 : 0;
        return (
          <text
            key={axis.label}
            className="fy-wd__axis"
            textAnchor={direction.anchor}
            x={tip.x + direction.x * gap}
            y={tip.y + direction.y * 13 + (direction.y === 0 ? 4 : direction.y < 0 ? -1 : 0)}
          >
            {axis.label.split(' ')[0]}
            {axis.label.includes(' ') ? (
              <tspan className="fy-wd__more">{` ${axis.label.split(' ').slice(1).join(' ')}`}</tspan>
            ) : null}
          </text>
        );
      })}
    </svg>
  );
}

const caption = (bars: readonly EngineBar[]): string => bars.map(bar => `${bar.label} ${bar.text}`).join(' · ');

export function VoiceDemo({ pick }: { readonly pick: EngineChoice | null }) {
  const kind = demoKindOf(pick);
  const model = ON_DEVICE_MODELS.find(entry => entry.id === pick);
  const bars = model === undefined ? [] : engineBars(model);
  const axes = radarOf(model, bars);
  return (
    <div className="fy-wd" data-voice-demo={kind} key={pick ?? 'none'} aria-hidden="true">
      <div className="fy-wd__speech" data-part="wave-to-text">
        <div className="fy-wd__wave">
          {kind === 'off' ? (
            <MicOff size={20} className="fy-wd__muted-mic" />
          ) : (
            WAVE.map(bar => (
              <span
                key={bar.id}
                className="fy-wd__bar"
                style={{ ['--h' as string]: bar.height.toFixed(2), ['--i' as string]: bar.index }}
              />
            ))
          )}
        </div>
        <span className="fy-wd__arrow" />
        <p className="fy-wd__text">{kind === 'off' ? 'No microphone button' : WORDS}</p>
      </div>
      <div className="fy-wd__spec" data-part="radar">
        <Radar axes={axes} />
        <p className="fy-wd__caption">
          {model !== undefined
            ? `${model.shortName}: ${caption(bars)}`
            : pick === 'browser'
              ? 'The browser’s own voice has no numbers.'
              : pick === 'off'
                ? 'Nothing to measure.'
                : 'Pick an engine to see its numbers.'}
        </p>
      </div>
    </div>
  );
}
