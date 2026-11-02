/**
 * The New machine setup steps' bodies (spec R4; build plan P9). Each one REUSES the surface that owns
 * its subject in Settings, so a step and its "Set up later" panel can never disagree:
 *
 * - **Pair** — this device is already paired (the screen is only reachable through a pairing); a
 *   phone can be paired too, with Settings › Devices's own surface.
 * - **Start from** — fresh, or Copy settings from another machine (`clone.tsx`), embedded in the step with no
 *   stepper of its own.
 * - **Claude Code**, **Codex** — one screen each that detects, imports, signs in and names the runtime
 *   (`harness-step.tsx`).
 * - **Speed-ups** — Settings › Speed-ups (`speedups-surface.tsx`): paste → Test → "set ✓".
 * - **Voice** — Settings › Dictation's engine choice (Parakeet, with its download size and optional install,
 *   or phone/browser voice), saved as the MACHINE's default in `voice.yaml`; clean-up is this device's.
 * - **Warden** — Settings › Warden's card, with Jev switched on only when a Jev key was added.
 * - **Learning** — the passive-learning default for new ferrets.
 * - **Agent controls** — the Machine tab's own controls and default runtime sections.
 */

import {
  LearningConfigSchema,
  type SpeedupsView,
  type VoiceEngine,
  type WardenConfig,
  type WardenConfigPatch,
  type WardenConfigView,
  WardenConfigViewSchema,
} from '@ferretry/protocol';
import { QrCode } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useLayoutMode } from '../../../hooks/use-layout-mode.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { useParakeetVoice } from '../../../lib/store.tsx';
import { type BrowserRecognitionSupport, browserRecognitionProvider } from '../../../lib/stt/browser-recognition.ts';
import type { ParakeetVoice } from '../../../lib/stt/parakeet-voice.ts';
import type { SttSettings, SttSettingsPatch } from '../../../lib/stt/stt-settings.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readConfigFile, writeConfigFile } from '../../config-files/config-files-api.ts';
import type { PairingClientFactory } from '../../settings/add-device-settings.tsx';
import { PairPhoneSheet } from '../../settings/pair-phone.tsx';
import { VoiceEngineChoice } from '../../settings/voice-engine-choice.tsx';
import { readSpeedups } from '../../speedups/speedups-api.ts';
import { SpeedupsSurface } from '../../speedups/speedups-surface.tsx';
import { jevKeyStatus, WardenConfigCard } from '../../warden/warden-config-card.tsx';
import { wardenConfigPatchFrom } from '../../warden/warden-settings-model.ts';
import { AgentControlSection, DefaultRuntimeSection } from '../machine/settings-tab.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { CloneMachine } from './clone.tsx';
import type { MachineSetupStart, OnboardingDoneRow } from './onboarding-model.ts';
import { wardenStartingDraft } from './onboarding-model.ts';
import { useSetupAccess } from './setup-access.ts';
import { RadioChoices, SetupNote, SetupSection } from './setup-ui.tsx';
import { machineVoiceEngine, VOICE_FILE, withMachineVoiceEngine } from './voice-default.ts';

/** One step's lead sentence, the same size on every step. */
function Lead({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 text-cell leading-base text-fg">{children}</p>;
}

// ── Pair ─────────────────────────────────────────────────────────────────────────────────────────

export function OnboardingPairStep({
  connection,
  machineName,
  createPairingClient,
}: Pick<MachineTabProps, 'connection' | 'machineName'> & { readonly createPairingClient?: PairingClientFactory }) {
  const [open, setOpen] = useState(false);
  const phone = useLayoutMode() === 'drawer';
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="pair">
      <SetupNote tone="ok" name="paired" title={`This device is paired with ${machineName}`}>
        <span>
          Pairing is always first and always direct: it can never be relayed, so this device has already met{' '}
          {machineName} on its own network.
        </span>
      </SetupNote>
      <SetupSection title="Another device" name="pair-another">
        <p className="m-0 text-cell leading-base text-muted">
          Pair a phone now, or later from Settings › Devices. A pairing code is single-use and lasts two minutes.
        </p>
        <div>
          <Button type="button" data-onboarding-pair-phone="" onClick={() => setOpen(true)}>
            <QrCode size={16} aria-hidden="true" />
            Pair a phone too
          </Button>
        </div>
      </SetupSection>
      <PairPhoneSheet
        connection={connection}
        machineName={machineName}
        open={open}
        presentation={phone ? 'sheet' : 'dialog'}
        onClose={() => setOpen(false)}
        {...(createPairingClient === undefined ? {} : { createClient: createPairingClient })}
      />
    </div>
  );
}

// ── Start from ───────────────────────────────────────────────────────────────────────────────────

export function OnboardingStartStep({
  start,
  onStart,
  sources,
  tab,
  onCloned,
  onCopied,
}: {
  readonly start: MachineSetupStart;
  readonly onStart: (start: MachineSetupStart) => void;
  /** Every OTHER machine this browser has paired. */
  readonly sources: readonly DaemonConnectionRecord[];
  readonly tab: MachineTabProps;
  /** The copy finished: the step is set and setup continues. */
  readonly onCloned: () => void;
  /** The copy ran, from this machine. */
  readonly onCopied: (source: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="start">
      <RadioChoices
        legend="Start from"
        legendHidden
        name="onboarding-start"
        value={start}
        onChoose={onStart}
        options={[
          { id: 'fresh', title: 'A fresh setup', detail: 'Walk through each step.' },
          {
            id: 'clone',
            title: 'Clone settings from another machine',
            detail:
              'Copy the Warden, learning, voice, agent controls, profiles and runtimes. Secrets and login tokens are never copied.',
          },
        ]}
      />
      {start === 'clone' ? (
        <CloneMachine
          {...tab}
          sources={sources}
          doneLabel="Continue setup"
          presentation="embedded"
          onDone={onCloned}
          onCopied={onCopied}
          onLeave={() => onStart('fresh')}
        />
      ) : null}
    </div>
  );
}

// ── Speed-ups ────────────────────────────────────────────────────────────────────────────────────

export function OnboardingSpeedupsStep({ tab }: { readonly tab: MachineTabProps }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="speedups">
      <Lead>
        Recommended, and optional. Without these keys Ferretry takes the slower path and says so: the Warden
        investigates every flag, and dictation clean-up stays on this device or off.
      </Lead>
      <SpeedupsSurface connection={tab.connection} createClient={tab.createClient} />
      <p className="m-0 text-meta leading-base text-muted">
        Keys go to {tab.machineName}’s secret store: used, never read back. After storing you only see “set ✓”.
      </p>
    </div>
  );
}

// ── Voice ────────────────────────────────────────────────────────────────────────────────────────

/** This device's dictation settings, as much of them as the Voice step changes. */
export interface VoiceCleanupPort {
  readonly settings: SttSettings;
  readonly update: (patch: SttSettingsPatch) => void;
}

export function OnboardingVoiceStep({
  tab,
  cleanup,
  voice,
  browserSupport,
}: {
  readonly tab: MachineTabProps;
  /** This device's clean-up choice; without it the step points at Settings › Dictation. */
  readonly cleanup?: VoiceCleanupPort;
  /** Parakeet on this device; the app's own unless a test or the harness hands one in. */
  readonly voice?: ParakeetVoice | null;
  /** Whether the phone/browser engine works on this page; production reads the page. */
  readonly browserSupport?: BrowserRecognitionSupport;
}) {
  const { connection, createClient, machineName } = tab;
  const contextVoice = useParakeetVoice();
  const parakeet = voice === undefined ? contextVoice : voice;
  const detected = useMemo(() => browserRecognitionProvider().support, []);
  const support = browserSupport ?? detected;
  /** The machine default as `voice.yaml` names it: `undefined` while reading. */
  const [engine, setEngine] = useState<VoiceEngine | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(async client => machineVoiceEngine((await readConfigFile(client, VOICE_FILE)).text))
      .then(
        found => {
          if (live) setEngine(found);
        },
        (cause: unknown) => {
          if (live) {
            setEngine(null);
            setProblem(changeRefusalSentence(cause));
          }
        },
      );
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  /** Write the default into voice.yaml against what is there now, keeping the rest of the file. */
  const choose = (next: VoiceEngine): void => {
    setProblem(null);
    setEngine(next);
    void (async () => {
      try {
        const client = await createClient(connection);
        const file = await readConfigFile(client, VOICE_FILE);
        await writeConfigFile(client, VOICE_FILE, withMachineVoiceEngine(file.text, next), file.etag);
      } catch (cause) {
        setProblem(changeRefusalSentence(cause));
      }
    })();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="voice">
      <SetupSection title="Speech to text" name="voice-engine">
        <p className="m-0 text-cell leading-base text-muted">
          The default for every device paired to {machineName}: a device uses it until you pick another engine on that
          device in Settings › Dictation. Speech always turns into text on the device itself. The download is optional —
          skip it and choose later.
        </p>
        {engine === undefined ? (
          <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="voice">
            Reading {machineName}’s voice settings…
          </p>
        ) : (
          <VoiceEngineChoice value={engine} onChange={choose} voice={parakeet} browserSupport={support} />
        )}
        {problem === null ? null : (
          <p role="alert" className="m-0 text-ui text-err" data-onboarding-voice-problem="">
            {problem}
          </p>
        )}
      </SetupSection>
      <SetupSection title="Clean-up of the transcript" name="voice-cleanup">
        <p className="m-0 text-cell leading-base text-muted">
          Optional: punctuation, filler words, formatting. Only the transcript text is sent, only when you dictate, and
          never in the background. Groq and Cerebras need their key from Speed-ups.
        </p>
        {cleanup === undefined ? (
          <p className="m-0 text-cell text-muted" data-onboarding-voice-cleanup="settings">
            Choose it on each device in Settings › Behaviour › Dictation.
          </p>
        ) : (
          <RadioChoices
            legend="Clean-up"
            legendHidden
            name="voice-cleanup"
            value={cleanup.settings.enhancementProvider}
            onChoose={enhancementProvider => cleanup.update({ enhancementProvider })}
            options={[
              {
                id: 'local',
                title: 'On this device only',
                detail: 'Word fixes from your dictionary. Nothing is sent.',
              },
              { id: 'groq', title: 'Groq', detail: 'A fast, cheap model cleans up the text. Fractions of a cent.' },
              { id: 'cerebras', title: 'Cerebras', detail: 'The alternative fast post-processor.' },
            ]}
          />
        )}
      </SetupSection>
    </div>
  );
}

// ── Warden ───────────────────────────────────────────────────────────────────────────────────────

interface WardenLoaded {
  readonly view: WardenConfigView;
  readonly draft: WardenConfig;
  readonly speedups: SpeedupsView | null;
}

/**
 * Settings › Warden's card on this step. It opens on {@link wardenStartingDraft} — Jev switched on when a
 * Jev key is set and the machine is still on the free default — and nothing changes until Save.
 */
export function OnboardingWardenStep({
  tab,
  onSaved,
}: {
  readonly tab: MachineTabProps;
  readonly onSaved: () => void;
}) {
  const { connection, createClient } = tab;
  const [loaded, setLoaded] = useState<WardenLoaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const client = await createClient(connection);
        const [view, speedups] = await Promise.all([
          client.request('/v1/warden/config', WardenConfigViewSchema),
          readSpeedups(client).catch(() => null),
        ]);
        const jev = jevKeyStatus(speedups).state === 'set';
        if (live) setLoaded({ view, draft: wardenStartingDraft(view.config, jev), speedups });
      } catch (cause) {
        if (live) setFailure(changeRefusalSentence(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const save = async (state: WardenLoaded, patch: WardenConfigPatch): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const client = await createClient(connection);
      const view = await client.request('/v1/warden/config', WardenConfigViewSchema, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setLoaded({ ...state, view, draft: view.config });
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(changeRefusalSentence(cause));
    } finally {
      setSaving(false);
    }
  };

  if (failure !== null)
    return (
      <SetupNote live tone="warn" name="warden-unavailable" title="Couldn’t read the Warden’s settings">
        <span>{failure} Skip this step and set it up later in Settings › Warden.</span>
      </SetupNote>
    );
  if (loaded === null)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="warden">
        Reading the Warden’s settings…
      </p>
    );
  const dirty = Object.keys(wardenConfigPatchFrom(loaded.view.config, loaded.draft)).length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="warden">
      <Lead>The Warden watches your ferrets and flags the stuck ones. {jevLead(loaded)}</Lead>
      <WardenConfigCard
        view={loaded.view}
        draft={loaded.draft}
        onChange={draft => {
          setLoaded({ ...loaded, draft });
          setSaved(false);
        }}
        jevKey={jevKeyStatus(loaded.speedups)}
        saving={saving}
        error={error}
        saved={saved}
        onSave={patch => void save(loaded, patch)}
      />
      {dirty ? (
        <p className="m-0 text-meta text-muted" data-onboarding-warden-unsaved="">
          Not saved yet. Save puts these in effect; Continue without saving keeps the machine as it is.
        </p>
      ) : null}
    </div>
  );
}

const jevLead = (loaded: WardenLoaded): string =>
  jevKeyStatus(loaded.speedups).state === 'set'
    ? 'A Jev key is set, so Jev is switched on: it clears healthy flags for fractions of a cent and shows you the rest.'
    : 'Without a Jev key the safe default is rules only: flags are shown to you, and nothing is spent.';

// ── Learning ─────────────────────────────────────────────────────────────────────────────────────

export function OnboardingLearningStep({
  tab,
  onSaved,
}: {
  readonly tab: MachineTabProps;
  readonly onSaved: () => void;
}) {
  const { connection, createClient } = tab;
  const [passive, setPassive] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(async client => await client.request('/v1/learning/config', LearningConfigSchema))
      .then(
        config => {
          if (live) setPassive(config.passiveDefault);
        },
        (cause: unknown) => {
          if (live) setProblem(changeRefusalSentence(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const choose = (passiveDefault: boolean): void => {
    setSaving(true);
    setProblem(null);
    void createClient(connection)
      .then(
        async client =>
          await client.request('/v1/learning/config', LearningConfigSchema, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passiveDefault }),
          }),
      )
      .then(
        config => {
          setPassive(config.passiveDefault);
          onSaved();
        },
        (cause: unknown) => setProblem(changeRefusalSentence(cause)),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="learning">
      <Lead>
        Passive learning instructs NEW ferrets to file a lesson when you correct them (
        <span className="font-mono">fy lesson suggest "…" --scope global|repo</span>). You review every lesson in the
        Learning hub; nothing is applied on its own.
      </Lead>
      {passive === null && problem === null ? (
        <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="learning">
          Reading the learning default…
        </p>
      ) : passive === null ? null : (
        <RadioChoices
          legend="Passive learning for new ferrets"
          legendHidden
          name="onboarding-passive"
          value={passive ? 'on' : 'off'}
          onChoose={value => {
            if (!saving) choose(value === 'on');
          }}
          options={[
            { id: 'on', title: 'On', detail: 'New ferrets are taught to suggest lessons.' },
            { id: 'off', title: 'Off', detail: 'New ferrets are not taught; you can still scan for lessons later.' },
          ]}
        />
      )}
      {problem === null ? null : (
        <p role="alert" className="m-0 text-ui text-err">
          {problem}
        </p>
      )}
    </div>
  );
}

// ── Agent controls ───────────────────────────────────────────────────────────────────────────────

export function OnboardingControlsStep({ tab }: { readonly tab: MachineTabProps }) {
  const { machine, machineName, connection, createClient, onRetry, checking } = tab;
  const access = useSetupAccess({ connection, createClient });
  if (machine === null)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="controls">
        {checking ? `Checking ${machineName}…` : `${machineName}’s controls show once it answers.`}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-5" data-onboarding-step-body="controls">
      <Lead>What ferrets on {machineName} may control, and the runtime a new ferret uses.</Lead>
      <AgentControlSection
        key={Object.values(machine.agentControl).join(',')}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onRetry}
      />
      <DefaultRuntimeSection
        key={machine.defaultRuntime}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onRetry}
      />
    </div>
  );
}

// ── Done ─────────────────────────────────────────────────────────────────────────────────────────

const DONE_TONE: Readonly<Record<OnboardingDoneRow['state'], 'ok' | 'warn' | 'pend'>> = {
  set: 'ok',
  skipped: 'warn',
  'not visited': 'pend',
};

export function OnboardingDoneStep({
  rows,
  machineName,
  onNavigate,
  createRuntimeHref,
}: {
  readonly rows: readonly OnboardingDoneRow[];
  readonly machineName: string;
  readonly onNavigate: (to: string) => void;
  /** Present only while the machine has no runtime: setup is not finished until one exists. */
  readonly createRuntimeHref?: string;
}) {
  const later = rows.filter(row => row.later !== undefined);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body="done">
      <p className="m-0 text-row font-semibold text-fg">
        {createRuntimeHref !== undefined
          ? `${machineName} has no runtime yet, so nothing can start here.`
          : later.length === 0
            ? `${machineName} is ready.`
            : `${machineName} is ready. ${later.length === 1 ? 'One step is' : `${String(later.length)} steps are`} left for later.`}
      </p>
      {createRuntimeHref === undefined ? null : (
        <a
          href={createRuntimeHref}
          className="kt-btn self-start"
          data-variant="primary"
          data-onboarding-create-runtime=""
          onClick={event => {
            event.preventDefault();
            onNavigate(createRuntimeHref);
          }}
        >
          Create a runtime
        </a>
      )}
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" data-onboarding-summary="">
        {rows.map(row => (
          <li
            key={row.id}
            className="kt-panel flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 p-panel"
            data-onboarding-summary-row={row.id}
            data-state={row.state}
          >
            <span className="kt-badge shrink-0" data-tone={DONE_TONE[row.state]}>
              {row.state}
            </span>
            <span className="min-w-0 flex-1 text-ui font-semibold text-fg">{row.label}</span>
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
            {row.detail === undefined ? null : (
              // Its own line: on a phone a sentence beside the label is a column one word wide.
              <span className="basis-full [overflow-wrap:anywhere] text-meta text-muted">{row.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
