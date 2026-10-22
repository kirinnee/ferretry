import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/index.ts';

/** One frame a real pane showed, and when: milliseconds after the payload was first typed (-1: before). */
export interface RecordedFrame {
  readonly atMs: number;
  /** `x|y`, as `#{cursor_x}|#{cursor_y}` reported it beside the capture. */
  readonly cursor: string;
  readonly visible: string;
}

/** A fill and submit as a real harness answered them, captured by `scripts/local/soak-composer-landing.ts`. */
export interface Recording {
  readonly recorded: string;
  readonly payload: string;
  readonly keys: readonly { readonly atMs: number; readonly key: string }[];
  readonly frames: readonly RecordedFrame[];
}

export async function loadRecording(name: string): Promise<Recording> {
  return JSON.parse(await readFile(join(import.meta.dir, '../../fixtures/composer', name), 'utf8')) as Recording;
}

/**
 * A pane that REPLAYS a recording on a virtual clock: until the payload is typed it shows the frame
 * from before, and afterwards whichever recorded frame was on screen that many milliseconds after the
 * typing. Keys are counted, never interpreted — what the pane drew is exactly what the real one drew,
 * whatever this daemon sends, which is what makes a stalled recording a fair test of patience.
 */
export class RecordedPane implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  private nowMs = 0;
  private typedAtMs: number | undefined;

  constructor(private readonly recording: Recording) {}

  /** Moves the virtual clock; a test's injected sleep calls it. */
  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  /** How many times the payload was typed. */
  typings(): number {
    return this.calls.filter(call => call[0] === 'paste-buffer' || (call[0] === 'send-keys' && call.includes('-l')))
      .length;
  }

  /** How many times Enter was pressed. */
  enters(): number {
    return this.calls.filter(call => call[0] === 'send-keys' && call.at(-1) === 'Enter').length;
  }

  async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'send-keys' && argv.includes('-l')) this.typedAtMs ??= this.nowMs;
    if (command === 'display-message') {
      const [x, y] = this.frame().cursor.split('|');
      return { code: 0, stdout: `0||${x}|${y}|40|100\n`, stderr: '' };
    }
    if (command === 'capture-pane') return { code: 0, stdout: this.frame().visible, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  private frame(): RecordedFrame {
    const frames = this.recording.frames;
    const first = frames[0] as RecordedFrame;
    if (this.typedAtMs === undefined) return first;
    const since = this.nowMs - this.typedAtMs;
    return frames.filter(frame => frame.atMs <= since).at(-1) ?? first;
  }
}
