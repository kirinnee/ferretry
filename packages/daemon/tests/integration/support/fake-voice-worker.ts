import { VoiceWorkerRuntime } from '../../../src/lib/voice/runtime.ts';
import { VOICE_WORKER_THREADS_ENV } from '../../../src/lib/voice/ipc.ts';
import type { VoiceRecognizer } from '../../../src/lib/voice/ports.ts';

const send = process.send?.bind(process);
if (send === undefined) throw new Error('Fake worker needs IPC');
process.stderr.write('fake voice worker started\n');
const description = {
  threads: Number(process.env[VOICE_WORKER_THREADS_ENV]),
  modelId: 'fake',
  modelBytes: 10,
  peakResidentBytes: 20,
  streaming: true,
};
const recognizer: VoiceRecognizer = {
  description,
  load: async () => ({ ok: true, value: undefined }),
  audio: async (_id, samples) => ({
    ok: true,
    value: `${samples instanceof Float32Array}:${samples.length}:${samples[0]}`,
  }),
  finish: async () => ({ ok: true, value: 'final words' }),
  cancel: () => {},
  unload: async () => {},
};
new VoiceWorkerRuntime(
  {
    send,
    receive: handler => {
      process.on('message', handler);
    },
  },
  [recognizer],
).start();
process.on('disconnect', () => process.exit(0));
