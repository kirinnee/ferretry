/**
 * A small CSS scene for the Voice page: a microphone, a spoken line, and how the picked engine hands the words back —
 * live as you speak, after you stop, or not at all (Off). It plays ONCE when the pick changes (the page re-keys it) and rests on
 * its last frame; with motion off, by the OS or by Settings, it is only the last frame. Decorative: the cards carry the words.
 */
import { Mic, MicOff } from 'lucide-react';
import { ON_DEVICE_MODELS } from '../../lib/stt/model-catalog.ts';
import type { EngineChoice } from '../engine-card/engine-card-grid.tsx';
import './voice-step.css';

export type VoiceDemoKind = 'live' | 'after' | 'off';

const WORDS = ['Move', 'the', 'deploy', 'to', 'Friday.'] as const;

/** How the pick returns words: the browser's own and the streaming engines show them as you speak, the rest after Stop. */
const demoKindOf = (pick: EngineChoice | null): VoiceDemoKind => {
  if (pick === null) return 'after';
  if (pick === 'off') return 'off';
  if (pick === 'browser') return 'live';
  return ON_DEVICE_MODELS.find(model => model.id === pick)?.streaming === true ? 'live' : 'after';
};

export function VoiceDemo({ pick }: { readonly pick: EngineChoice | null }) {
  const kind = demoKindOf(pick);
  return (
    <div className="fy-vd" data-voice-demo={kind} key={pick ?? 'none'} aria-hidden="true">
      <span className="fy-vd__mic">{kind === 'off' ? <MicOff size={20} /> : <Mic size={20} />}</span>
      {kind === 'off' ? (
        <span className="fy-vd__off">No microphone button</span>
      ) : (
        <span className="fy-vd__words">
          {WORDS.map((word, index) => (
            <span key={word} className="fy-vd__word" style={{ ['--i' as string]: index }}>
              {word}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
