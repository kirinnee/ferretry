/**
 * WHICH VOICE READS THE REPLY — a button that shows the voice in use and opens a list of rows
 * (Settings › Voice › Read replies aloud; `docs/voice.md` › Auto-read replies).
 *
 * It is not a native `<select>` because a closed select shows ONE line and cuts what does not fit, and the
 * words that matter most here are the voice's name and WHO GETS THE TEXT ("Google US English" / "Sends text to
 * Google"). Here the name is one line and the vendor is the next, both wrap instead of being cut at an edge,
 * and every row is at least 44 px tall (48 px on a phone). A voice that sends text away is also marked by an
 * icon and bold words, never by colour alone. The rows are radios, so the arrow keys, Space and a screen reader
 * work without any code of ours.
 */

import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { SpeakerVoice } from '../../lib/voice-chat/ports.ts';
import { voiceLabel, voiceWhere } from '../../lib/voice-chat/voice-choice.ts';

export interface VoicePickerProps {
  readonly voices: readonly SpeakerVoice[];
  /** The voice in use, or null for "best voice for this device". */
  readonly chosen: SpeakerVoice | null;
  readonly onChoose: (voiceId: string | null) => void;
  /** Open on arrival (a harness shows the list this way). */
  readonly defaultOpen?: boolean;
}

function Where({ voice }: { readonly voice: SpeakerVoice }) {
  const remote = !voice.local;
  return (
    <span className="fy-ar-voice-where" {...(remote ? { 'data-remote': '' } : {})}>
      {remote ? <TriangleAlert aria-hidden="true" size={16} /> : null}
      <span>{voiceWhere(voice)}</span>
    </span>
  );
}

export function VoicePicker({ voices, chosen, onChoose, defaultOpen = false }: VoicePickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const groupName = useId();
  const local = voices.filter(voice => voice.local);
  const remote = voices.filter(voice => !voice.local);
  return (
    <div className="flex flex-col gap-2">
      <button
        aria-controls={listId}
        aria-expanded={open}
        aria-labelledby="auto-read-voice-label auto-read-voice-now"
        className="fy-ar-picker-trigger fy-ar-target"
        id="auto-read-voice"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="fy-ar-voice" id="auto-read-voice-now">
          <span className="fy-ar-voice-name">{chosen === null ? 'Best voice for this device' : chosen.name}</span>
          {chosen === null ? (
            <span className="fy-ar-voice-where">Picks a voice that speaks on this device</span>
          ) : (
            <Where voice={chosen} />
          )}
        </span>
        <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : ''} size={20} />
      </button>
      {open ? (
        <div aria-labelledby="auto-read-voice-label" className="fy-ar-list" id={listId} role="radiogroup">
          <VoiceRow
            checked={chosen === null}
            groupName={groupName}
            onChoose={() => onChoose(null)}
            title="Best voice for this device"
          >
            <span className="fy-ar-voice-name">Best voice for this device</span>
            <span className="fy-ar-voice-where">Picks a voice that speaks on this device</span>
          </VoiceRow>
          {[
            { title: 'On this device', list: local },
            { title: 'Sends text away', list: remote },
          ].map(group =>
            group.list.length === 0 ? null : (
              <fieldset className="m-0 min-w-0 border-0 p-0" key={group.title}>
                <legend className="fy-ar-group-title w-full">{group.title}</legend>
                {group.list.map(voice => (
                  <VoiceRow
                    checked={chosen?.id === voice.id}
                    groupName={groupName}
                    key={voice.id}
                    onChoose={() => onChoose(voice.id)}
                    title={`${voiceLabel(voice)} — ${voice.lang}`}
                  >
                    <span className="fy-ar-voice-name">
                      {voice.name} <span className="font-normal text-muted">· {voice.lang}</span>
                    </span>
                    <Where voice={voice} />
                  </VoiceRow>
                ))}
              </fieldset>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function VoiceRow({
  checked,
  groupName,
  onChoose,
  title,
  children,
}: {
  readonly checked: boolean;
  readonly groupName: string;
  readonly onChoose: () => void;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="fy-ar-row fy-ar-target" {...(checked ? { 'data-selected': '' } : {})}>
      <input
        aria-label={title}
        checked={checked}
        className="sr-only"
        name={groupName}
        onChange={onChoose}
        type="radio"
      />
      <span className="fy-ar-voice">{children}</span>
      {checked ? (
        <span className="fy-ar-selected">
          <Check aria-hidden="true" className="inline" size={16} /> Selected
        </span>
      ) : null}
    </label>
  );
}
