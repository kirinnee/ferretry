/**
 * A FAKE NATIVE SPEECH HOST for the tests: the same stdin/stdout frames as `daemon/worker/speech-host.ts`, with the
 * behaviours a real native library can have, chosen by the text it is asked to speak (or, for a transcribe, by 7 samples) (a sealed child has no environment to
 * carry a script in): (`SEGV` and `ABORT`) kill this process with that signal in the middle of a call (what a fault inside
 * onnxruntime does), `OOMKILL` is killed outright (what the kernel's out-of-memory killer does), `HANG` never answers, `NOISE` writes bytes that are not a frame, `EXIT` exits with a code. Anything
 * else is spoken. Its pid is in every answer so a test can see which child answered.
 */
import { encodeFrame, FrameReader } from '../../../daemon/lib/native/frames.ts';

const reader = new FrameReader();
const say = (message: unknown): void => void process.stdout.write(encodeFrame(message));

for await (const chunk of Bun.stdin.stream()) {
  for (const { message } of reader.push(chunk)) {
    const request = message as { id: number; kind: string; text?: string; samples?: Float32Array };
    switch (request.kind) {
      case 'probe':
        say({ id: request.id, ok: true, kind: 'probe', version: 'fake-1', pid: process.pid });
        break;
      case 'load':
        say({ id: request.id, ok: true, kind: 'load', loadMs: 5, memoryMb: 1, pid: process.pid });
        break;
      case 'transcribe':
        if (request.samples?.length === 7) process.kill(process.pid, 'SIGSEGV');
        say({
          id: request.id,
          ok: true,
          kind: 'transcribe',
          text: `heard ${request.samples?.length ?? 0}`,
          decodeMs: 1,
        });
        break;
      case 'speak': {
        const text = request.text ?? '';
        if (text.includes('SEGV')) process.kill(process.pid, 'SIGSEGV');
        if (text.includes('ABORT')) process.kill(process.pid, 'SIGABRT');
        if (text.includes('OOMKILL')) process.kill(process.pid, 'SIGKILL');
        if (text.includes('EXIT')) process.exit(3);
        if (text.includes('NOISE')) process.stdout.write('this is not a frame at all, just a library printing');
        if (text.includes('HANG')) break;
        say({
          id: request.id,
          ok: true,
          kind: 'speak',
          samples: new Float32Array(160).fill(0.25),
          speakMs: 2,
          pid: process.pid,
        });
        break;
      }
      default:
        say({ id: request.id, ok: false, sentence: 'The fake host does not know that.' });
    }
  }
}
