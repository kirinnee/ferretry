import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RATCHETED_WORDS, glossaryFindings } from './glossary.ts';
import {
  ALLOWLIST_FILE,
  Counter,
  parseAllowlist,
  lineHash,
  pendingPathOf,
  scanSource,
  scopeOf,
  vocabularyReport,
} from './vocabulary.ts';

/** The old word and its new one, read from the glossary's own map so no sentence here spells the old one by hand. */
const [[OLD, NEW]] = [...RATCHETED_WORDS] as [[string, string]];
const OLD_PLURAL = `${OLD}s`;
const say = (text: string): string => text.replaceAll('OLD', OLD).replaceAll('PLURAL', OLD_PLURAL);

const TMP = join(import.meta.dir, '..', 'gen', 'tests', '.tmp');
let counter = 0;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fixture workspace: one plugin `x` (a package) plus whatever files the test writes. */
function tree(files: Readonly<Record<string, string>> = {}): string {
  const root = join(TMP, `vocab${process.pid}-${++counter}`);
  rmSync(root, { recursive: true, force: true });
  made.push(root);
  const write = (rel: string, text: string): void => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('package.json', JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/plugins/*'] }));
  write('packages/plugins/x/package.json', JSON.stringify({ name: '@fixture/x', ferretry: { id: 'x' } }));
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return root;
}

const WORDS = [...RATCHETED_WORDS.keys(), ...RATCHETED_WORDS.values()];
/** The ledger files (path to body) of a scope's hits, one per line of text, as the check names them: `<file>-<hash>`, `__2` for a repeat. */
const ledger = (scope: string, file: string, lines: readonly string[]): Record<string, string> => {
  const stem = (file.split('/').pop() ?? '').replace(/\.[^.]*$/u, '');
  const seen = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const line of lines) {
    const name = `${stem}-${lineHash(line, WORDS)}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out[`${pendingPathOf(scope)}${n === 1 ? name : `${name}__${n}`}.txt`] = `${file}\n${line}\n`;
  }
  return out;
};
const noBase = 'file:/nonexistent-vocabulary-base';
const messages = async (root: string, base = noBase): Promise<string[]> =>
  (await vocabularyReport(root, undefined, base)).findings.map(f => `${f.where}: ${f.message}`);

describe('what is scanned', () => {
  test('a clean tree has no finding and no pending file', async () => {
    const root = tree({
      'packages/plugins/x/manifest.ts': "export default { title: 'Board', summary: 'Show the work' };\n",
      'docs/guide.md': 'Say task.\n',
    });
    expect(await messages(root)).toEqual([]);
  });

  test('a new old word in a manifest summary fails, and the finding says where', async () => {
    const root = tree({
      'packages/plugins/x/manifest.ts': say("export default { summary: 'Move a OLD to a lane' };\n"),
    });
    const found = await messages(root);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('packages/plugins/x');
    expect(found[0]).toContain('packages/plugins/x/manifest.ts:1');
    expect(found[0]).toContain(`"${OLD}" → "${NEW}"`);
  });

  test('a one-word owner text by position counts: a summary, a label, a describe argument, an aria-label', async () => {
    const root = tree({
      'packages/plugins/x/manifest.ts': say(
        "export default { summary: 'PLURAL', label: 'OLD' };\nexport const a = z.string().describe('OLD');\n",
      ),
      'packages/plugins/x/app/view.tsx': say('export const V = () => <i aria-label="OLD" />;\n'),
    });
    const found = await messages(root);
    expect(found.join('\n')).toContain('4 hits');
  });

  test('a docs line fails; the same line in a history folder does not', async () => {
    const root = tree({ 'docs/guide.md': say('Open the OLD.\n') });
    expect((await messages(root)).join('\n')).toContain('docs: 1 hit');
    const history = tree({
      'docs/design/old.md': say('Open the OLD.\n'),
      'docs/rebuild/log.md': say('Open the OLD.\n'),
      'docs/migration/v4.md': say('Open the OLD.\n'),
      'Changelog.md': say('- the OLD.\n'),
      'Changelog.old.md': say('- the OLD.\n'),
      'handover.md': say('the OLD.\n'),
    });
    expect(await messages(history)).toEqual([]);
  });

  test('a frozen v4 reader (a src/v4 folder) is not read', async () => {
    const root = tree({ 'migration/tool/src/v4/frozen.ts': say("export const m = 'Open the OLD.';\n") });
    expect(await messages(root)).toEqual([]);
  });

  test('root docs, a package README, instructions and a skill are read', async () => {
    const root = tree({
      'README.md': say('a OLD\n'),
      'packages/plugins/x/README.md': say('a OLD\n'),
      'packages/plugins/x/instructions/x.md': say('a OLD\n'),
      '.claude/skills/s/SKILL.md': say('a OLD\n'),
    });
    const found = (await messages(root)).join('\n');
    for (const scope of ['.: 1 hit', 'packages/plugins/x: 2 hits', '.claude: 1 hit']) expect(found).toContain(scope);
  });

  test('JSX text fails; a class name, an id, an identifier, a comment and a bare id string do not', async () => {
    const text = tree({
      'packages/plugins/x/app/view.tsx': say('export const V = () => <p>Your OLD is here</p>;\n'),
    });
    expect((await messages(text)).join('\n')).toContain('packages/plugins/x/app/view.tsx:1');
    const quiet = tree({
      'packages/plugins/x/app/view.tsx': say(
        [
          '// the OLD is a comment',
          'const OLDId = 1;',
          "const key = 'OLD';",
          "const route = '/v1/board/PLURAL/:id';",
          'export const V = () => <p className="fy-OLD open" id="OLD" data-x="a OLD" />;',
          "export const W = () => <p className={cn('fy-attn-OLD open')} />;",
          '',
        ].join('\n'),
      ),
    });
    expect(await messages(quiet)).toEqual([]);
  });

  test('a sentence string and a template literal fail; an import path, a type and a tagged style do not', async () => {
    const root = tree({
      'packages/plugins/x/daemon/a.ts': say(
        [
          "import x from './a OLD';",
          "type T = 'a OLD' | `b ${string}`;",
          'const css = (s: TemplateStringsArray) => s;',
          'export const style = css`.fy-attn-OLD { color: red }`;',
          '',
        ].join('\n'),
      ),
    });
    expect(await messages(root)).toEqual([]);
    const planted = tree({
      'packages/plugins/x/daemon/a.ts': say(
        "export const a = 'No OLD named ' + b;\nexport const c = `Got ${n} PLURAL`;\n",
      ),
    });
    expect((await messages(planted)).join('\n')).toContain('2 hits');
  });

  test('tests, generated output and fixtures are not scanned', async () => {
    const line = say("export const a = 'Open the OLD';\n");
    const root = tree({
      'packages/plugins/x/tests/unit/a.test.ts': line,
      'packages/plugins/x/daemon/a.test.ts': line,
      'packages/plugins/x/contract/testing/fake.ts': line,
      'packages/plugins/x/daemon/generated/g.ts': line,
      'packages/plugins/x/fixtures/f.ts': line,
    });
    expect(await messages(root)).toEqual([]);
  });

  test('scripts and migration are read as their own scopes', async () => {
    const line = say("console.log('Open the OLD');\n");
    const root = tree({ 'scripts/a.ts': line, 'migration/b/src/c.ts': line });
    const found = (await messages(root)).join('\n');
    expect(found).toContain('scripts: 1 hit');
    expect(found).toContain('migration: 1 hit');
  });

  test('a reviewed phrase passes; the bare word beside it still counts', async () => {
    const root = tree({ 'docs/guide.md': say('Pay with a payment OLD or a credit OLD. Enter the OLD number.\n') });
    expect(await messages(root)).toEqual([]);
    const beside = tree({ 'docs/guide.md': say('a payment OLD, not a plain OLD\n') });
    expect((await messages(beside)).join('\n')).toContain('docs: 1 hit');
  });

  test('an old spelling kept on purpose is skipped by file#CONSTANT; every other string still counts', () => {
    const root = tree({
      'packages/plugins/x/a.ts': say(
        "export const oldSpelling = 'the OLD verb';\nexport const other = 'the OLD verb';\n",
      ),
    });
    const counterOf = new Counter([OLD]);
    const file = join(root, 'packages/plugins/x/a.ts');
    const kept = new Map([['packages/plugins/x/a.ts#oldSpelling', 'the alias reads the old verb']]);
    expect(scanSource(file, 'packages/plugins/x/a.ts', counterOf, kept).map(o => o.line)).toEqual([2]);
    expect(scanSource(file, 'packages/plugins/x/a.ts', counterOf, new Map()).map(o => o.line)).toEqual([1, 2]);
  });
});

describe('the allowlist', () => {
  const tsv = (rows: string[]): string => `# header\n${rows.join('\n')}\n`;

  test('a whitespace-free token a sentence quotes is not counted; a dead token is a finding', async () => {
    const root = tree({
      [ALLOWLIST_FILE]: tsv([`${OLD}-agenda:\tstored ref prefix\tstored`]),
      'docs/guide.md': say('The ref starts with OLD-agenda: and nothing else.\n'),
    });
    expect(await messages(root)).toEqual([]);
    const dead = tree({ [ALLOWLIST_FILE]: tsv([`${OLD}-agenda:\tstored ref prefix\tstored`]) });
    expect((await messages(dead)).join('\n')).toContain('is in no scanned text: remove it');
  });

  test('a row that is malformed, has no reason, has a bad "until", or repeats a token is a finding', () => {
    const { entries, findings } = parseAllowlist(
      tsv([
        'a b\tr\tstored',
        'tok\t\tstored',
        'tok\treason\tsoon',
        'only-two\tcols',
        'ok\treason\tstep2',
        'OK\treason\tstep2',
      ]),
    );
    expect(entries.map(e => e.token)).toEqual(['ok']);
    expect(findings.map(f => f.message).join('\n')).toMatch(
      /whitespace-free[\s\S]*no reason[\s\S]*soon[\s\S]*token<TAB>[\s\S]*twice/,
    );
  });
});

describe('the ratchet', () => {
  const line = say('the OLD sits here');
  const names = (scope: string, file: string, count: number): Record<string, string> =>
    ledger(
      scope,
      file,
      Array.from({ length: count }, () => line),
    );
  const text = (hits: number): string => `${Array.from({ length: hits }, () => line).join('\n')}\n`;

  test('a hit with its file passes', async () => {
    const root = tree({ 'docs/guide.md': text(2), ...names('docs', 'docs/guide.md', 2) });
    expect(await messages(root)).toEqual([]);
  });

  test('a hit with no file fails (growth), and a scope with no folder says so', async () => {
    const grown = tree({ 'docs/guide.md': text(3), ...names('docs', 'docs/guide.md', 2) });
    expect((await messages(grown)).join('\n')).toContain('1 hit of');
    expect((await messages(grown)).join('\n')).toContain('with no file in docs/vocabulary-pending/');
    const none = tree({ 'docs/guide.md': text(1) });
    expect((await messages(none)).join('\n')).toContain('with no file in docs/vocabulary-pending/');
  });

  test('a fixed hit leaves a file with no hit: the check names it and says git rm', async () => {
    const dropped = tree({ 'docs/guide.md': text(1), ...names('docs', 'docs/guide.md', 2) });
    const found = await messages(dropped);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^docs\/vocabulary-pending\/guide-[0-9a-f]{8}__2\.txt: holds a hit that is gone: git rm this file$/u,
    );
    const gone = tree({ 'docs/guide.md': 'Say task.\n', ...names('docs', 'docs/guide.md', 2) });
    expect(await messages(gone)).toHaveLength(2);
  });

  test('a line still holding one of two old words keeps its hash: fixing one hit leaves one file to remove', async () => {
    const two = say('the OLD and the OLD');
    const half = say('the OLD and the NEW');
    const before = ledger('docs', 'docs/guide.md', [two, two]);
    expect(Object.keys(before)).toHaveLength(2);
    const root = tree({ 'docs/guide.md': `${half.replace('NEW', NEW)}\n`, ...before });
    // one hit left in the line, two files: exactly one is stale
    expect((await messages(root)).filter(m => m.includes('is gone'))).toHaveLength(1);
  });

  test('moving a file keeps its ledger: the path is not in the name', async () => {
    const root = tree({ 'docs/other-name.md': text(1), ...names('docs', 'docs/guide.md', 1) });
    const renamed = (await messages(root)).join('\n');
    // the file stem is only for people: the same line under another file name still matches by hash
    expect(renamed).not.toContain('with no file');
  });

  test('a file the base does not hold fails, even when the tree matches its folder', async () => {
    const root = tree({ 'docs/guide.md': text(2), ...names('docs', 'docs/guide.md', 2) });
    const base = tree(names('docs', 'docs/guide.md', 1));
    const found = (await messages(root, `file:${base}`)).join('\n');
    expect(found).toMatch(/guide-[0-9a-f]{8}__2\.txt: is not in the base: the ledger may only lose files/u);
    const equal = tree(names('docs', 'docs/guide.md', 2));
    expect(await messages(root, `file:${equal}`)).toEqual([]);
  });

  test('a scope the base has no folder for holds nothing there, so a new folder fails; a base with no ledger at all is not compared', async () => {
    const root = tree({
      'docs/guide.md': text(1),
      ...names('docs', 'docs/guide.md', 1),
      'scripts/a.ts': say("console.log('the OLD sits here');\n"),
      ...ledger('scripts', 'scripts/a.ts', [say("console.log('the OLD sits here');")]),
    });
    const base = tree(names('docs', 'docs/guide.md', 1));
    const found = (await messages(root, `file:${base}`)).join('\n');
    expect(found).toContain('scripts/vocabulary-pending/a-');
    expect(found).toContain('is not in the base');
    expect(found).not.toContain('docs/vocabulary-pending/');
    expect(await messages(root)).toEqual([]);
  });

  test('a base that still holds the old count file only caps the number of files', async () => {
    const root = tree({ 'docs/guide.md': text(2), ...names('docs', 'docs/guide.md', 2) });
    const git = (...args: string[]): void => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      if (run.status !== 0) throw new Error(run.stderr);
    };
    git('init', '-q');
    writeFileSync(join(root, 'docs/vocabulary-pending.json'), '{"format":1,"count":1}\n');
    git('add', 'docs/vocabulary-pending.json');
    git('commit', '-q', '-m', 'base');
    rmSync(join(root, 'docs/vocabulary-pending.json'));
    expect((await messages(root, 'HEAD')).join('\n')).toContain('holds 2 files but the base held 1');
    writeFileSync(join(root, 'docs/vocabulary-pending.json'), '{"format":1,"count":2}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base2');
    rmSync(join(root, 'docs/vocabulary-pending.json'));
    expect((await messages(root, 'HEAD')).join('\n')).not.toContain('base held');
  });

  test('a folder outside the rule, a file that is no ledger file, and the retired count file are findings', async () => {
    const stray = tree({ 'packages/plugins/x/app/vocabulary-pending/a-0123abcd.txt': 'x\n' });
    expect((await messages(stray)).join('\n')).toContain('is outside the rule');
    const bad = tree({
      'docs/vocabulary-pending/notes.md': 'x\n',
      'docs/vocabulary-pending/Bad Name.txt': 'x\n',
      'docs/vocabulary-pending/deeper/a-0123abcd.txt': 'x\n',
      'docs/vocabulary-pending.json': '{"format":1,"count":1}\n',
    });
    const found = (await messages(bad)).join('\n');
    expect(found).toContain('docs/vocabulary-pending/notes.md: is no ledger file');
    expect(found).toContain('docs/vocabulary-pending/Bad Name.txt: is no ledger file');
    expect(found).toContain('a ledger folder holds files only');
    expect(found).toContain('docs/vocabulary-pending.json: is the retired count file');
  });

  test('--package reads one scope only', async () => {
    const root = tree({
      'packages/plugins/x/manifest.ts': say("export default { summary: 'a OLD' };\n"),
      'docs/guide.md': text(5),
    });
    expect((await vocabularyReport(root, undefined, noBase)).findings).toHaveLength(2);
    const scoped = (await vocabularyReport(root, 'x', noBase)).findings;
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.where).toBe('packages/plugins/x');
  });
});

describe('scopes', () => {
  test('a file belongs to its package, else its first folder, else the root', () => {
    const packages = ['packages/plugins/board', 'packages/app'];
    expect(scopeOf('packages/plugins/board/app/a.tsx', packages)).toBe('packages/plugins/board');
    expect(scopeOf('docs/board.md', packages)).toBe('docs');
    expect(scopeOf('.claude/skills/s/SKILL.md', packages)).toBe('.claude');
    expect(scopeOf('README.md', packages)).toBe('.');
    expect(pendingPathOf('.')).toBe('vocabulary-pending/');
    expect(pendingPathOf('docs')).toBe('docs/vocabulary-pending/');
  });
});

describe('the glossary hands the old word to the ratchet', () => {
  const index = new Map([
    [OLD, NEW],
    ['ticket', NEW],
  ]);
  test('the old word does not fail glossary; the other "instead of" word still does', () => {
    expect(glossaryFindings('x', say('Move the OLD'), index)).toEqual([]);
    expect(glossaryFindings('x', 'Open a ticket', index)).toHaveLength(1);
  });
  test('the reviewed payment phrases pass the glossary too', () => {
    const strict = new Map([['payment', 'x']]);
    expect(glossaryFindings('x', say('a payment OLD'), strict)).toEqual([]);
  });
});

describe('this repository', () => {
  test('is at its own ledger', async () => {
    const root = join(import.meta.dir, '..', '..');
    const found = (await vocabularyReport(root, undefined, noBase)).findings;
    expect(found.map(f => `${f.where}: ${f.message}`)).toEqual([]);
  }, 120_000);
});
