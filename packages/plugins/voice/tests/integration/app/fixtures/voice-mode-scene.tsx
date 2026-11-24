/**
 * Voice mode's settings group (`VoiceModeSettings`) over a fake machine, in the page-wide column a Settings tab gives it.
 * `?theme=<family>-<mode>&state=not_installed|ready|failed`. The fake machine downloads 35 % more on every read once Install
 * is pressed, and records every call on `window.__fake`: no audio and no secret exists in this scene to record.
 */
import { createRoot } from 'react-dom/client';
import { VoiceModeSettings } from '../../../../app/features/settings/voice-mode-settings.tsx';
import { daemonConnection } from '../../../../app/shell-voice.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SIZE = 698_905_830;
const fake = { installs: 0, removes: 0, reads: 0 };
(window as unknown as { __fake: typeof fake }).__fake = fake;
let state = (params.get('state') ?? 'not_installed') as 'not_installed' | 'installing' | 'ready' | 'failed';
let done = state === 'ready' ? SIZE : 0;

const view = () => ({
  state,
  machine: 'Studio Mac',
  label: 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection',
  sizeBytes: SIZE,
  doneBytes: done,
  loaded: false,
  ...(state === 'failed'
    ? {
        failure: {
          code: 'hash_mismatch',
          sentence: 'A downloaded speech file was not the file this version expects, so nothing was kept. Try again.',
        },
      }
    : {}),
  ...(state === 'ready' ? { selfTest: { loadMs: 1865, decodeMs: 650, memoryMb: 819 } } : {}),
});

const client = {
  request: async (_path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
    if (init?.method === 'POST') {
      fake.installs += 1;
      state = 'installing';
      done = 0;
    } else if (init?.method === 'DELETE') {
      fake.removes += 1;
      state = 'not_installed';
      done = 0;
    } else {
      fake.reads += 1;
      if (state === 'installing') {
        done = Math.min(SIZE, done + Math.round(SIZE * 0.35));
        if (done >= SIZE) state = 'ready';
      }
    }
    return schema.parse(view());
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main className="fy-vs" style={{ boxSizing: 'border-box', padding: 16 }}>
      <VoiceModeSettings
        connection={daemonConnection({ daemonId: 'a', baseUrl: 'https://a.example.test', deviceId: 'd' })}
        createClient={async () => client as never}
      />
    </main>,
  );
