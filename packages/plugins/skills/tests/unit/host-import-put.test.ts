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
  replaceSkillsItem,
  type ImportedSkillFile,
  MAX_DOCUMENT_BYTES,
  MAX_IMPORTED_SKILLS,
  skillsImportPut,
} from '../../daemon/features/host-import/index.ts';
import { InstalledSkillRefused } from '../../daemon/lib/skill-store.ts';
import { skillsComponentSource } from '../../daemon/lib/profile-component-source.ts';

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** What Runtimes hands over for the named skills: each one's folder as `<skill>/<path>` text files, with a SKILL.md. */
const folders = (...skills: string[]): ImportedSkillFile[] =>
  skills.flatMap(skill => [
    { path: `${skill}/SKILL.md`, content: `---\nname: ${skill}\n---\nDo ${skill}.\n` },
    { path: `${skill}/notes/more.md`, content: 'more' },
  ]);

function owner(answer?: (name: string, edit: unknown) => ConfigWriteOutcome, failInstall?: string) {
  const held = new Map<string, SkillsItem>();
  // The file's version moves when the person edits it (`edit()`): the etag is `etag-<name>`, then `etag-<name>-<n>`.
  let revision = 0;
  const etagOf = (name: string): string => `etag-${name}${revision === 0 ? '' : `-${String(revision)}`}`;
  let whileInstalling: () => void = () => undefined;
  const calls: { name: string | undefined; ifMatch: string | undefined }[] = [];
  const config = {
    etag: async (_def: unknown, name?: string) => (name !== undefined && held.has(name) ? etagOf(name) : 'absent'),
    write: async (def: unknown, name: string | undefined, edit: unknown, options?: { ifMatch?: string }) => {
      calls.push({ name, ifMatch: options?.ifMatch });
      expect(def).toBe(SKILLS_CONFIG);
      if (answer !== undefined && name !== undefined) return answer(name, edit);
      if (name === undefined || (options?.ifMatch === 'absent' && held.has(name))) return { kind: 'conflict' as const };
      if (options?.ifMatch !== undefined && options.ifMatch !== 'absent' && options.ifMatch !== etagOf(name))
        return { kind: 'conflict' as const };
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
  // A fake of Skills' installed store: it keeps what `install` was given and refuses what the real one refuses to.
  const installed = new Map<string, readonly { path: string; content: string }[]>();
  const removed: string[] = [];
  // What the last import wrote into each skill folder (the real store keeps a digest of it).
  const stamped = new Map<string, readonly { path: string; content: string }[]>();
  const store = {
    unchangedSinceImport: async (skill: string) =>
      JSON.stringify(installed.get(skill)) === JSON.stringify(stamped.get(skill)),
    holds: async (skill: string) => installed.has(skill),
    install: async (
      skill: string,
      files: readonly { path: string; content: string }[],
      options?: { createOnly?: boolean; stamp?: boolean },
    ) => {
      if (failInstall === skill) throw new InstalledSkillRefused('the store said no');
      installed.set(skill, files);
      if (options?.stamp === true) stamped.set(skill, files);
      whileInstalling();
    },
    uninstall: async (skill: string) => {
      removed.push(skill);
      installed.delete(skill);
    },
  };
  const put = skillsImportPut({
    has: name => held.has(name),
    etag: async name => (held.has(name) ? etagOf(name) : 'absent'),
    create: createSkillsItem(config),
    replace: replaceSkillsItem(config),
    store,
  });
  return {
    held,
    calls,
    put,
    installed,
    removed,
    stamped,
    source: skillsComponentSource(() => held),
    /** The person edits the selection file. */
    edit: () => {
      revision += 1;
    },
    /** Runs while the folders are being written (after the preflight, before the selection is written). */
    during: (action: () => void) => {
      whileInstalling = action;
    },
  };
}

describe('skills host import: put', () => {
  test('creates the item, pinned to "no file yet", and the live source reads it back', async () => {
    const { put, calls, source } = owner();
    const document = { items: ['pdf', 'review.v2'], harness: 'claude-code' };

    expect(await put('imported', text(document), folders('pdf', 'review.v2'))).toEqual({
      ok: true,
      created: ['pdf', 'review.v2'],
      etags: { imported: 'e1' },
    });

    expect(calls).toEqual([{ name: 'imported', ifMatch: 'absent' }]);
    expect(await source.list()).toEqual(['imported']);
    expect(await source.read('imported')).toEqual(document);
  });

  test('an update the person accepted replaces the item, pinned to its etag, and installs only the new skill', async () => {
    const { put, held, calls, installed } = owner();
    await put('mine', text({ items: ['one'], harness: 'claude-code' }), folders('one'));
    calls.length = 0;

    const answered = await put('mine', text({ items: ['one', 'two'], harness: 'claude-code' }), folders('one', 'two'), {
      replace: true,
      owned: ['one'],
      etags: { mine: 'etag-mine' },
    });

    expect(answered).toEqual({ ok: true, created: ['two'], etags: { mine: 'e1' } });
    expect(calls).toEqual([{ name: 'mine', ifMatch: 'etag-mine' }]);
    expect(held.get('mine')?.items).toEqual(['one', 'two']);
    expect([...installed.keys()].toSorted()).toEqual(['one', 'two']);
  });

  test('an update rewrites the files of a skill an import installed, and leaves one it did not install alone', async () => {
    const { put, installed } = owner();
    const first = await put('mine', text({ items: ['one'] }), folders('one'));
    expect(first).toEqual({ ok: true, created: ['one'], etags: { mine: 'e1' } });
    installed.set('theirs', [{ path: 'SKILL.md', content: 'the person made this' }]);
    const changed = [{ path: 'one/SKILL.md', content: '---\nname: one\n---\nNEW TEXT\n' }, ...folders('theirs')];

    const answered = await put('mine', text({ items: ['one', 'theirs'] }), changed, {
      replace: true,
      owned: ['one'],
      etags: { mine: 'etag-mine' },
    });

    expect(answered).toEqual({
      ok: true,
      etags: { mine: 'e1' },
      warnings: ['"theirs" is already installed here and was not brought in by an import, so it was left as it is'],
    });
    expect(installed.get('one')).toEqual([{ path: 'SKILL.md', content: '---\nname: one\n---\nNEW TEXT\n' }]);
    expect(installed.get('theirs')).toEqual([{ path: 'SKILL.md', content: 'the person made this' }]);
  });

  test('an update still refuses a skill the owner has not been given files for, and a first import never replaces', async () => {
    const { put, held } = owner();
    await put('mine', text({ items: ['one'] }), folders('one'));

    expect(
      await put('mine', text({ items: ['one', 'two'] }), folders('one'), {
        replace: true,
        etags: { mine: 'etag-mine' },
      }),
    ).toEqual({
      ok: false,
      reason: 'the files of the skill "two" were not handed over, so it was not imported',
    });
    expect(held.get('mine')?.items).toEqual(['one']);
    expect((await put('mine', text({ items: ['one', 'two'] }), folders('one', 'two'))).ok).toBe(false);
    expect(held.get('mine')?.items).toEqual(['one']);
  });

  test('a name that is taken is refused and the item is not replaced', async () => {
    const { put, held } = owner();
    await put('mine', text({ items: ['one'] }), folders('one'));

    const second = await put('mine', text({ items: ['two'] }), folders('two'));

    expect(second).toEqual({ ok: false, reason: expect.stringContaining('already exists') });
    expect(held.get('mine')).toEqual({ items: ['one'] });
  });

  test('a file that appears between the look and the write is a refusal, never an overwrite', async () => {
    const { put, installed, removed } = owner(() => ({ kind: 'conflict' }));
    expect(await put('raced', text({ items: ['one'] }), folders('one'))).toEqual({
      ok: false,
      reason: expect.stringContaining('appeared meanwhile'),
    });
    expect(installed.size).toBe(0);
    expect(removed).toEqual(['one']);
  });

  test('a held write is answered as held', async () => {
    const { put } = owner(() => ({ kind: 'held', etag: 'e', id: 'h1', sentences: ['x'] }));
    expect(await put('held', text({ items: ['one'] }), folders('one'))).toEqual({
      ok: true,
      held: true,
      created: ['one'],
      etags: { held: 'e' },
    });
  });

  test('an update leaves a selection made again by hand under the same name as it is', async () => {
    const { put, held } = owner();
    await put('mine', text({ items: ['one'] }), folders('one'));

    const answered = await put('mine', text({ items: ['one', 'two'] }), folders('one', 'two'), {
      replace: true,
      owned: ['one'],
      etags: { mine: 'the-etag-of-the-file-the-import-wrote' },
    });

    expect(answered.ok).toBe(false);
    expect(held.get('mine')?.items).toEqual(['one']);
  });

  test('an update is pinned to the etag it verified: an edit of the selection during the folder work is a conflict, never an overwrite', async () => {
    const { put, held, edit, during } = owner();
    await put('mine', text({ items: ['one'] }), folders('one'));
    // The person edits the selection file after the owner has checked it and before it writes.
    during(edit);

    const answered = await put('mine', text({ items: ['one', 'two'] }), folders('one', 'two'), {
      replace: true,
      owned: ['one'],
      etags: { mine: 'etag-mine' },
    });

    expect(answered).toEqual({ ok: false, reason: expect.stringContaining('appeared meanwhile') });
    expect(held.get('mine')?.items).toEqual(['one']);
  });

  test('an update leaves a folder an import wrote but the person changed since, and rewrites one still as it was left', async () => {
    const { put, installed } = owner();
    await put('mine', text({ items: ['one', 'two'] }), folders('one', 'two'));
    installed.set('one', [{ path: 'SKILL.md', content: 'edited by the person' }]);
    const changed = [
      { path: 'one/SKILL.md', content: 'NEW ONE' },
      { path: 'two/SKILL.md', content: 'NEW TWO' },
    ];

    const answered = await put('mine', text({ items: ['one', 'two'] }), changed, {
      replace: true,
      owned: ['one', 'two'],
      etags: { mine: 'etag-mine' },
    });

    expect(answered).toMatchObject({
      ok: true,
      warnings: [expect.stringContaining('"one" was changed after the import wrote it, so it was left as it is')],
    });
    expect(installed.get('one')).toEqual([{ path: 'SKILL.md', content: 'edited by the person' }]);
    expect(installed.get('two')).toEqual([{ path: 'SKILL.md', content: 'NEW TWO' }]);
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

    expect((await put('many', text({ items: many }), folders(...many))).ok).toBe(false);
    expect((await put('none', text({ items: [] }))).ok).toBe(false);
    expect((await put('big', ` ${'x'.repeat(MAX_DOCUMENT_BYTES)}`)).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(await put('full', text({ items: full }), folders(...full))).toMatchObject({ ok: true });
  });

  test('a document that is not a mapping, or not readable, is refused', async () => {
    const { put, calls } = owner();
    for (const bad of ['not json', '[]', 'null', '"text"', '{"items":"pdf"}', '{}'])
      expect((await put('odd', bad)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the config writer's own refusal is a sentence that names the rule, never a value", async () => {
    const { put } = owner();
    const answered = await put('extra', text({ items: ['one'], token: 'ghp_SECRETVALUE123' }), folders('one'));

    expect(answered.ok).toBe(false);
    expect(JSON.stringify(answered)).not.toContain('ghp_SECRETVALUE123');
  });

  test("the skill folders land in Skills' installed store, each under its own name with the skill folder taken off the path", async () => {
    const { put, installed } = owner();

    expect(await put('imported', text({ items: ['pdf', 'review'] }), folders('pdf', 'review'))).toMatchObject({
      ok: true,
    });

    expect([...installed.keys()]).toEqual(['pdf', 'review']);
    expect(installed.get('pdf')?.map(file => file.path)).toEqual(['SKILL.md', 'notes/more.md']);
  });

  test('a skill already installed here is left as it is, and the answer says so', async () => {
    const { put, installed } = owner();
    installed.set('pdf', [{ path: 'SKILL.md', content: 'mine' }]);

    const answered = await put('imported', text({ items: ['pdf', 'review'] }), folders('review'));

    expect(answered).toMatchObject({ ok: true, warnings: [expect.stringContaining('"pdf" is already installed')] });
    expect(installed.get('pdf')).toEqual([{ path: 'SKILL.md', content: 'mine' }]);
    expect(installed.has('review')).toBe(true);
  });

  test("a skill over the installed store's bounds refuses the whole item with the reason, and nothing is installed", async () => {
    const { put, installed, held } = owner();
    const huge = [{ path: 'one/SKILL.md', content: 'x'.repeat(300 * 1024) }];
    const many = [
      { path: 'one/SKILL.md', content: 'ok' },
      ...Array.from({ length: 200 }, (_, index) => ({ path: `one/f${index}.md`, content: 'x' })),
    ];
    const total = Array.from({ length: 9 }, (_, index) => ({
      path: `one/f${index}.md`,
      content: 'x'.repeat(250 * 1024),
    }));

    for (const [files, rule] of [
      [huge, '256 KiB'],
      [many, '1 to 200 files'],
      [[...total, { path: 'one/SKILL.md', content: 'ok' }], '2 MiB'],
    ] as const) {
      const answered = await put('imported', text({ items: ['two', 'one'] }), [...folders('two'), ...files]);
      expect(answered).toEqual({ ok: false, reason: expect.stringContaining(rule) });
    }
    expect(installed.size).toBe(0);
    expect(held.size).toBe(0);
  });

  test('a skill with no SKILL.md, a path that leaves the folder or a skill nobody sent files for is refused', async () => {
    const { put, installed } = owner();

    const noEntry = await put('a', text({ items: ['one'] }), [{ path: 'one/readme.md', content: 'x' }]);
    const leaves = await put('b', text({ items: ['one'] }), [
      { path: 'one/SKILL.md', content: 'x' },
      { path: 'one/../../etc/passwd', content: 'x' },
    ]);
    const system = await put('c', text({ items: ['one'] }), [
      { path: 'one/SKILL.md', content: 'x' },
      { path: 'one/.system/x', content: 'x' },
    ]);
    const unsent = await put('d', text({ items: ['one'] }));

    for (const answered of [noEntry, leaves, system, unsent]) expect(answered.ok).toBe(false);
    expect(installed.size).toBe(0);
  });

  test('a skill the store refuses part-way undoes the ones already installed and writes no item', async () => {
    const { put, installed, removed, held } = owner(undefined, 'two');

    const answered = await put('imported', text({ items: ['one', 'two'] }), folders('one', 'two'));

    expect(answered).toEqual({
      ok: false,
      reason: expect.stringContaining('"two" was not imported: the store said no'),
    });
    expect(removed).toEqual(['one']);
    expect(installed.size).toBe(0);
    expect(held.size).toBe(0);
  });

  test('a refused item write takes its newly installed skills back out', async () => {
    const { put, installed, removed } = owner();

    const answered = await put('extra', text({ items: ['one'], token: 'x' }), folders('one'));

    expect(answered.ok).toBe(false);
    expect(removed).toEqual(['one']);
    expect(installed.size).toBe(0);
  });

  test("Runtimes' harness word is written as the schema's key: Claude-only and Codex-only items round-trip", async () => {
    const { put, source } = owner();

    await put('claude-only', text({ items: ['one'], harness: 'claude' }), folders('one'));
    await put('codex-only', text({ items: ['two'], harness: 'codex' }), folders('two'));
    await put('keyed', text({ items: ['three'], harness: 'claude-code' }), folders('three'));

    expect(await source.read('claude-only')).toEqual({ items: ['one'], harness: 'claude-code' });
    expect(await source.read('codex-only')).toEqual({ items: ['two'], harness: 'codex' });
    expect(await source.read('keyed')).toEqual({ items: ['three'], harness: 'claude-code' });
  });

  test('a harness word nobody knows is refused and nothing is installed or written', async () => {
    const { put, installed, calls } = owner();

    for (const harness of ['vim', 'constructor', 7])
      expect((await put('odd', text({ items: ['one'], harness }), folders('one'))).ok).toBe(false);

    expect(installed.size).toBe(0);
    expect(calls).toEqual([]);
  });
});
