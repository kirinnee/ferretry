import { expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { HoldEvidenceSchema, HoldsFile, InputRequestFiles } from '../../../../contract/index.ts';
import { InputStateJournal } from '../../../../daemon/adapters/inputs/journal.ts';
import { INPUT_QUARANTINE_EVENT_TYPES, type InputQuarantineEvent } from '../../../../daemon/lib/inputs/wire.ts';

const REQUEST = 'a'.repeat(32);
const AT = '2026-11-07T12:00:00.000Z';
const UNTIL = '2026-11-07T12:02:00.000Z';
function fixture() {
  const folder = new MemoryStateFolder();
  const journal = new InputStateJournal(
    folder.port([HoldsFile, InputRequestFiles]),
    async () => undefined,
    () => AT,
  );
  return { folder, journal };
}
function event(attempt: number, extra: Partial<InputQuarantineEvent> = {}): InputQuarantineEvent {
  return {
    type: INPUT_QUARANTINE_EVENT_TYPES.started,
    sessionId: 'f1',
    hold: `${REQUEST}/${attempt}`,
    names: ['dev', '%3'],
    at: AT,
    until: UNTIL,
    ...extra,
  };
}

test('I78 I84 durable evidence preserves separate attempts, grouped aliases and explicit unresolved state', async () => {
  const { folder, journal } = fixture();
  const first = event(1);
  const second = event(2, { unresolved: true });
  const ended = event(1, { type: INPUT_QUARANTINE_EVENT_TYPES.ended });
  await journal.quarantine('f1', first);
  await journal.quarantine('f1', second);
  await journal.quarantine('f1', ended);
  expect(await journal.quarantines('f1')).toEqual([first, { ...second, until: AT }, ended]);
  expect(await journal.quarantines('f2')).toEqual([]);
  const lines = (folder.raw(HoldsFile) ?? '')
    .trim()
    .split('\n')
    .map(line => HoldEvidenceSchema.parse(JSON.parse(line)));
  expect(lines.map(line => line.hold)).toEqual([`${REQUEST}/1`, `${REQUEST}/2`, `${REQUEST}/1`]);
  expect(lines.every(line => line.names.join(',') === 'dev,%3')).toBe(true);
  const evidence = lines[0];
  expect(HoldEvidenceSchema.safeParse({ ...evidence, names: [] }).success).toBe(false);
  expect(HoldEvidenceSchema.safeParse({ ...evidence, names: Array.from({ length: 33 }, () => 'dev') }).success).toBe(
    false,
  );
  expect(HoldEvidenceSchema.safeParse({ ...evidence, hold: '' }).success).toBe(false);
  expect(HoldEvidenceSchema.safeParse({ ...evidence, ferret: '' }).success).toBe(false);
});

test('I82 hold discovery and replay never read mutable request records; damaged history fails closed', async () => {
  const { folder, journal } = fixture();
  folder.plant(InputRequestFiles, '{damaged', REQUEST);
  await journal.quarantine('f1', event(1));
  expect(await journal.quarantineSessions()).toEqual(['f1']);
  expect(await journal.quarantines('f1')).toEqual([event(1)]);
  await expect(journal.history('f1')).rejects.toThrow('input request record cannot be read');
  await expect(journal.promptOf(REQUEST)).rejects.toThrow('input request record cannot be read');
});
