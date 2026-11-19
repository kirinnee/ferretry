/**
 * Settings › Dictation › Cleanup style: what hosted clean-up (Groq, Cerebras) does to a take, as PROMPTS
 * the owner can edit, stored in the machine's `voice.yaml` so they follow the machine, not this browser.
 *
 * Whatever the prompt says, the daemon wraps it in a fixed guard it cannot remove: only the dictated
 * text is corrected, never answered, and the conversation is read-only reference. This screen says so
 * where the prompt is edited, because an editable prompt reads like total control and is not.
 *
 * No autofocus, 44 px targets. A prompt is saved with its own button — never per keystroke, since every
 * save rewrites a file on the machine.
 */

import { useState } from 'react';
import { useKeptDraft } from '../../hooks/use-kept-draft.ts';
import { ChoiceCards, cn, SettingGroup, SettingRow, SettingSwitch } from '../../shell-voice.ts';
import type { DaemonConnection } from '../../shell-voice.ts';
import {
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  type EditableCleanupStyle,
  MAX_CONVERSATION_MESSAGES,
  MAX_VOICE_PROMPT_CHARS,
  promptFor,
  type VoiceCleanupPatch,
} from '../../lib/stt/voice-cleanup.ts';
import { Textarea } from '../../shell-voice.ts';
import { ChangedElsewhereNote } from './changed-elsewhere.tsx';
import './voice-settings.css';
import {
  type MachineVoiceCleanup,
  useMachineVoiceCleanup,
  type VoiceCleanupSave,
} from './use-machine-voice-cleanup.ts';

const CLEANUP_STYLES = [
  { id: 'off', label: 'Off', hint: 'Nothing is sent for clean-up.' },
  { id: 'fix', label: 'Fix mistakes only', hint: 'Transcription errors, punctuation and casing. Your wording stays.' },
  { id: 'polish', label: 'Polish', hint: 'Rewritten into clear, well-formed sentences with the same meaning.' },
] as const;

export const CLEANUP_GUARD_EXPLANATION =
  'Always on, whatever the prompt says: only the text you dictated is corrected. It is never answered, nothing from the conversation is added to it or merged into it, and if the reply drifts from what you said your raw words are kept instead.';

export const CONVERSATION_CONTEXT_EXPLANATION =
  'Sends the latest messages of this conversation to the provider as read-only reference, so names and terms are spelled the way the conversation spells them. They are never added to your dictation.';

export const CLEANUP_OFF_EXPLANATION =
  'Hosted clean-up is off: dictation is inserted as transcribed and nothing is sent.';

/** A prompt is saved trimmed, so a trailing newline the machine dropped is not an edit still open. */
const samePrompt = (a: string, b: string): boolean => a.trim() === b.trim();

/**
 * How many messages to include, typed as a draft and saved when the field is left or Enter is pressed —
 * never per keystroke: typing "12" used to save "1", disable the field under the cursor and lose the "2".
 */
function MessageCountField({ saved, onSave }: { readonly saved: number; onSave(patch: VoiceCleanupPatch): void }) {
  const count = useKeptDraft(String(saved));
  const commit = (): void => {
    const next = Number(count.value);
    if (!count.dirty) return;
    if (Number.isInteger(next) && next >= 1 && next <= MAX_CONVERSATION_MESSAGES)
      onSave({ conversationMessages: next });
    else count.reload();
  };
  return (
    <SettingRow
      name="Latest messages to include"
      hint="How much of the conversation to send"
      control={labelId => (
        <input
          id="stt-cleanup-messages"
          aria-labelledby={labelId}
          className="kt-input fy-vs-num"
          type="number"
          min={1}
          max={MAX_CONVERSATION_MESSAGES}
          value={count.value}
          data-voice-cleanup-messages=""
          onChange={event => count.set(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit();
          }}
        />
      )}
    >
      {count.changedElsewhere ? (
        <div className="fy-vs-body">
          <ChangedElsewhereNote field="voice-messages" onReload={count.reload} />
        </div>
      ) : null}
    </SettingRow>
  );
}

function PromptEditor({
  style,
  saved,
  busy,
  onSave,
}: {
  readonly style: EditableCleanupStyle;
  readonly saved: string;
  readonly busy: boolean;
  onSave(patch: VoiceCleanupPatch): void;
}) {
  // Kept while edited, never re-mounted from the saved prompt: a re-read (the first one, or another
  // device's save) used to land mid-sentence and replace what was being typed.
  const prompt = useKeptDraft(saved, samePrompt);
  const draft = prompt.value;
  const fallback = DEFAULT_VOICE_CLEANUP_PROMPTS[style];
  const edited = saved !== fallback;
  const id = `stt-cleanup-prompt-${style}`;
  return (
    <li className="fy-vs-body" data-setting-row="Prompt">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-ui font-semibold">
          Prompt
        </label>
        {edited && (
          <span className="rounded-control border border-border-strong px-2 text-meta text-muted">Edited</span>
        )}
      </div>
      <Textarea
        id={id}
        className="min-h-[44px] w-full max-w-[44rem]"
        rows={5}
        spellCheck
        maxLength={MAX_VOICE_PROMPT_CHARS}
        value={draft}
        onChange={event => prompt.set(event.target.value)}
      />
      {prompt.changedElsewhere ? (
        <ChangedElsewhereNote field={`voice-prompt-${style}`} onReload={prompt.reload} />
      ) : null}
      <div className="fy-vs-field">
        <button
          type="button"
          disabled={busy || draft.trim() === saved || draft.trim() === ''}
          onClick={() => onSave({ prompts: { [style]: draft } })}
          className="min-h-[44px] rounded-control border border-accent bg-accent-soft px-control-x text-ui font-semibold text-accent disabled:border-border disabled:bg-surface-2 disabled:text-muted disabled:opacity-60"
        >
          Save prompt
        </button>
        <button
          type="button"
          disabled={busy || (!edited && draft === fallback)}
          onClick={() => {
            prompt.set(fallback);
            if (edited) onSave({ prompts: { [style]: null } });
          }}
          className="min-h-[44px] rounded-control border border-border-strong bg-surface-2 px-control-x text-ui text-fg disabled:text-muted disabled:opacity-60"
        >
          Reset to default
        </button>
      </div>
    </li>
  );
}

function VoiceCleanupView({ state }: { readonly state: MachineVoiceCleanup }) {
  const { cleanup, save } = state;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VoiceCleanupSave | null>(null);
  const commit = (patch: VoiceCleanupPatch): void => {
    setBusy(true);
    void save(patch).then(result => {
      setOutcome(result);
      setBusy(false);
    });
  };
  const style = cleanup.style;
  return (
    <div data-voice-cleanup="">
      <SettingGroup label="Clean-up style">
        <li className="fy-vs-body" data-setting-row="Clean-up style">
          <p className="fy-vs-note">
            Prompts are saved on this machine (<code>voice.yaml</code>) and shared by every device paired to it.
          </p>
          <ChoiceCards
            label="Cleanup style"
            value={style}
            disabled={busy}
            onChange={id => commit({ style: id as typeof style })}
            options={CLEANUP_STYLES.map(option => ({ id: option.id, title: option.label, line: option.hint }))}
          />
        </li>
        {style === 'off' ? (
          <li className="fy-vs-body">
            <p className="fy-vs-note">{CLEANUP_OFF_EXPLANATION}</p>
          </li>
        ) : (
          <>
            <PromptEditor key={style} style={style} saved={promptFor(cleanup, style)} busy={busy} onSave={commit} />
            <SettingRow
              name="Always on, whatever the prompt says"
              hint="Only your dictated text is corrected"
              explanation={CLEANUP_GUARD_EXPLANATION}
            />
          </>
        )}
      </SettingGroup>
      <SettingGroup label="Conversation context">
        <SettingRow
          name="Use the conversation for context"
          hint="Spell names the way the conversation does"
          explanation={CONVERSATION_CONTEXT_EXPLANATION}
          control={labelId => (
            <SettingSwitch
              checked={cleanup.useConversation}
              disabled={busy}
              labelledBy={labelId}
              onChange={next => commit({ useConversation: next })}
            />
          )}
        />
        {cleanup.useConversation && <MessageCountField saved={cleanup.conversationMessages} onSave={commit} />}
      </SettingGroup>
      {outcome !== null && outcome.kind !== 'applied' && (
        <p
          role="status"
          className={cn('text-meta leading-base', outcome.kind === 'refused' ? 'text-err' : 'text-warn')}
        >
          {outcome.message}
        </p>
      )}
    </div>
  );
}

function ConnectedVoiceCleanup({ daemon }: { readonly daemon: DaemonConnection | undefined }) {
  const state = useMachineVoiceCleanup(daemon);
  return daemon === undefined ? null : <VoiceCleanupView state={state} />;
}

/** The section: an injected state (tests, harness) or the machine's own, read through the app's client pool. */
export function VoiceCleanupSettings({
  daemon,
  state,
}: {
  readonly daemon?: DaemonConnection | undefined;
  readonly state?: MachineVoiceCleanup | undefined;
}) {
  return state === undefined ? <ConnectedVoiceCleanup daemon={daemon} /> : <VoiceCleanupView state={state} />;
}
