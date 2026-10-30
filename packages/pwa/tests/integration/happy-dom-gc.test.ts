import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const PROBE = join(import.meta.dir, 'support', 'happy-dom-gc-probe.ts');
/** The probe answers in well under a second; this only bounds a wedged child. */
const PROBE_DEADLINE_MS = 60_000;

describe('the happy-dom test environment', () => {
  it('keeps a connected MutationObserver delivering after garbage collection', async () => {
    // happy-dom 20.11.1 used to collect its orphaned internal delivery closure on a full collection
    // even though the observer and its target were still live. The collection runs in a child: a
    // synchronous Bun.gc(true) in the shared runner can wedge it for good (#903).
    const child = Bun.spawn([process.execPath, PROBE], { stdout: 'pipe', stderr: 'inherit' });
    const deadline = setTimeout(() => child.kill('SIGKILL'), PROBE_DEADLINE_MS);
    const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    clearTimeout(deadline);

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.trim().split('\n').at(-1) ?? '{}')).toEqual({ beforeCollection: 1, afterCollection: 2 });
  });
});
