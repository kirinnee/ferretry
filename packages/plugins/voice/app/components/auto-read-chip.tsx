import { Square, Volume2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useReadAloudController } from '../hooks/use-read-aloud.ts';
import { IDLE } from '../lib/voice-chat/read-aloud.ts';

/**
 * "READING ALOUD" WHILE A REPLY IS READ ON ITS OWN (F137 slice 2; `docs/voice.md` › Auto-read replies).
 *
 * A reply the person did not ask for by pressing a button needs one obvious thing on screen that says
 * what is happening and how to stop it: icon AND words, a 44 px Stop, and the way to stop said in words
 * ("tap anywhere or press a key"), because the microphone is off while it reads. A polite live region
 * says only "Reading the reply" — never the reply, which the voice already says. Nothing shows when
 * nothing is being read.
 */
export function AutoReadChip({ reading, onStop }: { readonly reading: boolean; readonly onStop: () => void }) {
  const controller = useReadAloudController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => IDLE);
  if (!reading) return <span aria-live="polite" className="sr-only" role="status" />;
  return (
    <div className="fy-auto-read" data-auto-read="">
      <Volume2 aria-hidden="true" className="fy-auto-read-icon" size={18} />
      <div className="fy-auto-read-words">
        <span className="fy-auto-read-title">Reading the reply</span>
        <span className="fy-auto-read-hint">Tap anywhere or press a key to stop.</span>
        {state.voiceNote !== null ? <span className="fy-auto-read-hint">{state.voiceNote}</span> : null}
      </div>
      <button className="fy-read-aloud-button" onClick={onStop} type="button">
        <Square aria-hidden="true" size={15} />
        <span>Stop</span>
      </button>
      <span aria-live="polite" className="sr-only" role="status">
        Reading the reply
      </span>
    </div>
  );
}
