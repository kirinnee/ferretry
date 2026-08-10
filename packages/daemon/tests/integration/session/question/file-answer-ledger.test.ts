import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAnswerLedger } from '../../../../src/adapters/session/question/index.ts';
import type { AnswerOperationRecord } from '../../../../src/lib/session/question/answer-ledger.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * The durable answer receipt against a real filesystem.
 *
 * Everything runs under a throwaway directory: nothing here resolves a state home, opens storage, or
 * reaches a terminal. What is being proved is exactly what the coordinator trusts this class for —
 * that a receipt written before a keystroke can still be read after a crash, and that a crash DURING
 * the write cannot make an earlier receipt disappear.
 */

const homes = new Set<string>();
const ID = parseSessionId('session-1');
const OTHER = parseSessionId('session-2');
const NOW = '2026-08-06T12:00:00.000Z';

const record = (patch: Partial<AnswerOperationRecord> = {}): AnswerOperationRecord => ({
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'print-1',
  acceptedAt: NOW,
  outcome: 'accepted',
  ...patch,
});

async function subject(): Promise<{ ledger: FileAnswerLedger; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fy-answer-ledger-'));
  homes.add(root);
  return { ledger: new FileAnswerLedger(id => join(root, id), { now: () => NOW }), root };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the durable answer ledger', () => {
  it('round-trips a receipt and lets the latest line settle it', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record());
    const accepted = await ledger.read(ID, 'request-1');
    await ledger.append(ID, record({ outcome: 'confirmed' }));
    const confirmed = await ledger.read(ID, 'request-1');

    // Assert
    should(accepted).match({ requestId: 'request-1', toolUseId: 'tool-1', outcome: 'accepted' });
    should(confirmed?.outcome).equal('confirmed');
  });

  it('reads nothing for a session that has never answered, and nothing for an unknown id', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    const missingSession = await ledger.read(ID, 'request-1');
    await ledger.append(ID, record());
    const missingRequest = await ledger.read(ID, 'request-2');

    // Assert
    should(missingSession).be.undefined();
    should(missingRequest).be.undefined();
  });

  it('keeps two request ids in one file from shadowing each other', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record());
    await ledger.append(ID, record({ requestId: 'request-2', toolUseId: 'tool-2', outcome: 'withdrawn' }));

    // Assert
    should((await ledger.read(ID, 'request-1'))?.outcome).equal('accepted');
    should((await ledger.read(ID, 'request-2'))?.toolUseId).equal('tool-2');
  });

  it('keeps one session’s receipts out of another session’s file', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record({ outcome: 'confirmed' }));

    // Assert
    should(await ledger.read(OTHER, 'request-1')).be.undefined();
    should(ledger.file(ID)).not.equal(ledger.file(OTHER));
  });

  it('skips a half-written final line rather than letting one crash poison the ledger', async () => {
    // Arrange — a settled receipt, then the exact signature of a crash mid-append.
    const { ledger } = await subject();
    await ledger.append(ID, record({ outcome: 'confirmed' }));
    await appendFile(ledger.file(ID), '{"requestId":"request-2","toolUse');

    // Act
    const survivor = await ledger.read(ID, 'request-1');
    const truncated = await ledger.read(ID, 'request-2');

    // Assert
    should(survivor?.outcome).equal('confirmed');
    should(truncated).be.undefined();
  });

  it.each([
    ['a line that is not an object', '"just a string"'],
    ['an array', '[]'],
    ['no request id', '{"toolUseId":"tool-1","fingerprint":"print-1","outcome":"accepted"}'],
    ['no tool id', '{"requestId":"request-1","fingerprint":"print-1","outcome":"accepted"}'],
    ['no fingerprint', '{"requestId":"request-1","toolUseId":"tool-1","outcome":"accepted"}'],
    [
      'no acceptance timestamp',
      '{"requestId":"request-1","toolUseId":"tool-1","fingerprint":"print-1","outcome":"accepted"}',
    ],
  ])('refuses to read a fabricated receipt (%s)', async (_name, line) => {
    // Arrange — a COMPLETE line, terminated: nothing about it is the crash signature, so it is not a
    // line this ledger may quietly drop. Trusting it would let a fabricated record authorize a second
    // drive; ignoring it would answer "no receipt" for a request that may have driven a form. The
    // only honest third option is to refuse the whole file.
    const { ledger } = await subject();
    await mkdir(join(ledger.file(ID), '..'), { recursive: true });
    await appendFile(ledger.file(ID), `${line}\n`);

    // Act + Assert
    await should(ledger.read(ID, 'request-1')).be.rejectedWith(/is corrupt at line 1/u);
  });

  it('fails closed when a receipt was appended after a truncated line, rather than reading past it', async () => {
    // Arrange — THE RESTART CASE, built out of the real methods rather than a hand-written file. A
    // settled receipt, then a crash mid-append, then the daemon comes back up and appends again. The
    // new receipt lands on the SAME line as the fragment, so tolerating the fragment as a tail would
    // silently swallow both — and a request with no receipt is a request the coordinator may drive.
    const { ledger } = await subject();
    await ledger.append(ID, record({ outcome: 'confirmed' }));
    await appendFile(ledger.file(ID), '{"requestId":"request-2","toolUse');
    await ledger.append(ID, record({ requestId: 'request-3', toolUseId: 'tool-3' }));

    // Act + Assert — not a silent `undefined` for request-3, and not a partial map either.
    await should(ledger.all(ID)).be.rejectedWith(/is corrupt at line 2/u);
    await should(ledger.read(ID, 'request-3')).be.rejectedWith(/is corrupt at line 2/u);
    await should(ledger.read(ID, 'request-1')).be.rejectedWith(/is corrupt at line 2/u);
  });

  it('fails closed when damage sits between two good receipts', async () => {
    // Arrange — the same rule stated without a crash anywhere near it: position, not provenance, is
    // what decides, so a reader cannot be talked into trusting the receipts that surround damage.
    const { ledger } = await subject();
    await ledger.append(ID, record());
    await appendFile(ledger.file(ID), 'not json at all\n');
    await ledger.append(ID, record({ requestId: 'request-2', outcome: 'confirmed' }));

    // Act + Assert
    await should(ledger.all(ID)).be.rejectedWith(/is corrupt at line 2/u);
  });

  it('still tolerates a blank line, which is padding rather than a lost receipt', async () => {
    // Arrange
    const { ledger } = await subject();
    await ledger.append(ID, record({ outcome: 'confirmed' }));
    await appendFile(ledger.file(ID), '\n');
    await ledger.append(ID, record({ requestId: 'request-2' }));

    // Act
    const actual = await ledger.all(ID);

    // Assert
    should([...actual.keys()].sort()).deepEqual(['request-1', 'request-2']);
  });

  it('fails closed when a future daemon wrote an outcome this version does not know', async () => {
    const { ledger } = await subject();
    await mkdir(join(ledger.file(ID), '..'), { recursive: true });
    await appendFile(
      ledger.file(ID),
      `${JSON.stringify({
        requestId: 'request-1',
        toolUseId: 'tool-1',
        fingerprint: 'print-1',
        acceptedAt: NOW,
        outcome: 'future-release',
      })}\n`,
    );

    const actual = await ledger.read(ID, 'request-1');

    should(actual).match({ outcome: 'accepted', reason: /unrecognized outcome/u });
  });

  it('stamps each line with the time it was written, so the history stays legible', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record());
    const lines = (await Bun.file(ledger.file(ID)).text()).trim().split('\n');

    // Assert
    should(lines).have.length(1);
    should(JSON.parse(lines[0] ?? '{}')).match({ requestId: 'request-1', at: NOW });
  });

  it('creates the channel directory and the file with owner-only permissions', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record());

    // Assert
    should(ledger.file(ID).endsWith(join('channel', 'answers.jsonl'))).be.true();
    should((await stat(join(ledger.file(ID), '..'))).mode & 0o777).equal(0o700);
    should((await stat(ledger.file(ID))).mode & 0o777).equal(0o600);
  });

  it('answers every receipt at once for a human reading the file after the fact', async () => {
    // Arrange
    const { ledger } = await subject();

    // Act
    await ledger.append(ID, record());
    await ledger.append(ID, record({ requestId: 'request-2' }));
    const actual = await ledger.all(ID);

    // Assert
    should([...actual.keys()].sort()).deepEqual(['request-1', 'request-2']);
  });

  it.each([['failed'], ['quarantined'], ['acknowledged']] as const)(
    'round-trips the recovery outcome %s',
    async outcome => {
      const { ledger } = await subject();

      await ledger.append(ID, record({ outcome }));

      should(await ledger.read(ID, 'request-1')).match({ outcome });
    },
  );

  it('fails closed when the ledger exists but cannot be read as a file', async () => {
    const { ledger } = await subject();
    await mkdir(ledger.file(ID), { recursive: true });

    await should(ledger.all(ID)).be.rejected();
  });
});
