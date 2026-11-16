/**
 * Held-edit follow-up row 62 (M14, M15): the owner's save of `lessons.yaml` is made through `writeAsOwner`, and BESIDE a
 * held edit only the keys the owner named are sent, so the held version keeps its own values for every other key. With
 * nothing held the whole settings are sent as before. The integration tier proves the same through the kernel; these
 * cases pin the unit itself, so a plain `write` (M14) or the whole settings beside a held edit (M15) cannot slip back.
 */
import { describe, expect, it } from 'bun:test';
import type { ConfigEdit, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { LessonsConfigSchema } from '../../contract/index.ts';
import { writeLessonsSettings } from '../../daemon/adapters/config-writer.ts';

const WRITTEN: ConfigWriteOutcome = { kind: 'written', etag: 'e', loosened: [] };

/** A config port that notes every write-shaped call and answers `written`; `held` makes the file hold an edit. */
function portNoting(options: { readonly held: boolean; readonly inEffect?: Record<string, unknown> }) {
  const calls: { readonly call: 'write' | 'writeAsOwner'; readonly edit: ConfigEdit }[] = [];
  const port = {
    file: () => options.inEffect,
    fileState: () => ({ state: options.held ? 'held' : 'valid', inEffect: true, sentences: [] }),
    write: async (_def: unknown, _name: unknown, edit: ConfigEdit) => (calls.push({ call: 'write', edit }), WRITTEN),
    writeAsOwner: async (_def: unknown, _name: unknown, edit: ConfigEdit) => (
      calls.push({ call: 'writeAsOwner', edit }), WRITTEN
    ),
  } as unknown as ConfigPort;
  return { port, calls };
}

const KEYS = Object.keys(LessonsConfigSchema.shape);

describe('the lessons settings save beside a held edit (row 62)', () => {
  it('M15 should send only the key the owner named while lessons.yaml holds an edit', async () => {
    const { port, calls } = portNoting({ held: true, inEffect: { agent: 'codex', intervalMinutes: 15 } });

    await writeLessonsSettings(port, { passiveDefault: false });

    expect(calls).toEqual([{ call: 'writeAsOwner', edit: { patch: { passiveDefault: false } } }]);
  });

  it('should send the whole settings through writeAsOwner when nothing is held', async () => {
    const { port, calls } = portNoting({ held: false, inEffect: { agent: 'codex', intervalMinutes: 15 } });

    await writeLessonsSettings(port, { passiveDefault: false });

    expect(calls.map(entry => entry.call)).toEqual(['writeAsOwner']);
    const patch = (calls[0]!.edit as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch).sort()).toEqual([...KEYS].sort());
    // what the file states stays stated, the owner's key is the owner's, and an unstated default is removed
    expect(patch).toMatchObject({
      agent: 'codex',
      intervalMinutes: 15,
      passiveDefault: false,
      batchSize: undefined,
    });
  });

  it('M14 should never use a plain write, held or not', async () => {
    for (const held of [true, false]) {
      const { port, calls } = portNoting({ held, inEffect: {} });

      await writeLessonsSettings(port, { passiveDefault: false });

      expect(calls.map(entry => entry.call)).toEqual(['writeAsOwner']);
    }
  });
});
