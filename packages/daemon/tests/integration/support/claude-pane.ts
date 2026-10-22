import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/index.ts';

/**
 * A Claude Code 2.1.281 pane, drawn the way the live captures under `tests/fixtures/composer/claude-*`
 * show it — for the paths that type into a composer a PERSON may be writing in.
 *
 * What it models, each measured live on 2.1.281 in tmux at 82 columns:
 *   * A named session draws its name inside the rule above the composer.
 *   * Typed text wraps onto rows indented two columns; the cursor sits after the last character.
 *   * An empty composer shows a `Try "…"` suggestion with the cursor at its first column.
 *   * `C-u` erases back to the start of the WRAPPED ROW the cursor is on — never the whole message.
 *
 * And what a test may switch on: an Enter that does not submit (the stranded pointer the owner's Mac
 * kept showing), keys a person types into the composer while a fill is in flight, and a cursor that
 * tmux reports somewhere other than the composer — which no frame can tell from a placeholder.
 */
export class ClaudePane implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  /** What the composer holds, characters only: wrapping is the rendering's business. */
  composer = '';
  /** Messages Enter submitted, in order. */
  readonly submitted: string[] = [];
  /** The harness's transcript, written as Claude Code writes a user turn. */
  readonly transcript: unknown[] = [];
  /** False: Enter leaves the composer exactly as it was. */
  enterSubmits = true;
  /** `lost`: tmux reports the cursor on the pane's last blank row, not in the composer. */
  cursor: 'caret' | 'lost' = 'caret';
  /** Typed into the composer just AFTER the next literal or paste lands — a person mid-sentence. */
  typesAfterNextFill: string | undefined;

  private readonly height = 34;
  private readonly buffers = new Map<string, string>();
  private pastes = 0;

  constructor(
    private readonly now: () => string,
    /** Columns, 82 as in the incident pane; the title is dropped where it would not fit. */
    private readonly width = 82,
    private readonly title = '[Aime] MXO OCI Migration',
  ) {}

  /** Every literal or paste that reached the pane, in order. */
  fills(): readonly string[] {
    return this.calls.flatMap(call => {
      if (call[0] === 'send-keys' && call.includes('-l')) return [String(call.at(-1))];
      return call[0] === 'paste-buffer' ? ['<paste>'] : [];
    });
  }

  /** Every Enter sent to the pane. */
  enters(): number {
    return this.calls.filter(call => call[0] === 'send-keys' && !call.includes('-l') && call.at(-1) === 'Enter').length;
  }

  async execute(argv: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'display-message') return ok(this.metadata());
    if (command === 'capture-pane') return ok(`${this.lines().join('\n')}\n`);
    if (command === 'send-keys') return this.keys(argv);
    if (command === 'load-buffer') {
      this.buffers.set(String(argv[2]), stdin ?? '');
      return ok('');
    }
    if (command === 'paste-buffer') {
      const name = String(argv[argv.indexOf('-b') + 1]);
      this.pastes += 1;
      this.composer += `[Pasted text #${this.pastes} +${(this.buffers.get(name) ?? '').split('\n').length} lines]`;
      this.buffers.delete(name);
      this.afterFill();
      return ok('');
    }
    return ok('');
  }

  private keys(argv: readonly string[]): TmuxCommandResult {
    const literal = argv.indexOf('-l');
    if (literal >= 0) {
      this.composer += String(argv[literal + 1]);
      this.afterFill();
      return ok('');
    }
    const key = String(argv.at(-1));
    if (key === 'C-u') {
      const rows = this.rows();
      const last = rows.at(-1) ?? '';
      this.composer = this.composer.slice(0, this.composer.length - last.length);
    }
    if (key === 'Enter' && this.composer !== '' && this.enterSubmits) {
      this.submitted.push(this.composer);
      this.transcript.push({
        type: 'user',
        uuid: `u-${this.transcript.length}`,
        timestamp: this.now(),
        message: { role: 'user', content: this.composer },
      });
      this.composer = '';
    }
    return ok('');
  }

  private afterFill(): void {
    if (this.typesAfterNextFill === undefined) return;
    this.composer = `${this.typesAfterNextFill}${this.composer}`;
    this.typesAfterNextFill = undefined;
  }

  /** The composer's characters cut into the rows the pane draws them on. */
  private rows(): readonly string[] {
    const usable = this.width - 4;
    const rows: string[] = [];
    for (let start = 0; start < this.composer.length; start += usable)
      rows.push(this.composer.slice(start, start + usable));
    return rows;
  }

  private composerRow(): number {
    return 5;
  }

  lines(): readonly string[] {
    const rule = '─'.repeat(this.width);
    const titled =
      this.width > this.title.length + 8 ? `${'─'.repeat(this.width - this.title.length - 4)} ${this.title} ─` : rule;
    const rows = this.rows();
    const composer =
      rows.length === 0
        ? ['❯ Try "edit <filepath> to..."']
        : rows.map((row, index) => `${index === 0 ? '❯' : ' '} ${row}`);
    const lines = [
      "⏺ Next steps: say whether you want this drafted as a PR, and check who owns the tenancy's IAM.",
      '',
      '✻ Cooked for 16m 51s · done 9:14 AM · 1 shell still running',
      '',
      titled,
      ...composer,
      rule,
      '  👤 kirinnee97 │ 🤖 Opus 5.5 │ 📂 PE   new task? /clear to save 120.6k tokens',
      '  📊 59% (119k/200k) │ 💰 $1.87',
      '  ⏵⏵ bypass permissions on · 1 shell',
    ];
    while (lines.length < this.height) lines.push('');
    return lines;
  }

  /** `#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}` */
  private metadata(): string {
    if (this.cursor === 'lost') return `0||0|${this.height - 1}|${this.height}|${this.width}\n`;
    const rows = this.rows();
    const y = this.composerRow() + Math.max(0, rows.length - 1);
    return `0||${2 + (rows.at(-1)?.length ?? 0)}|${y}|${this.height}|${this.width}\n`;
  }
}

function ok(stdout: string): TmuxCommandResult {
  return { stdout, stderr: '', code: 0 };
}
