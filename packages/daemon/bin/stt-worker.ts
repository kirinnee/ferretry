#!/usr/bin/env bun
/**
 * The batch transcription worker.
 *
 * Spawned by the daemon, never by a user. The native addon and the ~1 GiB model
 * live only in this process, so a decode cannot block the daemon's event loop
 * and a native crash cannot take the daemon with it. The parent speaks Bun's
 * advanced IPC, which carries Float32Array audio without a JSON copy.
 */
import {
  recognizerModuleFrom,
  SherpaRecognizerFactory,
  type SttWorkerChannel,
  SttWorkerRuntime,
} from '../src/adapters/index.ts';

const send = process.send?.bind(process);
if (send === undefined) {
  process.stderr.write('stt-worker must be launched by its parent with advanced IPC\n');
  process.exitCode = 2;
} else {
  const channel: SttWorkerChannel = {
    send: message => {
      if (process.connected) send(message);
    },
    onMessage: handler => {
      process.on('message', handler);
    },
    disconnect: () => {
      process.disconnect?.();
    },
  };
  new SttWorkerRuntime(
    channel,
    new SherpaRecognizerFactory(recognizerModuleFrom(process.env)),
    { monotonicMs: () => performance.now() },
    () => {
      setTimeout(() => process.exit(0), 0);
    },
  ).start();
}
