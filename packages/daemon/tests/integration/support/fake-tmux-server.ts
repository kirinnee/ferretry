import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/index.ts';

/**
 * A tmux server the tests own.
 *
 * It answers the real command vocabulary the controller emits, and — the part that matters — it
 * MODELS A COMPOSER. Delivery is built entirely on what a later capture shows, so a fake that
 * accepts `send-keys` and returns a fixed frame cannot prove anything about it: every test would
 * pass against a daemon that typed into a modal and pressed Enter into the void.
 *
 * So keys land in a composer, the cursor moves with them, a bracketed paste collapses into the
 * placeholder both harnesses render, and Enter submits whatever is there.
 */
export class FakeTmuxServer implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  /** Payloads the pane received, in order. */
  readonly submitted: string[] = [];

  alive = true;
  dead = false;
  exitCode: string = '';
  /** Scrollback above the composer. */
  transcript = 'the last frame';
  /** A modal the pane is parked on until a key clears it. */
  modal: string | undefined;
  /** How many modals may be cleared; a modal beyond this one comes straight back. */
  modalsToClear = Number.MAX_SAFE_INTEGER;
  /** Captures to serve before the harness finishes booting and draws its prompt. */
  bootCaptures = 0;
  /** True once a submitted payload started a turn. */
  working = false;
  /** What the composer currently holds, as the pane renders it. */
  composer = '';
  /** Local-command mode: Enter consumes the payload without starting a turn. */
  localCommand = false;

  private captures = 0;
  private pasteCount = 0;
  private readonly buffers = new Map<string, string>();

  async execute(argv: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'has-session') return result(this.alive ? '' : 'no such session', this.alive ? 0 : 1);
    if (command === 'new-session') {
      this.alive = true;
      return result('');
    }
    if (command === 'kill-session') {
      this.alive = false;
      return result('');
    }
    if (command === 'display-message') return result(this.metadata());
    if (command === 'capture-pane') return result(this.frame());
    if (command === 'send-keys') return this.sendKeys(argv);
    if (command === 'load-buffer') {
      this.buffers.set(String(argv[2]), stdin ?? '');
      return result('');
    }
    if (command === 'paste-buffer') return this.pasteBuffer(argv);
    if (command === 'delete-buffer') {
      this.buffers.delete(String(argv[2]));
      return result('');
    }
    return result('');
  }

  /** Which buffers are still held by the server — a leaked payload is a visible one. */
  heldBuffers(): readonly string[] {
    return [...this.buffers.keys()];
  }

  /** The command names received, for asserting a sequence without its arguments. */
  commands(): readonly string[] {
    return this.calls.map(call => call[0] ?? '');
  }

  private sendKeys(argv: readonly string[]): TmuxCommandResult {
    const literal = argv.indexOf('-l');
    if (literal >= 0) {
      this.composer += String(argv[literal + 1]);
      return result('');
    }
    const key = String(argv.at(-1));
    if (this.modal !== undefined) {
      // Arrow keys move within the modal; Enter is what answers it.
      if (key === 'Enter' && this.modalsToClear > 0) {
        this.modalsToClear -= 1;
        this.modal = undefined;
      }
      return result('');
    }
    if (key === 'C-u') this.composer = '';
    if (key === 'Enter' && this.composer.length > 0) {
      // What the pane RECEIVED, which for a collapsed paste is the payload rather than its placeholder.
      this.submitted.push(this.pastedPayloads.get(this.composer) ?? this.composer);
      this.composer = '';
      this.working = !this.localCommand;
    }
    return result('');
  }

  private pasteBuffer(argv: readonly string[]): TmuxCommandResult {
    const name = String(argv[argv.indexOf('-b') + 1]);
    const payload = this.buffers.get(name);
    if (payload === undefined) return { code: 1, stdout: '', stderr: 'no buffer' };
    // Both harnesses collapse a bracketed paste and render NONE of its characters.
    this.pasteCount += 1;
    this.composer = `[Pasted text #${this.pasteCount} +${payload.split('\n').length} lines]`;
    this.pastedPayloads.set(this.composer, payload);
    if (argv.includes('-d')) this.buffers.delete(name);
    return result('');
  }

  /** Placeholder text back to the payload behind it, since the pane renders none of its characters. */
  private readonly pastedPayloads = new Map<string, string>();

  /** The pane as it renders, one entry per line, with the composer last. */
  private lines(): readonly string[] {
    const rendered = [...this.transcript.split('\n')];
    if (this.modal !== undefined) rendered.push(...this.modal.split('\n'));
    if (this.working) rendered.push('✻ Lollygagging… (34s · ⚒ 2.1k tokens)');
    return [...rendered, `> ${this.composer}`];
  }

  private frame(): string {
    this.captures += 1;
    if (this.captures <= this.bootCaptures) return `${this.transcript}\nLoading model…\n`;
    return `${this.lines().join('\n')}\n`;
  }

  /** `#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}` */
  private metadata(): string {
    // The cursor sits after whatever the composer holds, which is exactly what keeps a pane with
    // text still in it from reading as an idle prompt.
    return `${this.dead ? 1 : 0}|${this.exitCode}|${2 + this.composer.length}|${this.lines().length - 1}|24|80\n`;
  }
}

function result(stdout: string, code = 0): TmuxCommandResult {
  return { stdout, stderr: '', code };
}
