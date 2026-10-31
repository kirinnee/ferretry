import { describe, it } from 'bun:test';
import should from 'should';
import { RedactingTerminalStreamService } from '../../../src/adapters/index.ts';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { NO_REDACTION } from '../../../src/lib/secrets/redaction.ts';
import type { TerminalCapture } from '../../../src/lib/terminal/redraw.ts';

const SCREEN: TerminalCapture = {
  lines: ['history', 'password: hunter2', '$ '],
  cols: 40,
  rows: 2,
  cursorX: 2,
  cursorY: 1,
  historySize: 1,
};

const inner = {
  captured: 0,
  write: async () => undefined,
  resize: async () => undefined,
  capture: async () => {
    inner.captured += 1;
    return SCREEN;
  },
};

describe('the viewer of a quarantined terminal', () => {
  it('should be shown a notice in the pane’s own shape, with no row of the pane in it', async () => {
    const view = new RedactingTerminalStreamService(
      inner,
      NO_REDACTION,
      () => 130_000,
      () => 100_000,
    );

    const shown = await view.capture('s', 't', 50);

    should(shown.rows).equal(2);
    should(shown.cols).equal(40);
    should(shown.lines.length).equal(2);
    should(shown.lines[0]).containEql('Kept from view');
    should(shown.lines[1]).containEql('30s');
    should(shown.historySize).equal(0);
    should([shown.cursorX, shown.cursorY]).eql([0, 0]);
    should(JSON.stringify(shown)).not.containEql('hunter2');
  });

  it('should round a window that is nearly over up to one second, and take the message from a tall pane', async () => {
    const tall = { ...inner, capture: async () => ({ ...SCREEN, rows: 5 }) };
    const view = new RedactingTerminalStreamService(
      tall,
      NO_REDACTION,
      () => 100_001,
      () => 100_000,
    );

    const shown = await view.capture('s', 't', 50);

    should(shown.lines.length).equal(5);
    should(shown.lines[1]).containEql('1s');
    should(shown.lines[3]).equal('');
  });

  it('should show the masked pane when the viewer asked to see it anyway, or when nothing is held', async () => {
    const values = new EphemeralValues({ now: () => 0 });
    values.hold('s', 'hunter2', 'password');
    const masking = new EphemeralAwareRedactor(NO_REDACTION, values);
    const revealed = new RedactingTerminalStreamService(inner, masking);
    const free = new RedactingTerminalStreamService(inner, masking, () => undefined);

    for (const view of [revealed, free]) {
      const shown = await view.capture('s', 't', 50);
      should(shown.lines.join('\n')).not.containEql('hunter2');
      should(shown.lines.join('\n')).not.containEql('hunter2');
    }
  });

  it('should not draw a screen that was read before the quarantine began (capture in flight)', async () => {
    let held: number | undefined;
    const slow = {
      ...inner,
      capture: async () => {
        const before = SCREEN;
        held = 130_000;
        return before;
      },
    };
    const view = new RedactingTerminalStreamService(
      slow,
      NO_REDACTION,
      () => held,
      () => 100_000,
    );

    const shown = await view.capture('s', 't', 50);

    should(shown.lines[0]).containEql('Kept from view');
    should(JSON.stringify(shown)).not.containEql('hunter2');
  });

  it('should not draw a screen whose redaction finished after the quarantine began', async () => {
    let held: number | undefined;
    const slowRedactor = {
      ...NO_REDACTION,
      batch: async <T>(work: (scrub: never) => T): Promise<T> => {
        held = 130_000;
        return await NO_REDACTION.batch(work as never);
      },
    };
    const view = new RedactingTerminalStreamService(
      inner,
      slowRedactor,
      () => held,
      () => 100_000,
    );

    const shown = await view.capture('s', 't', 50);

    should(shown.lines[0]).containEql('Kept from view');
    should(JSON.stringify(shown)).not.containEql('hunter2');
  });

  it('should show the notice on every capture a delta or a re-attach asks for, then the pane when it ends', async () => {
    let held: number | undefined = 130_000;
    const view = new RedactingTerminalStreamService(
      inner,
      NO_REDACTION,
      () => held,
      () => 100_000,
    );

    const first = await view.capture('s', 't', 50);
    const reattached = await view.capture('s', 't', 50);
    held = undefined;
    const after = await view.capture('s', 't', 50);

    should(first.lines[0]).containEql('Kept from view');
    should(reattached).eql(first);
    should(after.lines.join('\n')).containEql('hunter2');
  });

  it('should still pass keystrokes and resizes through while the pane is hidden', async () => {
    const calls: string[] = [];
    const view = new RedactingTerminalStreamService(
      { ...inner, write: async () => void calls.push('write'), resize: async () => void calls.push('resize') },
      NO_REDACTION,
      () => 130_000,
    );

    await view.write('s', 't', new Uint8Array([1]));
    await view.resize('s', 't', 10, 10);

    should(calls).eql(['write', 'resize']);
  });
});
