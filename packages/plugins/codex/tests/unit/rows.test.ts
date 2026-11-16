import { describe, expect, test } from 'bun:test';
import {
  type CodexPickerDrivePort,
  type CodexPickerFrame,
  type CodexPickerKeyExpectation,
  CodexModelPickerDriver,
  nextPickerDismissStep,
  type InjectionOutcome,
} from '../../daemon/lib/index.ts';

/**
 * Codex's side of the integration fixtures for G31 and G32. Claude Code declares the two answer routes
 * (`POST /v1/ferrets/:ferretId/permission|dialog`) and serves a Codex ferret too; what is Codex's is how it keys a
 * pane it was asked to answer in: one key at a time, each aimed at a row it re-proved on the screen first, and never
 * a key into a screen it does not recognise.
 */

const QUICK = ['Select Model', '  1. gpt-5.6-codex', '  2. gpt-5.6-terra', '  3. All models'].join('\n');
const LEVELS = ['Select Reasoning Level for gpt-5.6-codex', '  1. Low', '  2. Medium', '  3. High'].join('\n');
const IDLE = ['› ', ''].join('\n');
const UNKNOWN = 'some half-drawn thing\n';

class Pane implements CodexPickerDrivePort {
  readonly keys: { key: string; expected: CodexPickerKeyExpectation }[] = [];
  #index = 0;
  constructor(private readonly screens: readonly { visible: string; promptReady?: boolean }[]) {}

  async openPicker(): Promise<InjectionOutcome> {
    return 'handled-local';
  }

  async readPane(): Promise<CodexPickerFrame> {
    const screen = this.screens[Math.min(this.#index++, this.screens.length - 1)] ?? { visible: IDLE };
    return { alive: true, dead: false, promptReady: screen.promptReady ?? false, visible: screen.visible };
  }

  async sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void> {
    this.keys.push({ key, expected });
  }
}

describe('Codex pane answers', () => {
  test('G31 a permission-style choice is one digit key at a time, each carrying the row it was proved against, and never Enter', async () => {
    const pane = new Pane([{ visible: QUICK }, { visible: LEVELS }, { visible: IDLE, promptReady: true }]);
    await new CodexModelPickerDriver(pane, { sleep: async () => undefined }, { settleMs: 0, maxObservations: 8 }).drive(
      {
        model: 'gpt-5.6-codex',
        effort: 'high',
      },
    );

    expect(pane.keys.map(sent => sent.key)).toEqual(['1', '3']);
    expect(pane.keys.every(sent => /^[1-9]$/u.test(sent.key))).toBe(true);
    expect(pane.keys.map(sent => sent.expected.row)).toEqual([
      { number: 1, name: 'gpt-5.6-codex' },
      { number: 3, name: 'High' },
    ]);
  });

  test('G32 a dialog is dismissed with Escape only when the pane shows a Codex picker, and never records what was chosen', () => {
    expect(nextPickerDismissStep({ visiblePane: QUICK, promptReady: false }, 0)).toEqual({
      kind: 'send_escape',
      attempt: 1,
    });
    expect(nextPickerDismissStep({ visiblePane: IDLE, promptReady: true }, 0)).toEqual({ kind: 'settled' });
    // An unidentified screen is never keyed; the step carries a sentence, not a choice.
    const unknown = nextPickerDismissStep({ visiblePane: UNKNOWN, promptReady: false }, 0);
    expect(unknown.kind).toBe('unconfirmed');
    expect(JSON.stringify(unknown)).not.toContain('gpt-5.6');
  });
});
