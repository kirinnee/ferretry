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
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  type EditableCleanupStyle,
  MAX_CONVERSATION_MESSAGES,
  MAX_VOICE_PROMPT_CHARS,
  promptFor,
  type VoiceCleanupPatch,
} from '../../lib/stt/voice-cleanup.ts';
import { Textarea } from '../../shell/primitives.tsx';
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

const SWITCH_CLASS =
  'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors';

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
  const [draft, setDraft] = useState(saved);
  const fallback = DEFAULT_VOICE_CLEANUP_PROMPTS[style];
  const edited = saved !== fallback;
  const id = `stt-cleanup-prompt-${style}`;
  return (
    <div className="flex flex-col gap-2">
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
        className="min-h-[44px]"
        rows={5}
        spellCheck
        maxLength={MAX_VOICE_PROMPT_CHARS}
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || draft.trim() === saved || draft.trim() === ''}
          onClick={() => onSave({ prompts: { [style]: draft } })}
          className="min-h-[44px] rounded-control border border-accent bg-accent-soft px-control-x text-ui font-semibold text-accent disabled:opacity-50"
        >
          Save prompt
        </button>
        <button
          type="button"
          disabled={busy || (!edited && draft === fallback)}
          onClick={() => {
            setDraft(fallback);
            if (edited) onSave({ prompts: { [style]: null } });
          }}
          className="min-h-[44px] rounded-control border border-border-strong bg-surface-2 px-control-x text-ui text-fg disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>
    </div>
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
    <div className="flex flex-col gap-3" data-voice-cleanup="">
      <h3 className="m-0 text-ui font-semibold">Cleanup style</h3>
      <p className="text-meta leading-base text-muted">
        Prompts are saved on this machine (<code>voice.yaml</code>) and shared by every device paired to it.
      </p>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Cleanup style</legend>
        {CLEANUP_STYLES.map(option => (
          <label
            key={option.id}
            className={cn(
              'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border px-control-x py-2',
              style === option.id ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2',
            )}
          >
            <input
              type="radio"
              name="stt-cleanup-style"
              className="mt-1"
              checked={style === option.id}
              disabled={busy}
              onChange={() => commit({ style: option.id })}
            />
            <span className="flex flex-col">
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-base text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {style === 'off' ? (
        <p className="text-meta leading-base text-muted">{CLEANUP_OFF_EXPLANATION}</p>
      ) : (
        <PromptEditor
          key={`${style}:${promptFor(cleanup, style)}`}
          style={style}
          saved={promptFor(cleanup, style)}
          busy={busy}
          onSave={commit}
        />
      )}
      <p className="text-meta leading-base text-muted">{CLEANUP_GUARD_EXPLANATION}</p>

      <button
        type="button"
        role="switch"
        aria-checked={cleanup.useConversation}
        disabled={busy}
        onClick={() => commit({ useConversation: !cleanup.useConversation })}
        className={cn(
          SWITCH_CLASS,
          cleanup.useConversation
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border-strong bg-surface-2 text-fg',
        )}
      >
        <span className="text-ui font-semibold">Use the conversation for context</span>
        <span className="text-meta">{cleanup.useConversation ? 'On' : 'Off'}</span>
      </button>
      <p className="text-meta leading-base text-muted">{CONVERSATION_CONTEXT_EXPLANATION}</p>
      {cleanup.useConversation && (
        <div className="flex items-center gap-3">
          <label htmlFor="stt-cleanup-messages" className="text-ui font-semibold">
            Latest messages to include
          </label>
          <input
            id="stt-cleanup-messages"
            className="kt-input min-h-[44px] w-20"
            type="number"
            min={1}
            max={MAX_CONVERSATION_MESSAGES}
            value={cleanup.conversationMessages}
            disabled={busy}
            onChange={event => {
              const count = Number(event.target.value);
              if (Number.isFinite(count) && count >= 1) commit({ conversationMessages: count });
            }}
          />
        </div>
      )}
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
