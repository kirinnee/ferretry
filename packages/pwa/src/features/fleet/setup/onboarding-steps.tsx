/**
 * The New machine setup steps' bodies (spec R4; build plan P9). Each one REUSES the surface that owns
 * its subject in Settings, so a step and its "Set up later" panel can never disagree:
 *
 * - **Start from** — only when another machine can be copied: two cards that ARE the actions (tap one and
 *   setup moves on). Copying embeds Copy settings from another machine (`clone.tsx`), with no stepper of its own.
 * - **Claude Code**, **Codex** — one screen each that detects, imports, signs in and names the runtime
 *   (`harness-step.tsx`).
 * - **Speed-ups** — one `Save keys` (`speedups-step.tsx`): paste → stored → tested → "set ✓".
 * - **Defaults** — the settings a machine already has, in one list: its voice, learning from corrections, and
 *   what agents may use. `Use these` saves ONLY what changed, each through the save its Settings panel uses.
 * - **Done** — what was made, and the one button that starts using it.
 */

import { type FleetAgentControl, LearningConfigSchema, type VoiceEngine } from '@ferretry/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import { useParakeetInstall } from '../../../hooks/use-parakeet-install.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { useParakeetVoice } from '../../../lib/store.tsx';
import { PARAKEET_DOWNLOAD_SIZE } from '../../../lib/stt/parakeet-model.ts';
import type { ParakeetVoice } from '../../../lib/stt/parakeet-voice.ts';
import { readConfigFile, writeConfigFile } from '../../config-files/config-files-api.ts';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import { machineSettings } from '../machine/machine-settings.ts';
import { AGENT_CONTROL_KINDS, AGENT_CONTROL_WORDS } from '../machine/settings-tab.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { CloneMachine } from './clone.tsx';
import { PrimaryAction } from './footer-slot.tsx';
import type { DefaultVoice, MachineSetupStart, OnboardingDoneRow } from './onboarding-model.ts';
import { useSetupAccess } from './setup-access.ts';
import { machineVoiceEngine, VOICE_FILE, withMachineVoiceEngine, withoutMachineVoiceEngine } from './voice-default.ts';

// ── Start from ───────────────────────────────────────────────────────────────────────────────────

function StartCard({
  name,
  title,
  detail,
  onClick,
}: {
  readonly name: string;
  readonly title: string;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="kt-panel flex min-h-control min-w-0 flex-col gap-0.5 p-panel text-left hover:border-accent"
      data-start-card={name}
      onClick={onClick}
    >
      <span className="text-row font-semibold text-fg">{title} ›</span>
      <span className="text-cell text-muted">{detail}</span>
    </button>
  );
}

export function OnboardingStartStep({
  start,
  onStart,
  sources,
  tab,
  onFresh,
  onCloned,
  onCopied,
}: {
  readonly start: MachineSetupStart;
  readonly onStart: (start: MachineSetupStart) => void;
  /** Every OTHER machine this browser has paired: never empty on this step. */
  readonly sources: readonly DaemonConnectionRecord[];
  readonly tab: MachineTabProps;
  /** "Start fresh": setup moves on. */
  readonly onFresh: () => void;
  /** The copy finished: the step is set and setup continues. */
  readonly onCloned: () => void;
  /** The copy ran, from this machine. */
  readonly onCopied: (source: string) => void;
}) {
  const only = sources.length === 1 ? sources[0] : undefined;
  const copyTitle = only === undefined ? 'Copy another machine' : `Copy ${daemonDisplayName(only)}`;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="start">
      {start === 'clone' ? (
        <CloneMachine
          {...tab}
          sources={sources}
          {...(only === undefined ? {} : { initialSource: only.daemonId })}
          doneLabel="Continue setup"
          presentation="embedded"
          onDone={onCloned}
          onCopied={onCopied}
          onLeave={() => onStart('fresh')}
        />
      ) : (
        <>
          <p className="m-0 text-cell leading-base text-muted">
            You have other machines. Start fresh, or copy one of them.
          </p>
          <StartCard
            name="fresh"
            title="Start fresh"
            detail="Bring in Claude Code and Codex, one tap each."
            onClick={onFresh}
          />
          <StartCard
            name="clone"
            title={copyTitle}
            detail="Its Warden, learning, controls and runtimes. Never secrets or logins."
            onClick={() => onStart('clone')}
          />
        </>
      )}
    </div>
  );
}

// ── Defaults ─────────────────────────────────────────────────────────────────────────────────────

const VOICE_OPTIONS: readonly { readonly id: DefaultVoice; readonly label: string }[] = [
  { id: 'browser', label: 'Browser voice' },
  { id: 'parakeet', label: `Parakeet (${PARAKEET_DOWNLOAD_SIZE}, on device)` },
  { id: 'off', label: 'Off' },
];

const VOICE_DETAIL: Readonly<Record<DefaultVoice, string>> = {
  browser: 'Your browser’s speech recognition. It sends what you say to your browser vendor.',
  parakeet: `Speech turns into text on this device and never leaves it. ${PARAKEET_DOWNLOAD_SIZE} downloads when you use these.`,
  off: 'No default voice. Each device chooses its own in Settings › Dictation.',
};

const voiceOf = (engine: VoiceEngine | null): DefaultVoice => engine ?? 'off';

/** What a row's read left it as: still reading, read, or could not be read (its row is left out of the save). */
type Read<T> =
  | { readonly kind: 'reading' }
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'failed' };

const READING: Read<never> = { kind: 'reading' };

/** One row of the Defaults list: a title, a sentence, and the control. */
function DefaultRow({
  title,
  detail,
  name,
  children,
  inline = false,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly name: string;
  readonly children: ReactNode;
  readonly inline?: boolean;
}) {
  return (
    <div
      className={inline ? 'flex min-w-0 items-center gap-3 p-panel' : 'flex min-w-0 flex-col gap-2 p-panel'}
      data-default-row={name}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-row font-semibold text-fg">{title}</span>
        {detail === undefined ? null : <span className="text-cell text-muted">{detail}</span>}
      </span>
      {children}
    </div>
  );
}

const sameControl = (left: FleetAgentControl, right: FleetAgentControl): boolean =>
  AGENT_CONTROL_KINDS.every(kind => left[kind] === right[kind]);

/**
 * The Defaults page: what this machine already does, in one list. Nothing is written until `Use these`,
 * and then only what differs from what the machine has — voice through its `voice.yaml`, learning through
 * its PATCH, and what agents may use through the same reviewed change as Settings, so turning terminals,
 * browsers or files on from another device still asks for the passkey and a refusal still stops the page.
 * Parakeet downloads only if it was picked.
 */
export function OnboardingDefaultsStep({
  tab,
  voice,
  onFinished,
}: {
  readonly tab: MachineTabProps;
  /** Parakeet on this device; the app's own unless a test or the harness hands one in. */
  readonly voice?: ParakeetVoice | null;
  /** Everything that changed was saved: the page moves on. */
  readonly onFinished: () => void;
}) {
  const { connection, createClient, machine, machineName, checking, onRetry } = tab;
  const access = useSetupAccess({ connection, createClient });
  const { changes } = access;
  const contextVoice = useParakeetVoice();
  const parakeet = voice === undefined ? contextVoice : voice;
  const install = useParakeetInstall(parakeet);

  // What the machine has (`base*`) and what the person has set on this page (the rest).
  const [baseVoice, setBaseVoice] = useState<Read<DefaultVoice>>(READING);
  const [basePassive, setBasePassive] = useState<Read<boolean>>(READING);
  const [pickedVoice, setPickedVoice] = useState<DefaultVoice | null>(null);
  const [pickedPassive, setPickedPassive] = useState<boolean | null>(null);
  const [pickedControl, setPickedControl] = useState<FleetAgentControl | null>(null);
  const [baseControl, setBaseControl] = useState<FleetAgentControl | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void createClient(connection).then(
      async client => {
        const [file, learning] = await Promise.all([
          readConfigFile(client, VOICE_FILE).then(
            (read): Read<DefaultVoice> => ({ kind: 'read', value: voiceOf(machineVoiceEngine(read.text)) }),
            (): Read<DefaultVoice> => ({ kind: 'failed' }),
          ),
          client.request('/v1/learning/config', LearningConfigSchema).then(
            (config): Read<boolean> => ({ kind: 'read', value: config.passiveDefault }),
            (): Read<boolean> => ({ kind: 'failed' }),
          ),
        ]);
        if (!live) return;
        setBaseVoice(file);
        setBasePassive(learning);
      },
      () => {
        if (!live) return;
        setBaseVoice({ kind: 'failed' });
        setBasePassive({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const currentControl = baseControl ?? machine?.agentControl ?? null;
  const control = pickedControl ?? currentControl;
  const voiceNow = baseVoice.kind === 'read' ? (pickedVoice ?? baseVoice.value) : null;
  const passiveNow = basePassive.kind === 'read' ? (pickedPassive ?? basePassive.value) : null;
  const controlChanged = control !== null && currentControl !== null && !sameControl(control, currentControl);
  const voiceChanged = baseVoice.kind === 'read' && voiceNow !== null && voiceNow !== baseVoice.value;
  const passiveChanged = basePassive.kind === 'read' && passiveNow !== null && passiveNow !== basePassive.value;
  const reading = baseVoice.kind === 'reading' || basePassive.kind === 'reading' || (machine === null && checking);

  const save = async (): Promise<void> => {
    setProblem(null);
    setSaving(true);
    try {
      // Agent controls first: it can be refused (or ask for a passkey), and a refusal must stop the page
      // before anything else is written.
      if (controlChanged && machine !== null && control !== null) {
        const result = await changes.apply(machineSettings(machine, { agentControl: control }));
        if (result.kind === 'refused') return;
        setBaseControl(control);
        setPickedControl(null);
        onRetry();
      }
      if (passiveChanged && passiveNow !== null) {
        const client = await createClient(connection);
        const config = await client.request('/v1/learning/config', LearningConfigSchema, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ passiveDefault: passiveNow }),
        });
        setBasePassive({ kind: 'read', value: config.passiveDefault });
        setPickedPassive(null);
      }
      if (voiceChanged && voiceNow !== null) {
        const client = await createClient(connection);
        const file = await readConfigFile(client, VOICE_FILE);
        const next =
          voiceNow === 'off' ? withoutMachineVoiceEngine(file.text) : withMachineVoiceEngine(file.text, voiceNow);
        await writeConfigFile(client, VOICE_FILE, next, file.etag);
        setBaseVoice({ kind: 'read', value: voiceNow });
        setPickedVoice(null);
        // The one download in setup, and only because it was picked. It carries on in this browser while setup moves on.
        if (voiceNow === 'parakeet' && (install.phase === 'absent' || install.phase === 'partial'))
          void parakeet?.install();
      }
      onFinished();
    } catch (cause) {
      setProblem(changeRefusalSentence(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="defaults">
      <p className="m-0 text-cell leading-base text-muted">These are already set. Change any, or keep them.</p>
      <div className="kt-panel flex min-w-0 flex-col divide-y divide-border p-0">
        <DefaultRow
          name="voice"
          title="Voice on this device"
          {...(voiceNow === null ? {} : { detail: VOICE_DETAIL[voiceNow] })}
        >
          {baseVoice.kind === 'reading' ? (
            <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="voice">
              Reading {machineName}’s voice settings…
            </p>
          ) : voiceNow === null ? (
            <p className="m-0 text-cell text-warn" data-default-unread="voice">
              Couldn’t read {machineName}’s voice settings. Choose it in Settings › Dictation.
            </p>
          ) : (
            <select
              aria-label="Voice on this device"
              className="kt-input max-w-[20rem]"
              value={voiceNow}
              disabled={saving}
              onChange={event => setPickedVoice(event.target.value as DefaultVoice)}
            >
              {VOICE_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </DefaultRow>
        <DefaultRow
          name="learning"
          title="Learn from my corrections"
          detail="New ferrets suggest lessons. You review each one."
          inline
        >
          {passiveNow === null ? (
            <span className="text-cell text-muted" data-default-unread="learning">
              {basePassive.kind === 'reading' ? 'Reading…' : 'Unreadable'}
            </span>
          ) : (
            <input
              type="checkbox"
              aria-label="Learn from my corrections"
              className="shrink-0"
              checked={passiveNow}
              disabled={saving}
              onChange={event => setPickedPassive(event.target.checked)}
            />
          )}
        </DefaultRow>
        <DefaultRow name="agents" title="Agents may use">
          {control === null ? (
            <span className="text-cell text-muted" data-default-unread="agents">
              {checking ? `Checking ${machineName}…` : `${machineName}’s controls show once it answers.`}
            </span>
          ) : (
            <span className="flex flex-wrap gap-x-4 gap-y-1 text-cell text-fg" data-agent-control="">
              {AGENT_CONTROL_KINDS.map(kind => (
                <label key={kind} className="flex items-center gap-1.5" data-agent-control-kind={kind}>
                  <input
                    type="checkbox"
                    checked={control[kind]}
                    disabled={saving}
                    onChange={event => {
                      setPickedControl({ ...control, [kind]: event.target.checked });
                      changes.clear();
                    }}
                  />
                  {AGENT_CONTROL_WORDS[kind].title}
                </label>
              ))}
            </span>
          )}
        </DefaultRow>
      </div>
      {controlChanged || changes.refusal !== null ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Use these"
          onSubmit={() => void save()}
          hideSubmit
        />
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="m-0 text-cell text-err" data-onboarding-defaults-problem="">
          {problem}
        </p>
      )}
      <PrimaryAction
        label={saving || changes.busy ? 'Saving…' : 'Use these'}
        disabled={reading || saving || changes.busy}
        onClick={() => void save()}
        name="use-defaults"
      />
    </div>
  );
}

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

export function OnboardingDoneStep({
  rows,
  defaults,
  changeHref,
  onNavigate,
  notes = [],
}: {
  readonly rows: readonly OnboardingDoneRow[];
  /** "Defaults: browser voice, learning on, …": what the machine has now. */
  readonly defaults: string;
  /** Settings, where those defaults are changed. */
  readonly changeHref: string;
  readonly onNavigate: (to: string) => void;
  /** What the imports did, one line each (the conversations result, a sign-in left for later). */
  readonly notes?: readonly string[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="done">
      <ul className="kt-panel m-0 flex min-w-0 list-none flex-col gap-2 p-panel text-cell" data-onboarding-summary="">
        {rows.map(row => (
          <li
            key={row.id}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            data-onboarding-summary-row={row.id}
            data-state={row.set ? 'set' : 'skipped'}
          >
            <span className={row.set ? 'text-fg' : 'text-muted'}>
              {row.set ? '✓' : '–'} {row.text}
            </span>
            {row.later === undefined ? null : (
              <a
                href={row.later}
                className="ml-auto inline-flex min-h-control items-center font-semibold text-accent underline"
                data-onboarding-later={row.id}
                onClick={event => {
                  event.preventDefault();
                  onNavigate(row.later as string);
                }}
              >
                Set up later
              </a>
            )}
          </li>
        ))}
      </ul>
      {notes.length === 0 ? null : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0 text-cell text-muted" data-onboarding-notes="">
          {notes.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <p className="m-0 text-cell leading-base text-muted" data-onboarding-defaults-sentence="">
        {defaults}{' '}
        <a
          href={changeHref}
          className="font-semibold text-accent underline"
          data-onboarding-later="defaults"
          onClick={event => {
            event.preventDefault();
            onNavigate(changeHref);
          }}
        >
          Change in Settings
        </a>
      </p>
    </div>
  );
}
