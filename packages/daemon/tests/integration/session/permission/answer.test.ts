import { afterAll, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { BunTmuxProcess } from '../../../../src/adapters/index.ts';
import {
  ProvedPaneCapture,
  parsePermissionPrompt,
  SessionConsoleService,
  type SessionPaneProof,
  SessionPermissionService,
  TmuxController,
} from '../../../../src/lib/index.ts';

/**
 * ANSWERING A PERMISSION PROMPT, end to end over a real tmux server.
 *
 * Each pane runs a fake harness: it draws a prompt Claude Code or Codex really drew
 * (`tests/fixtures/permission-prompts`), waits for one key exactly as the harness does, logs EVERY byte
 * it receives — including any that arrive just after the first — and then redraws an idle prompt, the
 * way the real harness acts on the digit alone. So each case proves the whole path: the prompt is read
 * off the pane as data, the choice becomes exactly one key, and the pane shows the prompt gone.
 */

const FIXTURES = join(import.meta.dir, '../../../fixtures/permission-prompts');
const IDLE = '● ok\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────';

let home: string;
let tmux: BunTmuxProcess;
let controller: TmuxController;
let harness: string;
let counter = 0;

beforeAll(async () => {
  const binary = Bun.which('tmux');
  if (binary === null) throw new Error('tmux is required for permission-answer integration coverage');
  home = await mkdtemp(join(tmpdir(), 'ferretry-permission-'));
  tmux = new BunTmuxProcess(binary, join(home, 'tmux.sock'));
  controller = new TmuxController(tmux);
  harness = join(home, 'harness.sh');
  await writeFile(join(home, 'idle.txt'), IDLE);
  // Listen first — a harness is already taking keys raw when its prompt appears, so a pane showing the
  // whole prompt is one a key can answer (`opost` keeps each newline returning the carriage). Then draw
  // the prompt, take one key, then whatever else lands within half a second, log it all as hex, and
  // redraw as idle — the harness acting on the key the moment it is pressed.
  await writeFile(
    harness,
    [
      '#!/bin/sh',
      'stty raw -echo opost',
      `printf '\\033[H\\033[2J'; cat "$1"`,
      'first="$(dd bs=1 count=1 2>/dev/null | od -An -tx1)"',
      'rest="$(timeout 0.5 dd bs=1 count=8 2>/dev/null | od -An -tx1)"',
      'stty sane',
      `echo $first $rest > "$2"`,
      `printf '\\033[H\\033[2J'; cat '${join(home, 'idle.txt')}'`,
      'exec sleep 600',
    ].join('\n'),
  );
  await chmod(harness, 0o755);
});

afterAll(async () => {
  await tmux.execute(['kill-server']).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

/** A pane showing `fixture`, and the service that answers it through that pane's proved id. */
async function pane(fixture: string) {
  counter += 1;
  const session = `perm-${counter}`;
  const keys = join(home, `${session}.keys`);
  await writeFile(keys, '');
  await controller.launch({
    session,
    cwd: home,
    command: ['/bin/sh', harness, join(FIXTURES, `${fixture}.txt`), keys],
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
  const service = new SessionPermissionService(
    { capture: async id => await capture.capture(id), write: async (id, bytes) => await typing.write(id, bytes) },
    milliseconds => Bun.sleep(milliseconds),
    { settleReads: 25, settleMs: 100 },
  );
  // Until the harness has drawn the WHOLE prompt, there is nothing to read. A frame caught mid-paint
  // already parses — as a different prompt, its last row cut short — so "parses" is not "drawn". A
  // terminal paints bytes in order: the fixture's last line on screen means every line above it is too.
  const last = (text: string): string | undefined => text.trimEnd().split('\n').at(-1)?.trimEnd();
  const final = last(await readFile(join(FIXTURES, `${fixture}.txt`), 'utf8'));
  const drawn = async (): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const frame = await capture.capture(session);
      if (last(frame) === final) return frame;
      await Bun.sleep(100);
    }
    throw new Error(`${fixture} was never drawn`);
  };
  return { session, service, drawn, capture, keys: async () => (await readFile(keys, 'utf8')).trim() };
}

const fixtures = (await readdir(FIXTURES)).filter(name => name.endsWith('.txt')).map(name => name.slice(0, -4));

describe('answering a harness permission prompt through its real pane', () => {
  it('should cover every prompt kind captured from both harnesses', () => {
    should(fixtures.length).equal(22);
  });

  for (const fixture of fixtures.sort())
    it(`${fixture}: read as data, the chosen row sent as its digit alone, and the prompt cleared`, async () => {
      // Arrange
      const subject = await pane(fixture);
      const frame = await subject.drawn();
      const expected = parsePermissionPrompt(await readFile(join(FIXTURES, `${fixture}.txt`), 'utf8'));

      // Act — detection off the live pane, then the LAST row that is not a refusal.
      const request = PermissionRequestSchema.parse(parsePermissionPrompt(frame));
      const choice = [...request.options].reverse().find(option => option.kind !== 'deny') ?? request.options[0];
      const result = await subject.service.answer(subject.session, {
        kind: 'choice',
        requestId: request.id,
        number: choice?.number ?? 1,
      });

      // Assert — the same request the harness drew, options parsed, one byte typed, prompt gone.
      should(request).deepEqual(expected);
      should(request.options.length).be.aboveOrEqual(2);
      should(result).deepEqual({ requestId: request.id, cleared: true });
      should(await subject.keys()).equal((0x30 + (choice?.number ?? 1)).toString(16));
      should(parsePermissionPrompt(await subject.capture.capture(subject.session))).be.undefined();
    }, 20_000);

  it('should refuse with Escape alone, the harness’s own (esc)', async () => {
    // Arrange
    const subject = await pane('claude-2.1.281-webfetch');
    const request = PermissionRequestSchema.parse(parsePermissionPrompt(await subject.drawn()));

    // Act
    const result = await subject.service.answer(subject.session, { kind: 'deny', requestId: request.id });

    // Assert
    should(result.cleared).be.true();
    should(await subject.keys()).equal('1b');
  }, 20_000);

  it('should type nothing when the pane no longer shows the prompt the person answered', async () => {
    // Arrange — the person saw the Read prompt; the pane now shows a different one.
    const subject = await pane('claude-2.1.281-bash');
    await subject.drawn();
    const seen = parsePermissionPrompt(
      await readFile(join(FIXTURES, 'claude-2.1.281-read-outside.txt'), 'utf8'),
    ) as NonNullable<ReturnType<typeof parsePermissionPrompt>>;

    // Act
    const refused = await subject.service
      .answer(subject.session, { kind: 'choice', requestId: seen.id, number: 1 })
      .catch((error: unknown) => error);

    // Assert — refused as gone, the pane untouched and still asking.
    should(refused).have.property('refusal', 'gone');
    should(await subject.keys()).equal('');
    should(parsePermissionPrompt(await subject.capture.capture(subject.session))).not.be.undefined();
  }, 20_000);
});
