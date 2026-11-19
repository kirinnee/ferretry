/**
 * Skills' side of the setup import (r9 A5): `put` creates the owner's own item, and refuses in a sentence what it must.
 * The config writer is a recording fake that keeps what it was given (`ifMatch: 'absent'` honoured), so a round trip through
 * the live component source shows the document the import handed over is the one the next read gives.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { SKILLS_CONFIG, type SkillsItem, SkillsItemSchema } from '../../contract/index.ts';
import {
  createSkillsItem,
  MAX_DOCUMENT_BYTES,
  MAX_IMPORTED_SKILLS,
  skillsImportPut,
} from '../../daemon/features/host-import/index.ts';
import { skillsComponentSource } from '../../daemon/lib/profile-component-source.ts';

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function owner(answer?: (name: string, edit: unknown) => ConfigWriteOutcome) {
  const held = new Map<string, SkillsItem>();
  const calls: { name: string | undefined; ifMatch: string | undefined }[] = [];
  const config = {
    write: async (def: unknown, name: string | undefined, edit: unknown, options?: { ifMatch?: string }) => {
      calls.push({ name, ifMatch: options?.ifMatch });
      expect(def).toBe(SKILLS_CONFIG);
      if (answer !== undefined && name !== undefined) return answer(name, edit);
      if (name === undefined || (options?.ifMatch === 'absent' && held.has(name))) return { kind: 'conflict' as const };
      const parsed = SkillsItemSchema.safeParse(JSON.parse(edit as string));
      if (!parsed.success)
        return {
          kind: 'refused' as const,
          reason: 'schema' as const,
          issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
        };
      held.set(name, parsed.data);
      return { kind: 'written' as const, etag: 'e1', loosened: [] };
    },
  };
  const put = skillsImportPut({ has: name => held.has(name), create: createSkillsItem(config) });
  return { held, calls, put, source: skillsComponentSource(() => held) };
}

describe('skills host import: put', () => {
  test('creates the item, pinned to "no file yet", and the live source reads it back', async () => {
    const { put, calls, source } = owner();
    const document = { items: ['pdf', 'review.v2'], harness: 'claude-code' };

    expect(await put('imported', text(document))).toEqual({ ok: true });

    expect(calls).toEqual([{ name: 'imported', ifMatch: 'absent' }]);
    expect(await source.list()).toEqual(['imported']);
    expect(await source.read('imported')).toEqual(document);
  });

  test('a name that is taken is refused and the item is not replaced', async () => {
    const { put, held } = owner();
    await put('mine', text({ items: ['one'] }));

    const second = await put('mine', text({ items: ['two'] }));

    expect(second).toEqual({ ok: false, reason: expect.stringContaining('already exists') });
    expect(held.get('mine')).toEqual({ items: ['one'] });
  });

  test('a file that appears between the look and the write is a refusal, never an overwrite', async () => {
    const { put } = owner(() => ({ kind: 'conflict' }));
    expect(await put('raced', text({ items: ['one'] }))).toEqual({
      ok: false,
      reason: expect.stringContaining('appeared meanwhile'),
    });
  });

  test('a held write is answered as held', async () => {
    const { put } = owner(() => ({ kind: 'held', etag: 'e', id: 'h1', sentences: ['x'] }));
    expect(await put('held', text({ items: ['one'] }))).toEqual({ ok: true, held: true });
  });

  test('an item name that is not a plain safe name is refused before anything is written', async () => {
    const { put, calls } = owner();
    for (const bad of ['', '../x', 'a/b', 'a b', '-x', '.system', 'x'.repeat(200)]) {
      const answered = await put(bad, text({ items: ['one'] }));
      expect(answered.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test('a skill folder that is a path, a dot-folder or a link-like name is refused', async () => {
    const { put, calls } = owner();
    for (const bad of ['.system', '..', '../escape', 'a/b', 'a\\b', '/etc', '~', '', 'x'.repeat(65), 'a..b']) {
      const answered = await put('imported', text({ items: ['fine', bad] }));
      expect(answered).toEqual({ ok: false, reason: expect.stringContaining('folder name Ferretry cannot use') });
    }
    expect(calls).toEqual([]);
  });

  test('bounds: too many skills, an empty selection and an oversized document are refused', async () => {
    const { put, calls } = owner();
    const many = Array.from({ length: MAX_IMPORTED_SKILLS + 1 }, (_, index) => `skill-${index}`);
    const full = Array.from({ length: MAX_IMPORTED_SKILLS }, (_, index) => `skill-${index}`);

    expect((await put('many', text({ items: many }))).ok).toBe(false);
    expect((await put('none', text({ items: [] }))).ok).toBe(false);
    expect((await put('big', ` ${'x'.repeat(MAX_DOCUMENT_BYTES)}`)).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(await put('full', text({ items: full }))).toEqual({ ok: true });
  });

  test('a document that is not a mapping, or not readable, is refused', async () => {
    const { put, calls } = owner();
    for (const bad of ['not json', '[]', 'null', '"text"', '{"items":"pdf"}', '{}'])
      expect((await put('odd', bad)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the config writer's own refusal is a sentence that names the rule, never a value", async () => {
    const { put } = owner();
    const answered = await put('extra', text({ items: ['one'], token: 'ghp_SECRETVALUE123' }));

    expect(answered.ok).toBe(false);
    expect(JSON.stringify(answered)).not.toContain('ghp_SECRETVALUE123');
  });
});
