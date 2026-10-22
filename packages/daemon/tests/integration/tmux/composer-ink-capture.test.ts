import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunTmuxProcess, captureFrame, ControlModeTmuxProcess } from '../../../src/adapters/index.ts';
import { composerState, TmuxController } from '../../../src/lib/index.ts';

const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A pane whose composer row is drawn with the attributes the harnesses use, read through the in-band client. */
async function paneDrawing(composerRow: string): Promise<TmuxController> {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-ink-'));
  const socket = join(root, 's');
  const direct = new BunTmuxProcess(TMUX, socket);
  const control = new ControlModeTmuxProcess(TMUX, socket, direct);
  cleanups.push(async () => {
    control.close();
    await direct.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  await control.execute([
    'new-session',
    '-d',
    '-s',
    'work',
    '-x',
    '80',
    '-y',
    '8',
    `printf 'earlier output\\n\\n${composerRow}'; sleep 600`,
  ]);
  await Bun.sleep(400);
  return new TmuxController(control);
}

describe('the ink of a composer read from a real tmux through the control client', () => {
  it('should read a dim row as a placeholder even though the cursor sits after the words', async () => {
    // Arrange — the cursor ends after the text, which the cursor rule alone would call a typed draft.
    const tmux = await paneDrawing('\\033[1m>\\033[0m \\033[2mgo ahead with all three\\033[0m');

    // Act
    const frame = await captureFrame(tmux, 'work');

    // Assert
    should(frame.composerInk).equal('dim');
    should(composerState(frame)).deepEqual({ kind: 'empty' });
  });

  it('should read a plain row as typed text, whichever way the cursor says', async () => {
    const tmux = await paneDrawing('\\033[1m>\\033[0m go ahead with all three');

    const frame = await captureFrame(tmux, 'work');

    should(frame.composerInk).equal('plain');
    should(composerState(frame)).deepEqual({ kind: 'input', text: 'go ahead with all three' });
  });

  it('should give no ink for a row drawn without any attribute, leaving the cursor to decide', async () => {
    const tmux = await paneDrawing('> go ahead with all three');

    const frame = await captureFrame(tmux, 'work');

    should(frame.composerInk).be.undefined();
  });
});
