import {
  formatClock,
  formatElapsed,
  type IProgress,
  type ProgressStepOptions,
  stepText,
} from '../../lib/progress/index.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TICK_MS = 80;
const CLEAR_LINE = '\r\u001b[2K';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

export interface TtyProgressHost {
  write(text: string): void;
  columns(): number;
  now(): number;
  repeat(callback: () => void, milliseconds: number): () => void;
  /** Run `callback` once on Ctrl-C and on exit; answer how to take both hooks away. */
  onInterrupt(callback: () => void): () => void;
  /** Re-raise the interrupt after the line was cleaned up, so the process still dies the way Ctrl-C kills it. */
  reraiseInterrupt(): void;
}

interface Live {
  readonly label: string;
  readonly startedAt: number;
  readonly expectedSeconds: number | undefined;
  detail: string | undefined;
}

/**
 * A spinner, the step it is working on, and a clock — drawn on ONE terminal line, so a long command is
 * visibly alive. A step that ends leaves a permanent `✔ label (3.4s)` line above the live one, which is
 * what makes the output read as a record of what happened rather than a flicker.
 *
 * Everything that touches the world arrives through `TtyProgressHost`: the stream, the clock, the
 * timer and the interrupt, so the redraw logic is tested with no terminal and no waiting.
 *
 * Ctrl-C leaves a clean line: the live line is wiped, `✖ label — interrupted` is written, the cursor is
 * shown again, and the interrupt is re-raised so the process ends as it would have without a spinner.
 */
export class TtyProgress implements IProgress {
  #live: Live | undefined;
  #frame = 0;
  #drawn = false;
  #cursorHidden = false;
  #cancelTick: (() => void) | undefined;
  #releaseInterrupt: (() => void) | undefined;

  constructor(private readonly host: TtyProgressHost) {}

  start(label: string, options?: ProgressStepOptions): void {
    this.#settle(true, undefined);
    this.#live = {
      label,
      startedAt: this.host.now(),
      expectedSeconds: options?.expectedSeconds,
      detail: undefined,
    };
    this.#arm();
    this.#draw();
  }

  detail(text: string): void {
    if (this.#live === undefined) return;
    this.#live.detail = text;
  }

  succeed(text?: string): void {
    this.#settle(true, text);
    this.#disarmWhenIdle();
  }

  fail(text?: string): void {
    this.#settle(false, text);
    this.#disarmWhenIdle();
  }

  pause(): void {
    this.#wipe();
  }

  stop(): void {
    this.#wipe();
    this.#live = undefined;
    this.#disarm();
  }

  #arm(): void {
    if (this.#cancelTick === undefined) {
      this.#cancelTick = this.host.repeat(() => {
        this.#frame = (this.#frame + 1) % FRAMES.length;
        this.#draw();
      }, TICK_MS);
    }
    this.#releaseInterrupt ??= this.host.onInterrupt(() => {
      this.#interrupted();
    });
    if (!this.#cursorHidden) {
      this.host.write(HIDE_CURSOR);
      this.#cursorHidden = true;
    }
  }

  #disarmWhenIdle(): void {
    if (this.#live === undefined) this.#disarm();
  }

  #disarm(): void {
    this.#cancelTick?.();
    this.#cancelTick = undefined;
    this.#releaseInterrupt?.();
    this.#releaseInterrupt = undefined;
    if (this.#cursorHidden) {
      this.host.write(SHOW_CURSOR);
      this.#cursorHidden = false;
    }
  }

  #interrupted(): void {
    const live = this.#live;
    this.#wipe();
    if (live !== undefined) this.host.write(`✖ ${live.label} — interrupted\n`);
    this.#live = undefined;
    this.#disarm();
    this.host.reraiseInterrupt();
  }

  /** Turn the live step into a permanent line, `✔` or `✖`; a no-op when nothing is live. */
  #settle(ok: boolean, text: string | undefined): void {
    const live = this.#live;
    if (live === undefined) return;
    this.#wipe();
    const marker = ok ? '✔' : '✖';
    const elapsed = formatElapsed(this.host.now() - live.startedAt);
    this.host.write(`${marker} ${text ?? live.label} (${elapsed})\n`);
    this.#live = undefined;
  }

  #wipe(): void {
    if (!this.#drawn) return;
    this.host.write(CLEAR_LINE);
    this.#drawn = false;
  }

  #draw(): void {
    const live = this.#live;
    if (live === undefined) return;
    const clock = formatClock(this.host.now() - live.startedAt, live.expectedSeconds);
    const prefix = `${FRAMES[this.#frame] ?? FRAMES[0]} `;
    const suffix = ` (${clock})`;
    const room = Math.max(10, this.host.columns() - prefix.length - suffix.length - 1);
    const text = stepText(live.label, live.detail);
    const fitted = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    this.host.write(`${CLEAR_LINE}${prefix}${fitted}${suffix}`);
    this.#drawn = true;
  }
}
