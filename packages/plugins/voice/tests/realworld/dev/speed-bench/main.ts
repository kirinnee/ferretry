/**
 * THE ONE-CLICK SPEED BENCHMARK PAGE, served by the dev server: `bunx vite` in `packages/pwa`, then open
 * `/speed-bench/`. For a phone, `adb reverse tcp:5173 tcp:5173` makes the phone's `localhost` the dev
 * box (a secure context, which on-device speech needs). To measure multi-thread WebAssembly start the
 * server with `FY_DEV_ISOLATED=1` (docs/voice.md › Speed). Not part of the shipped bundle.
 */
import sherpaRuntimeUrl from 'sherpa-runtime-wasm?url';
import voskRuntimeUrl from '@lichess-org/vosk-browser/dist/vosk.wasm?url';
import runtimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import workerUrl from '../../../../app/worker/parakeet-worker.ts?worker&url';
import sherpaWorkerUrl from '../../../../app/worker/sherpa-worker.ts?worker&url';
import voskWorkerUrl from '../../../../app/worker/vosk-worker.ts?worker&url';
import whisperWorkerUrl from '../../../../app/worker/whisper-worker.ts?worker&url';
import { ON_DEVICE_MODEL_IDS } from '../../../../app/lib/stt/model-catalog.ts';
import { parseSpeedBenchReport } from '../../../../app/lib/stt/speed-bench-report.ts';
import { runBench } from './runner.ts';

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};

const state = element('state');
const log = element('log');
const result = element('result');
const run = element<HTMLButtonElement>('run');
const copy = element<HTMLButtonElement>('copy');
let json = '';

run.addEventListener('click', async () => {
  run.disabled = true;
  copy.disabled = true;
  log.textContent = '';
  result.textContent = '';
  state.textContent = 'Running… keep this tab open and in front.';
  try {
    const report = await runBench(
      globalThis as never,
      {
        parakeet: { workerUrl, runtimeUrl },
        sherpa: { workerUrl: sherpaWorkerUrl, runtimeUrl: sherpaRuntimeUrl },
        vosk: { workerUrl: voskWorkerUrl, runtimeUrl: voskRuntimeUrl },
        whisper: { workerUrl: whisperWorkerUrl, runtimeUrl },
      },
      {
        engines: ON_DEVICE_MODEL_IDS.filter(id =>
          ['parakeet', 'parakeet-tdt-110m', 'whisper-base-en', 'vosk-small-en'].includes(id),
        ),
        paths: element<HTMLInputElement>('threads').checked ? ['wasm-single', 'wasm-threads'] : ['wasm-single'],
        warmRuns: 3,
        pauseMs: 1_500,
        install: element<HTMLInputElement>('install').checked,
        clipUrl: new URL('./clip-5s.wav', import.meta.url).href,
        progress: line => {
          log.textContent += `${line}\n`;
        },
      },
    );
    // Checked before it is shown: a result that does not parse as timings-only is never printed.
    const checked = parseSpeedBenchReport(report);
    json = JSON.stringify(checked ?? { error: 'the result did not match the timings-only schema' }, null, 2);
    result.textContent = json;
    copy.disabled = checked === null;
    state.textContent = 'Done. Copy the JSON below.';
  } catch (error) {
    state.textContent = `Stopped: ${error instanceof Error ? error.name : 'error'}`;
  } finally {
    run.disabled = false;
  }
});

copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(json);
  state.textContent = 'Copied.';
});
