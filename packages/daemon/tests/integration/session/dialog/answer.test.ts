import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessDialogSchema } from '@ferretry/protocol';
import should from 'should';
import { BunTmuxProcess } from '../../../../src/adapters/index.ts';
import {
  ProvedPaneCapture,
  parseHarnessDialog,
  SessionConsoleService,
  type SessionPaneProof,
  SessionDialogService,
  TmuxController,
} from '../../../../src/lib/index.ts';

/**
 * ANSWERING A HARNESS DIALOG, end to end over a real tmux server.
 *
 * Each pane runs a fake harness (a Bun script on a raw terminal): it draws a dialog Codex or Claude Code
 * really drew (`tests/fixtures/harness-dialogs`), moves its cursor glyph on an arrow key, logs EVERY
 * byte it receives as hex, and redraws an idle prompt on Enter or Esc — so each case proves the whole
 * path: the dialog read off the pane as data, the choice becoming arrows then Enter, and the pane
 * showing the dialog gone. The `deaf`, `swap` and `stuck` modes are the ways a real harness can
 * disagree: ignoring the arrows, drawing another screen, and not acting on Enter.
 */

const FIXTURES = join(import.meta.dir, '../../../fixtures/harness-dialogs');
const IDLE = '● ok\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────';
const HARNESS = `
import { appendFileSync, readFileSync } from 'node:fs';
const [, , file, keys, mode, other, idle] = process.argv;
const GLYPH = /^(\\s*)([›❯>])\\s/u;
let lines = readFileSync(file, 'utf8').trimEnd().split('\\n');
const draw = () => process.stdout.write('\\x1b[H\\x1b[2J' + lines.join('\\n') + '\\n');
const label = line => (GLYPH.exec(line) ? line.replace(GLYPH, (_, indent) => indent + '  ') : line).search(/\\S/u);
const cursorAt = () => lines.findLastIndex(line => GLYPH.test(line));
function move(step) {
  const at = cursorAt();
  const column = label(lines[at]);
  const numbered = /^\\d[.)]\\s/u.test(lines[at].slice(column));
  const isRow = line => label(line) === column && (!numbered || /^\\d[.)]\\s/u.test(line.slice(column)));
  let to = at + step;
  while (lines[to] !== undefined && !isRow(lines[to])) to += step;
  if (lines[to] === undefined) return;
  const glyph = GLYPH.exec(lines[at])[2];
  lines[at] = lines[at].replace(GLYPH, (_, indent) => indent + '  ');
  lines[to] = lines[to].slice(0, column - 2) + glyph + ' ' + lines[to].slice(column);
}
let swapped = false;
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  appendFileSync(keys, Buffer.from(chunk).toString('hex') + ' ');
  for (const key of Buffer.from(chunk).toString('latin1').match(/\\x1b\\[[AB]|\\r|\\x1b/g) ?? []) {
    if (key === '\\x1b[A' || key === '\\x1b[B') {
      if (mode === 'deaf') continue;
      if (mode === 'swap' && !swapped) {
        swapped = true;
        lines = readFileSync(other, 'utf8').trimEnd().split('\\n');
      } else move(key === '\\x1b[B' ? 1 : -1);
      draw();
    } else if (mode !== 'stuck') {
      lines = readFileSync(idle, 'utf8').split('\\n');
      process.stdout.write('\\x1b[H\\x1b[2J' + lines.join('\\n'));
    }
  }
});
setInterval(() => {}, 1000);
`;

let home: string;
let tmux: BunTmuxProcess;
let controller: TmuxController;
let harness: string;
let counter = 0;

beforeAll(async () => {
  const binary = Bun.which('tmux');
  if (binary === null) throw new Error('tmux is required for dialog-answer integration coverage');
  home = await mkdtemp(join(tmpdir(), 'ferretry-dialog-'));
  tmux = new BunTmuxProcess(binary, join(home, 'tmux.sock'));
  controller = new TmuxController(tmux);
  harness = join(home, 'harness.mjs');
  await writeFile(join(home, 'idle.txt'), IDLE);
  await writeFile(harness, HARNESS);
});

afterAll(async () => {
  await tmux.execute(['kill-server']).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

type Mode = 'normal' | 'deaf' | 'swap' | 'stuck';

/** A pane showing `fixture`, and the service that answers it through that pane's proved id. */
async function pane(fixture: string, mode: Mode = 'normal', other = 'codex-0.156.1-update') {
  counter += 1;
  const session = `dialog-${counter}`;
  const keys = join(home, `${session}.keys`);
  await writeFile(keys, '');
  await controller.launch({
    session,
    cwd: home,
    command: [
      process.execPath,
      'run',
      harness,
      join(FIXTURES, `${fixture}.txt`),
      keys,
      mode,
      join(FIXTURES, `${other}.txt`),
      join(home, 'idle.txt'),
    ],
    width: 120,
    height: 40,
  });
  const paneId = (await tmux.execute(['display-message', '-p', '-t', session, '#{pane_id}'])).stdout.trim();
  const proof: SessionPaneProof = {
    resolve: async () => ({
      socketPath: join(home, 'tmux.sock'),
      tmuxSession: session,
      paneId,
      pid: 2,
      processStartTicks: 1,
    }),
  };
  const capture = new ProvedPaneCapture(proof, tmux);
  const typing = new SessionConsoleService(proof, tmux);
  const service = new SessionDialogService(
    { capture: async id => await capture.capture(id), write: async (id, bytes) => await typing.write(id, bytes) },
    milliseconds => Bun.sleep(milliseconds),
    { settleReads: 15, settleMs: 100 },
  );
  // Until the harness has drawn the dialog, there is nothing to read.
  const drawn = async (): Promise<string> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const frame = await capture.capture(session);
      if (parseHarnessDialog(frame) !== undefined) return frame;
      await Bun.sleep(100);
    }
    throw new Error(`${fixture} was never drawn`);
  };
  return { session, service, drawn, capture, keys: async () => (await readFile(keys, 'utf8')).replaceAll(' ', '') };
}

const fixtures = (await readdir(FIXTURES))
  .filter(name => name.endsWith('.txt') && !name.endsWith('-moved.txt'))
  .map(name => name.slice(0, -4))
  .sort();

describe('answering a harness dialog through its real pane', () => {
  it('should cover every dialog captured from both harnesses', () => {
    should(fixtures.length).equal(16);
  });

  for (const fixture of fixtures)
    it(`${fixture}: read as data, the last row chosen by arrows then Enter (or Esc), and the dialog cleared`, async () => {
      // Arrange
      const subject = await pane(fixture);
      const frame = await subject.drawn();
      const expected = parseHarnessDialog(await readFile(join(FIXTURES, `${fixture}.txt`), 'utf8'));

      // Act — detection off the live pane, then the LAST row, or Esc for a list with no rows.
      const dialog = HarnessDialogSchema.parse(parseHarnessDialog(frame));
      const last = dialog.options.at(-1);
      const result = await subject.service.answer(
        subject.session,
        last === undefined
          ? { kind: 'escape', dialogId: dialog.id }
          : { kind: 'choice', dialogId: dialog.id, number: last.number },
      );

      // Assert — the same dialog the harness drew; exactly the arrows to the row, then Enter (or Esc).
      should(dialog).deepEqual(expected);
      should(result).deepEqual({ dialogId: dialog.id, cleared: true });
      const steps = last === undefined ? 0 : last.number - (dialog.selected as number);
      should(await subject.keys()).equal(
        last === undefined ? '1b' : `${(steps > 0 ? '1b5b42' : '1b5b41').repeat(Math.abs(steps))}0d`,
      );
      should(parseHarnessDialog(await subject.capture.capture(subject.session))).be.undefined();
    }, 30_000);

  it('should send Down then Enter for the second row of the hooks review: 1b 5b 42 0d', async () => {
    // Arrange
    const subject = await pane('codex-0.156.1-hooks-review');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 2 });

    // Assert
    should(result.cleared).be.true();
    should(await subject.keys()).equal('1b5b420d');
  }, 30_000);

  it('should press Enter alone when the cursor is already on the chosen row', async () => {
    // Arrange
    const subject = await pane('codex-0.156.1-hooks-review');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 1 });

    // Assert
    should(result.cleared).be.true();
    should(await subject.keys()).equal('0d');
  }, 30_000);

  it('should walk Up, and keep the dialog the same one after the cursor moves', async () => {
    // Arrange — Claude 2.1.281's MCP dialog, drawn without digits and with the cursor on the last row.
    const subject = await pane('claude-2.1.281-mcp-servers');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 1 });

    // Assert
    should(dialog.selected).equal(3);
    should(result.cleared).be.true();
    should(await subject.keys()).equal('1b5b411b5b410d');
  }, 30_000);

  it('should press Enter nowhere when the cursor never arrives on the chosen row', async () => {
    // Arrange — a harness that ignores the arrows.
    const subject = await pane('codex-0.156.1-hooks-review', 'deaf');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 3 });

    // Assert — the arrows were typed, Enter never, and the dialog is still asking.
    should(result).deepEqual({ dialogId: dialog.id, cleared: false });
    should(await subject.keys()).equal('1b5b421b5b42');
    should(parseHarnessDialog(await subject.capture.capture(subject.session))?.id).equal(dialog.id);
  }, 30_000);

  it('should press Enter nowhere when another screen comes up while the cursor moves', async () => {
    // Arrange — the first arrow lands on Codex's update prompt instead.
    const subject = await pane('codex-0.156.1-hooks-review', 'swap');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const refused = await subject.service
      .answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 2 })
      .catch((error: unknown) => error);

    // Assert — refused as gone; the one arrow is all that was typed.
    should(refused).have.property('refusal', 'gone');
    should(await subject.keys()).equal('1b5b42');
  }, 30_000);

  it('should report a dialog still on screen after Enter instead of pressing again', async () => {
    // Arrange — a harness that does not act on Enter.
    const subject = await pane('codex-0.156.1-update', 'stuck');
    const dialog = HarnessDialogSchema.parse(parseHarnessDialog(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'choice', dialogId: dialog.id, number: 1 });

    // Assert
    should(result).deepEqual({ dialogId: dialog.id, cleared: false });
    should(await subject.keys()).equal('0d');
  }, 30_000);

  it('should press Esc alone where the footer offers it, and refuse where it does not', async () => {
    // Arrange
    const skippable = await pane('codex-0.156.1-hooks-review');
    const skippableDialog = HarnessDialogSchema.parse(parseHarnessDialog(await skippable.drawn()));
    const fixed = await pane('codex-0.145.0-update');
    const fixedDialog = HarnessDialogSchema.parse(parseHarnessDialog(await fixed.drawn()));

    // Act
    const escaped = await skippable.service.answer(skippable.session, { kind: 'escape', dialogId: skippableDialog.id });
    const refused = await fixed.service
      .answer(fixed.session, { kind: 'escape', dialogId: fixedDialog.id })
      .catch((error: unknown) => error);

    // Assert
    should(escaped.cleared).be.true();
    should(await skippable.keys()).equal('1b');
    should(refused).have.property('refusal', 'invalid_choice');
    should(await fixed.keys()).equal('');
  }, 30_000);

  it('should type nothing when the pane no longer shows the dialog the person answered', async () => {
    // Arrange — the person saw the hooks review; the pane shows the update prompt.
    const subject = await pane('codex-0.156.1-update');
    await subject.drawn();
    const seen = parseHarnessDialog(
      await readFile(join(FIXTURES, 'codex-0.156.1-hooks-review.txt'), 'utf8'),
    ) as NonNullable<ReturnType<typeof parseHarnessDialog>>;

    // Act
    const refused = await subject.service
      .answer(subject.session, { kind: 'choice', dialogId: seen.id, number: 1 })
      .catch((error: unknown) => error);

    // Assert — refused as gone, the pane untouched and still asking.
    should(refused).have.property('refusal', 'gone');
    should(await subject.keys()).equal('');
    should(parseHarnessDialog(await subject.capture.capture(subject.session))).not.be.undefined();
  }, 30_000);
});
