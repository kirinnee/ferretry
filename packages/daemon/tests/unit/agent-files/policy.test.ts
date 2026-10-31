import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_FILE_LIMITS,
  AgentFileError,
  extensionOf,
  forbiddenInside,
  isWithin,
  lexicalTarget,
  realTarget,
  sanitizeFileName,
  sizeWords,
  uploadSizeProblem,
} from '../../../src/lib/index.ts';

const refusedWith = (work: () => unknown): AgentFileError => {
  try {
    work();
  } catch (error) {
    should(error).be.instanceOf(AgentFileError);
    return error as AgentFileError;
  }
  throw new Error('expected a refusal');
};

describe('agent file policy — which path an agent may name', () => {
  it('should resolve a relative path and an absolute path inside the folder', () => {
    should(lexicalTarget('/work/app', 'reports/q3.pdf')).equal('/work/app/reports/q3.pdf');
    should(lexicalTarget('/work/app', '/work/app/a.txt')).equal('/work/app/a.txt');
    should(lexicalTarget('/work/app', './a.txt')).equal('/work/app/a.txt');
  });

  it('should refuse "..", wherever it sits', () => {
    for (const path of ['../x', 'a/../../x', 'a/..', '..\\x'])
      should(refusedWith(() => lexicalTarget('/work/app', path)).code).equal('forbidden');
  });

  it('should refuse an absolute path outside the folder, and a sibling that shares its prefix', () => {
    should(refusedWith(() => lexicalTarget('/work/app', '/etc/passwd')).code).equal('forbidden');
    should(refusedWith(() => lexicalTarget('/work/app', '/work/app-secrets/key')).code).equal('forbidden');
  });

  it('should refuse anything inside .git at any depth, in any case', () => {
    for (const path of ['.git/config', 'sub/.git/hooks/pre-commit', '.GIT/config'])
      should(refusedWith(() => lexicalTarget('/work/app', path)).message).containEql('.git');
  });

  it('should refuse the daemon’s own scratch entries at the top of the folder, but not the same name deeper', () => {
    should(refusedWith(() => lexicalTarget('/work/app', 'events.jsonl')).code).equal('forbidden');
    should(refusedWith(() => lexicalTarget('/work/app', 'config.json')).message).containEql('belongs to the daemon');
    should(lexicalTarget('/work/app', 'docs/config.json')).equal('/work/app/docs/config.json');
  });

  it('should refuse an empty, control-character or over-long path as a bad request', () => {
    for (const path of ['', 'a\u0000b', 'a\nb', 'x'.repeat(1025)])
      should(refusedWith(() => lexicalTarget('/work/app', path)).code).equal('bad_request');
  });

  it('should refuse a real path that left the folder, and one that landed in .git', () => {
    should(realTarget('/real/app', '/real/app/a.txt')).equal('/real/app/a.txt');
    should(refusedWith(() => realTarget('/real/app', '/real/other/a.txt')).code).equal('forbidden');
    should(refusedWith(() => realTarget('/real/app', '/real/app/.git/HEAD')).code).equal('forbidden');
  });

  it('should compare paths, not strings, when asking whether one is inside another', () => {
    should(isWithin('/a/b', '/a/b')).be.true();
    should(isWithin('/a/b', '/a/b/c')).be.true();
    should(isWithin('/a/b', '/a/bc')).be.false();
    should(isWithin('/a/b', '/a')).be.false();
    should(forbiddenInside('')).be.undefined();
  });
});

describe('agent file policy — names and sizes', () => {
  it('should keep a leaf name, drop leading dots and control characters, and never return a path', () => {
    should(sanitizeFileName('../../etc/passwd', 'f')).equal('passwd');
    should(sanitizeFileName('.bashrc', 'f')).equal('bashrc');
    should(sanitizeFileName('a:b?c.txt', 'f')).equal('a_b_c.txt');
    should(sanitizeFileName('...', 'fallback')).equal('fallback');
    should(sanitizeFileName('dir\\file.pdf', 'f')).equal('file.pdf');
  });

  it('should cut a long name but keep its extension', () => {
    const cut = sanitizeFileName(`${'x'.repeat(300)}.pdf`, 'f');
    should(cut.length).equal(AGENT_FILE_LIMITS.nameChars);
    should(cut.endsWith('.pdf')).be.true();
  });

  it('should read an extension only when it is short and plain', () => {
    should(extensionOf('Report.CSV')).equal('csv');
    should(extensionOf('archive.tar.gz')).equal('gz');
    should(extensionOf('noext')).be.undefined();
    should(extensionOf('.hidden')).be.undefined();
    should(extensionOf('a.b c')).be.undefined();
  });

  it('should hold an upload to 20 files, 50 MiB each and 200 MiB in all', () => {
    const MiB = 1024 * 1024;
    should(uploadSizeProblem([1, 2, 3])).be.undefined();
    should(uploadSizeProblem(Array.from({ length: 21 }, () => 1))).containEql('at most 20 files');
    should(uploadSizeProblem([51 * MiB])).containEql('50 MiB');
    should(uploadSizeProblem([50 * MiB, 50 * MiB, 50 * MiB, 50 * MiB, 1])).containEql('200 MiB');
    should(uploadSizeProblem([50 * MiB, 50 * MiB, 50 * MiB, 50 * MiB])).be.undefined();
  });

  it('should say a size in plain words', () => {
    should(sizeWords(12)).equal('12 B');
    should(sizeWords(1536)).equal('1.5 KiB');
    should(sizeWords(3 * 1024 * 1024)).equal('3.0 MiB');
  });
});
