/**
 * The setup import's skill landing through the REAL installed store (state port over a temp home): what Runtimes hands over
 * (`ComponentPutFile`s, `<item>/<rel>`) ends up in `installed/<skill>/`, where a launch reads it, with the store's own bounds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ComponentPutFile } from '@ferretry/plugin-runtimes/contract';
import { state } from '@ferretry/kernel/host';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';
import { skillsImportPut } from '../../daemon/features/host-import/index.ts';
import { SkillStore } from '../../daemon/lib/skill-store.ts';
import manifest from '../../manifest.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-skill-import-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/skills`, { recursive: true, mode: 0o700 });
  const port = state.createStatePort({
    home,
    pluginId: 'skills',
    files: [SKILLS_INSTALLED_STATE],
    fs: state.createNodeHostFs(),
  });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'skills', worktrees: `${home}-w` },
    [],
    () => undefined,
    { shareTrees: manifest.permissions?.shareTrees === true, stateFiles: manifest.data?.state ?? [], onStop: () => {} },
  );
  const store = new SkillStore(port, { share: async source => await roots.share(source) });
  const items = new Set<string>();
  const put = skillsImportPut({
    has: name => items.has(name),
    etag: async name => (items.has(name) ? 'e1' : 'absent'),
    create: async name => {
      items.add(name);
      return { kind: 'written', etag: 'e1' };
    },
    replace: async () => ({ kind: 'written', etag: 'e1' }),
    store,
  });
  return { put, store, items, disk: `${home}/state/skills/installed` };
}

const document = `${JSON.stringify({ items: ['pdf', 'review'], harness: 'claude' }, null, 2)}\n`;
const handed: readonly ComponentPutFile[] = [
  { path: 'pdf/SKILL.md', content: '---\nname: pdf\n---\nRead PDFs.\n' },
  { path: 'pdf/scripts/run.md', content: 'steps' },
  { path: 'review/SKILL.md', content: '---\nname: review\n---\nReview.\n' },
];

describe("imported skills land in Skills' own installed store", () => {
  test('each skill folder is written under installed/<skill>/ with its own paths, and the store holds it', async () => {
    const { put, store, items, disk } = await world();

    expect(await put('imported', document, handed)).toEqual({
      ok: true,
      created: ['pdf', 'review'],
      etags: { imported: 'e1' },
    });

    expect(items.has('imported')).toBe(true);
    expect(await store.holds('pdf')).toBe(true);
    expect(await store.holds('review')).toBe(true);
    expect([...(await store.paths('pdf'))].toSorted()).toEqual(['SKILL.md', 'scripts/run.md']);
    expect(await readFile(`${disk}/pdf/scripts/run.md`, 'utf8')).toBe('steps');
  });

  test('a skill over the store bound refuses the item with a reason and leaves nothing installed', async () => {
    const { put, store, items } = await world();
    const big: readonly ComponentPutFile[] = [...handed, { path: 'review/huge.md', content: 'x'.repeat(300 * 1024) }];

    const answered = await put('imported', document, big);

    expect(answered).toEqual({ ok: false, reason: expect.stringContaining('256 KiB') });
    expect(items.size).toBe(0);
    expect(await store.holds('pdf')).toBe(false);
    expect(await store.holds('review')).toBe(false);
  });

  test('a skill already installed is left exactly as it is', async () => {
    const { put, store, disk } = await world();
    await store.install('pdf', [{ path: 'SKILL.md', content: 'mine' }]);

    const answered = await put('imported', document, handed);

    expect(answered).toMatchObject({ ok: true, warnings: [expect.stringContaining('"pdf" is already installed')] });
    expect(await readFile(`${disk}/pdf/SKILL.md`, 'utf8')).toBe('mine');
    expect(await store.holds('review')).toBe(true);
  });

  test('a skill installed between the preflight and the write is kept, and the warning names it', async () => {
    const { store, disk } = await world();
    let preflightObserved!: () => void;
    let resumeImport!: () => void;
    const observed = new Promise<void>(resolve => {
      preflightObserved = resolve;
    });
    const resume = new Promise<void>(resolve => {
      resumeImport = resolve;
    });
    const put = skillsImportPut({
      has: () => false,
      create: async () => ({ kind: 'written', etag: 'e1' }),
      etag: async () => 'absent',
      replace: async () => ({ kind: 'written', etag: 'e1' }),
      store: {
        holds: async skill => {
          const held = await store.holds(skill);
          preflightObserved();
          await resume;
          return held;
        },
        install: store.install.bind(store),
        unchangedSinceImport: store.unchangedSinceImport.bind(store),
        uninstall: store.uninstall.bind(store),
      },
    });
    const imported = put('selection', `${JSON.stringify({ items: ['shared'], harness: 'claude' })}`, [
      { path: 'shared/SKILL.md', content: 'import content' },
    ]);
    await observed;
    try {
      await store.install('shared', [{ path: 'SKILL.md', content: 'owner content' }]);
    } finally {
      resumeImport();
    }

    expect(await imported).toMatchObject({
      ok: true,
      warnings: [expect.stringContaining('"shared" is already installed')],
    });
    expect(await readFile(`${disk}/shared/SKILL.md`, 'utf8')).toBe('owner content');
  });
});

describe('an accepted update never overwrites a skill folder the person made or changed', () => {
  const update = { replace: true, owned: ['pdf', 'review'], etags: { imported: 'e1' } } as const;
  const newer: readonly ComponentPutFile[] = [
    { path: 'pdf/SKILL.md', content: 'NEW PDF' },
    { path: 'review/SKILL.md', content: 'NEW REVIEW' },
  ];

  test('folders still as the import left them are rewritten with what the host has now', async () => {
    const { put, disk } = await world();
    await put('imported', document, handed);

    const answered = await put('imported', document, newer, update);

    expect(answered).toMatchObject({ ok: true });
    expect(await readFile(`${disk}/pdf/SKILL.md`, 'utf8')).toBe('NEW PDF');
    expect(await readFile(`${disk}/review/SKILL.md`, 'utf8')).toBe('NEW REVIEW');
  });

  test('a folder deleted and made again by hand under the same name is left exactly as the person wrote it', async () => {
    const { put, disk } = await world();
    await put('imported', document, handed);
    await rm(`${disk}/pdf`, { recursive: true, force: true });
    await mkdir(`${disk}/pdf`, { mode: 0o700 });
    await writeFile(`${disk}/pdf/SKILL.md`, 'MY OWN PDF NOTES');

    const answered = await put('imported', document, newer, update);

    expect(answered).toMatchObject({ ok: true, warnings: [expect.stringContaining('"pdf"')] });
    expect(await readFile(`${disk}/pdf/SKILL.md`, 'utf8')).toBe('MY OWN PDF NOTES');
    expect(await readFile(`${disk}/review/SKILL.md`, 'utf8')).toBe('NEW REVIEW');
  });

  test('a folder the person edited in place after the import is left as it is', async () => {
    const { put, disk } = await world();
    await put('imported', document, handed);
    await writeFile(`${disk}/review/SKILL.md`, 'EDITED IN PLACE');

    const answered = await put('imported', document, newer, update);

    expect(answered).toMatchObject({ ok: true, warnings: [expect.stringContaining('"review"')] });
    expect(await readFile(`${disk}/review/SKILL.md`, 'utf8')).toBe('EDITED IN PLACE');
    expect(await readFile(`${disk}/pdf/SKILL.md`, 'utf8')).toBe('NEW PDF');
  });
});

describe('a folder changed after its digest check is still kept at the moment of replacement', () => {
  test('an owner edit that lands during the preflight of another skill is never written over', async () => {
    const { store, disk, items } = await world();
    const first = skillsImportPut({
      has: name => items.has(name),
      etag: async name => (items.has(name) ? 'e1' : 'absent'),
      create: async name => {
        items.add(name);
        return { kind: 'written', etag: 'e1' };
      },
      replace: async () => ({ kind: 'written', etag: 'e1' }),
      store,
    });
    await first('imported', document, handed);
    const update = { replace: true, owned: ['pdf', 'review'], etags: { imported: 'e1' } } as const;
    const newer: readonly ComponentPutFile[] = [
      { path: 'pdf/SKILL.md', content: 'NEW PDF' },
      { path: 'review/SKILL.md', content: 'NEW REVIEW' },
    ];
    // pdf passes its digest check first; while review is checked, the person edits pdf.
    const put = skillsImportPut({
      has: name => items.has(name),
      etag: async name => (items.has(name) ? 'e1' : 'absent'),
      create: async () => ({ kind: 'written', etag: 'e1' }),
      replace: async () => ({ kind: 'written', etag: 'e1' }),
      store: {
        holds: store.holds.bind(store),
        install: store.install.bind(store),
        uninstall: store.uninstall.bind(store),
        unchangedSinceImport: async skill => {
          const unchanged = await store.unchangedSinceImport(skill);
          if (skill === 'review') await writeFile(`${disk}/pdf/SKILL.md`, 'OWNER EDIT DURING PREFLIGHT');
          return unchanged;
        },
      },
    });

    const answered = await put('imported', document, newer, update);

    expect(answered).toMatchObject({ ok: true, warnings: [expect.stringContaining('"pdf"')] });
    expect(await readFile(`${disk}/pdf/SKILL.md`, 'utf8')).toBe('OWNER EDIT DURING PREFLIGHT');
    expect(await readFile(`${disk}/review/SKILL.md`, 'utf8')).toBe('NEW REVIEW');
  });
});
