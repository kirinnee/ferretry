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
import {
  ChoiceCards,
  cn,
  Segmented,
  SettingGroup,
  SettingRow,
  SettingSaveBar,
  SettingSwitch,
} from '../../shell-voice.ts';
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
  'Whatever the prompt says, only the text you dictated is corrected. It is never answered, nothing from the conversation is added to it or merged into it, and if the reply drifts from what you said your raw words are kept instead.';

export const CONVERSATION_CONTEXT_EXPLANATION =
  'Sends the latest messages of this conversation to the provider as read-only reference, so names and terms are spelled the way the conversation spells them. They are never added to your dictation.';

/** Shown before Apply, so choosing a hosted style is never also the act of sending text to a provider. */
export const CLEANUP_HOSTED_ON_EXPLANATION =
  'Applying this turns hosted clean-up ON for every device paired to this machine: after each dictation the text you dictated (and, if conversation context is on, the latest messages) is sent to the provider you chose under Dictation › Correction provider. Text that has been sent cannot be unsent.';

const CLEANUP_STYLE_STAGED_EXPLANATION = 'Not saved yet: nothing changes on this machine until you press Apply.';

export const CLEANUP_OFF_EXPLANATION =
  'Hosted clean-up is off: dictation is inserted as transcribed and nothing is sent.';

/** A prompt is saved trimmed, so a trailing newline the machine dropped is not an edit still open. */
const samePrompt = (a: string, b: string): boolean => a.trim() === b.trim();

/** The counts offered; a count the machine already holds (any whole number up to the limit) is shown too, never hidden. */
const MESSAGE_COUNTS = [1, 2, 3, 5, MAX_CONVERSATION_MESSAGES] as const;

/**
 * How many messages to include: a CHOICE, so it saves at once like the switch above it (never typed into a box that saves on blur).
 */
function MessageCountField({
  saved,
  busy,
  onSave,
}: {
  readonly saved: number;
  readonly busy: boolean;
  onSave(patch: VoiceCleanupPatch): void;
}) {
  const counts = [...new Set<number>([...MESSAGE_COUNTS, saved])].sort((a, b) => a - b);
  return (
    <SettingRow
      name="Latest messages to include"
      hint="How much of the conversation to send"
      wide
      control={() => (
        <Segmented
          label="Latest messages to include"
          value={String(saved)}
          disabled={busy}
          options={counts.map(count => ({ id: String(count), label: String(count) }))}
          onChange={next => onSave({ conversationMessages: Number(next) })}
        />
      )}
    />
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
  // The prompt is a VALUE, so it is a form of its own: one Save bar says what state it is in; Reset to default is an action beside it.
  return (
    <SettingGroup
      label="Clean-up prompt"
      saves="on-save"
      foot={
        <SettingSaveBar
          dirty={draft.trim() !== saved}
          saving={busy}
          blocked={draft.trim() === ''}
          saveLabel="Save prompt"
          discardLabel="Undo edits"
          onSave={() => onSave({ prompts: { [style]: draft } })}
          onDiscard={() => prompt.reload()}
        >
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
        </SettingSaveBar>
      }
    >
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
      </li>
      <li className="fy-vs-body" data-cleanup-guard="">
        <p className="fy-vs-note">{CLEANUP_GUARD_EXPLANATION}</p>
      </li>
    </SettingGroup>
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
  // The choice is STAGED: the cards' arrow keys move AND select, so a write per selection would let a stray key
  // press turn hosted clean-up on for every device. Only an explicit Apply writes.
  const [staged, setStaged] = useState<typeof style | null>(null);
  const pending = staged !== null && staged !== style ? staged : null;
  const applyStyle = (next: typeof style): void => {
    setBusy(true);
    void save({ style: next }).then(result => {
      setOutcome(result);
      setBusy(false);
      if (result.kind === 'applied') setStaged(null);
    });
  };
  return (
    <div data-voice-cleanup="">
      <SettingGroup
        label="Clean-up style"
        saves="on-save"
        foot={
          // A style is staged (a stray arrow key must never turn hosted clean-up on), so it is saved by a Save bar like a value.
          <SettingSaveBar
            dirty={pending !== null}
            saving={busy}
            saveLabel="Apply"
            discardLabel="Cancel"
            marks={pending === null ? {} : { 'data-cleanup-staged': '' }}
            onSave={() => {
              if (pending !== null) applyStyle(pending);
            }}
            onDiscard={() => setStaged(null)}
          />
        }
      >
        <li className="fy-vs-body" data-setting-row="Clean-up style">
          <p className="fy-vs-note">
            Prompts are saved on this machine (<code>voice.yaml</code>) and shared by every device paired to it.
          </p>
          <ChoiceCards
            label="Cleanup style"
            value={pending ?? style}
            disabled={busy}
            onChange={id => setStaged(id as typeof style)}
            options={CLEANUP_STYLES.map(option => ({ id: option.id, title: option.label, line: option.hint }))}
          />
          {pending !== null && (
            <p className="fy-vs-note" role="status" data-cleanup-staged-note="">
              {CLEANUP_STYLE_STAGED_EXPLANATION}{' '}
              {style === 'off' && pending !== 'off' ? CLEANUP_HOSTED_ON_EXPLANATION : null}
            </p>
          )}
        </li>
        {style === 'off' ? (
          <li className="fy-vs-body">
            <p className="fy-vs-note">{CLEANUP_OFF_EXPLANATION}</p>
          </li>
        ) : null}
      </SettingGroup>
      {style === 'off' ? null : (
        <PromptEditor key={style} style={style} saved={promptFor(cleanup, style)} busy={busy} onSave={commit} />
      )}
      <SettingGroup label="Conversation context" saves="now">
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
        {cleanup.useConversation && (
          <MessageCountField saved={cleanup.conversationMessages} busy={busy} onSave={commit} />
        )}
      </SettingGroup>
      {outcome !== null && outcome.kind !== 'applied' && (
        <p
          role="status"
          data-cleanup-outcome=""
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
