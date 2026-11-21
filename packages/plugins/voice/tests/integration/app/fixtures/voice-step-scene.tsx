/**
 * The two first-run Voice pages over fake data, drawn the way the setup flow draws a page: inside the shared
 * `StepPageFrame`, with a host whose `commit` the footer's Next runs (contract rule 8). No daemon, no network, no real model,
 * no microphone: every voice is a fake whose install state this file sets, the settings store is a local object and the
 * speed-up key vault is the REAL `DeviceSpeedupKeys` over an in-memory record map (so a sealed key really is sealed).
 * What reached the "device" is recorded on `window.__fake` (never a key's text).
 *
 *   ?view=voice|speedups
 *   ?saved=none|browser|off   what this device already holds for the Voice page (none: nothing chosen yet)
 *   ?save=fail                the first commit is refused (the writer throws)
 *   ?save=denied              storage denies every write: like the real store, the change applies for this tab and
 *                             `persisted` reads false afterwards
 *   ?save=denied-once         storage denies the first write only
 *   ?phone=1                  the device is a phone (the short list's first card follows the device class)
 *   ?theme=<family>-<mode>
 */
import { StepPageFrame } from '@ferretry/app';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StepHost } from '@ferretry/kernel/contract';
import { SpeedupsStep } from '../../../../app/features/onboarding/speedups-step.tsx';
import { VoiceStep } from '../../../../app/features/onboarding/voice-step.tsx';
import type { DeviceClass } from '../../../../app/lib/stt/engine-defaults.ts';
import { modelDownloadBytes, ON_DEVICE_MODELS } from '../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelInstallOptions, ModelStoreStatus } from '../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../app/lib/stt/on-device-voices.ts';
import { DeviceSpeedupKeys, type SpeedupKeyRecords } from '../../../../app/lib/stt/speedup-keys.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings, type SttSettingsPatch } from '../../../../app/lib/stt/stt-settings.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'voice';
const saved = params.get('saved') ?? 'none';
let refuse = params.get('save') === 'fail';
const deny = params.get('save') === 'denied' ? Number.POSITIVE_INFINITY : params.get('save') === 'denied-once' ? 1 : 0;
let writeCount = 0;
let kept = true;
const deviceClass: DeviceClass = params.get('phone') === '1' ? 'phone' : 'computer';

interface Fake {
  /** Every patch the page asked the device settings to save. */
  writes: SttSettingsPatch[];
  commits: number;
  done: number;
  skipped: string[];
  busy: (string | null)[];
  /** Writes of a sealed key into the in-memory vault (the slot name and the byte length, never the key). */
  keyPuts: { slot: string; sealed: boolean }[];
  advanced: boolean;
}
const fake: Fake = { writes: [], commits: 0, done: 0, skipped: [], busy: [], keyPuts: [], advanced: false };
(window as unknown as { __fake: Fake }).__fake = fake;

class FakeStore implements ModelInstaller {
  readonly totalBytes: number;
  readonly #state: ModelStoreStatus;
  constructor(totalBytes: number, state: ModelStoreStatus) {
    this.totalBytes = totalBytes;
    this.#state = state;
  }
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.#state);
  }
  install(options: ModelInstallOptions = {}): Promise<void> {
    options.onProgress?.({ label: 'Encoder', downloadedBytes: this.totalBytes * 0.42, totalBytes: this.totalBytes });
    return new Promise(() => undefined);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const voices = new OnDeviceVoices(
  ON_DEVICE_MODELS.map(model => {
    const bytes = modelDownloadBytes(model);
    const installed = model.id === 'sherpa-zipformer-en';
    const status: ModelStoreStatus = installed
      ? { state: 'installed', version: 'fake', bytes, installedAt: '2026-10-22T00:00:00.000Z' }
      : { state: 'absent' };
    return new OnDeviceVoice({
      model,
      support: { available: true },
      store: new FakeStore(bytes, status),
      openSession: () => {
        throw new Error('no microphone in a shot');
      },
    });
  }),
);
await voices.refresh();

const initial: SttSettings =
  saved === 'browser'
    ? { ...DEFAULT_STT_SETTINGS, engine: 'browser' }
    : saved === 'off'
      ? { ...DEFAULT_STT_SETTINGS, enabled: false, engine: 'browser' }
      : view === 'speedups'
        ? { ...DEFAULT_STT_SETTINGS, engine: 'sherpa-zipformer-en' }
        : DEFAULT_STT_SETTINGS;

const memory = new Map<string, unknown>();
const records: SpeedupKeyRecords = {
  get: slot => Promise.resolve(memory.get(slot)),
  put: (slot, value) => {
    fake.keyPuts.push({ slot, sealed: !(typeof value === 'string') });
    memory.set(slot, value);
    return Promise.resolve();
  },
  delete: slot => {
    memory.delete(slot);
    return Promise.resolve();
  },
};
const keys = new DeviceSpeedupKeys(records, globalThis.crypto.subtle, () => {
  throw new Error('no network in a shot');
});

function Host() {
  const save = useRef<(() => Promise<void>) | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const [settings, setSettings] = useState<SttSettings>(initial);
  const hostRef = useRef<StepHost | null>(null);
  hostRef.current ??= {
    phase: 'client',
    appliesTo: [],
    segment: {},
    remember: () => undefined,
    ready: () => setReady(true),
    skip: why => void fake.skipped.push(why),
    notNeeded: () => undefined,
    commit: next => {
      save.current = next;
      fake.commits += 1;
    },
    done: () => {
      fake.done += 1;
    },
    busy: label => void fake.busy.push(label),
    next: () => undefined,
    back: () => undefined,
  };
  const press = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    new Promise<void>(resolve => resolve(save.current === null ? undefined : save.current()))
      .then(
        () => {
          fake.advanced = true;
          setMoved(true);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : 'That could not be saved.'),
      )
      .finally(() => setBusy(false));
  };
  if (moved) return <main data-next-page="">The next page</main>;
  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <StepPageFrame
        title={view === 'speedups' ? 'Speed-ups' : 'Voice'}
        back={{ onClick: () => undefined }}
        next={{ label: 'Next', disabled: !ready, busy, onClick: press }}
        {...(error === null
          ? {}
          : {
              note: (
                <p role="alert" data-flow-commit-error="">
                  {error}
                </p>
              ),
            })}
      >
        {view === 'speedups' ? (
          <SpeedupsStep settings={settings} step={hostRef.current} keys={keys} />
        ) : (
          <VoiceStep
            settings={settings}
            update={patch => {
              if (refuse) {
                refuse = false;
                throw new Error('This device refused the write.');
              }
              fake.writes.push(patch);
              writeCount += 1;
              kept = writeCount > deny;
              setSettings(previous => ({ ...previous, ...patch }));
            }}
            persisted={() => kept}
            voices={voices}
            browserSupport={{ available: true, availability: 'available', implementation: 'standard' }}
            deviceClass={deviceClass}
            step={hostRef.current}
          />
        )}
      </StepPageFrame>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Host />);
