import { NotInstalledVoiceRecognizer, VoiceWorkerRuntime } from '../src/lib/voice/runtime.ts';
import { notInstalledVoiceDescription } from '../src/lib/voice/policy.ts';
import { VOICE_WORKER_THREADS_ENV, VoiceRecognizerDescriptionSchema } from '../src/lib/voice/ipc.ts';

/** Hidden process entry. Imported by fyd, so compiled builds need no adjacent source file. */
export function startVoiceWorker(): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    process.stderr.write('voice-worker requires advanced IPC from its daemon parent\n');
    process.exitCode = 2;
    return;
  }
  process.on('disconnect', () => process.exit(0));
  new VoiceWorkerRuntime(
    {
      send: message => {
        if (process.connected) send(message);
      },
      receive: handler => {
        process.on('message', handler);
      },
    },
    [
      new NotInstalledVoiceRecognizer(
        notInstalledVoiceDescription(
          VoiceRecognizerDescriptionSchema.shape.threads.parse(Number(process.env[VOICE_WORKER_THREADS_ENV])),
        ),
      ),
    ],
  ).start();
}
