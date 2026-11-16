import { describe, it } from 'bun:test';
import should from 'should';
import {
  codeReferenceRelativePath,
  type FileProofClient,
  isOpenableName,
  isOpenablePath,
  resolveFilePaths,
} from '../../contract/file-reference.ts';

interface Asked {
  readonly route: string;
  readonly params: Record<string, string> | undefined;
  readonly query: Record<string, string> | undefined;
}

/** A client that answers each listing by its `path` query (`''` for the root) and records what was asked. */
const listings = (
  byFolder: Readonly<Record<string, unknown>>,
): { readonly client: FileProofClient; readonly asked: Asked[] } => {
  const asked: Asked[] = [];
  const client: FileProofClient = {
    call: async <Result>(
      route: string,
      request?: { params?: Record<string, string>; query?: Record<string, string> },
    ) => {
      asked.push({ route, params: request?.params, query: request?.query });
      const answer = byFolder[request?.query?.path ?? ''];
      if (answer instanceof Error) throw answer;
      return answer as Result;
    },
  };
  return { client, asked };
};

const signal = (): AbortSignal => new AbortController().signal;

describe('isOpenableName / isOpenablePath', () => {
  it('should refuse empty, dot, dot-dot, slash, backslash and control-character names', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\u001fb', 'a\u007fb', null, undefined])
      should(isOpenableName(name)).be.false();
    should(isOpenableName('index.ts')).be.true();
  });

  it('should open a path only when every segment can be opened', () => {
    should(isOpenablePath('src/a.ts')).be.true();
    should(isOpenablePath('src/../a.ts')).be.false();
    should(isOpenablePath('')).be.false();
    should(isOpenablePath(null)).be.false();
  });
});

describe('codeReferenceRelativePath', () => {
  it('should keep a session-relative path and drop a leading ./', () => {
    should(codeReferenceRelativePath('src/a.ts')).equal('src/a.ts');
    should(codeReferenceRelativePath('./src/a.ts')).equal('src/a.ts');
  });

  it('should make an absolute path inside the folder relative', () => {
    should(codeReferenceRelativePath('/repo/src/a.ts', '/repo')).equal('src/a.ts');
    should(codeReferenceRelativePath('/repo/src/a.ts', '/repo/')).equal('src/a.ts');
  });

  it('should refuse an absolute path outside the folder, the folder itself, a sibling prefix and a missing folder', () => {
    should(codeReferenceRelativePath('/elsewhere/a.ts', '/repo')).be.null();
    should(codeReferenceRelativePath('/repo', '/repo')).be.null();
    should(codeReferenceRelativePath('/repository/a.ts', '/repo')).be.null();
    should(codeReferenceRelativePath('/repo/a.ts')).be.null();
    should(codeReferenceRelativePath('/repo/a.ts', 'relative')).be.null();
  });

  it('should refuse a path that climbs or carries a backslash or NUL', () => {
    should(codeReferenceRelativePath('../secret')).be.null();
    should(codeReferenceRelativePath('src/../../secret')).be.null();
    should(codeReferenceRelativePath('src\\a.ts')).be.null();
    should(codeReferenceRelativePath('a\u0000.ts')).be.null();
  });
});

describe('resolveFilePaths', () => {
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'file', ...extra });

  it('should prove a file the folder lists, and ask for the ferret and folder it named', async () => {
    const { client, asked } = listings({ src: { entries: [entry('a.ts')] } });
    const proved = await resolveFilePaths(client, 'f1', ['src/a.ts'], undefined, signal());
    should([...proved]).deepEqual([['src/a.ts', 'src/a.ts']]);
    should(asked).deepEqual([
      { route: 'GET /v1/ferrets/:ferretId/fs', params: { ferretId: 'f1' }, query: { path: 'src' } },
    ]);
  });

  it('should list the root without a path query and prove an absolute path inside the folder', async () => {
    const { client, asked } = listings({ '': { entries: [entry('README.md')] } });
    const proved = await resolveFilePaths(client, 'f1', ['/repo/README.md'], '/repo', signal());
    should([...proved]).deepEqual([['/repo/README.md', 'README.md']]);
    should(asked[0]?.query).be.undefined();
  });

  it('should list each folder once however many files it holds', async () => {
    const { client, asked } = listings({ src: { entries: [entry('a.ts'), entry('b.ts')] } });
    const proved = await resolveFilePaths(client, 'f1', ['src/a.ts', 'src/b.ts', 'src/a.ts'], undefined, signal());
    should(proved.size).equal(2);
    should(asked.length).equal(1);
  });

  it('should not ask about a path that cannot be opened', async () => {
    const { client, asked } = listings({});
    const proved = await resolveFilePaths(client, 'f1', ['../x', '/etc/passwd', 'a\\b'], '/repo', signal());
    should(proved.size).equal(0);
    should(asked).deepEqual([]);
  });

  it('should prove nothing for a missing file, a folder, a denied, ignored or escaping entry', async () => {
    const { client } = listings({
      '': {
        entries: [
          entry('denied', { denied: true }),
          entry('ignored', { ignored: true }),
          entry('escapes', { escapes: true }),
          { name: 'dir', type: 'dir' },
          { name: 'link', type: 'symlink' },
        ],
      },
    });
    const proved = await resolveFilePaths(
      client,
      'f1',
      ['missing', 'denied', 'ignored', 'escapes', 'dir', 'link'],
      undefined,
      signal(),
    );
    should(proved.size).equal(0);
  });

  it('should prove nothing from a refused listing (no filesystem grant), and still prove the other folders', async () => {
    const refused = Object.assign(new Error('forbidden'), { status: 403 });
    const { client } = listings({ locked: refused, open: { entries: [entry('a.ts')] } });
    const proved = await resolveFilePaths(client, 'f1', ['locked/a.ts', 'open/a.ts'], undefined, signal());
    should([...proved]).deepEqual([['open/a.ts', 'open/a.ts']]);
  });

  it('should prove nothing from an answer that is not a listing', async () => {
    const { client } = listings({ '': { entries: 'nope' }, src: null });
    const proved = await resolveFilePaths(client, 'f1', ['a.ts', 'src/a.ts'], undefined, signal());
    should(proved.size).equal(0);
  });

  it('should throw the abort when the caller stopped waiting, before or after the read', async () => {
    const before = new AbortController();
    before.abort();
    const { client } = listings({ '': { entries: [entry('a.ts')] } });
    await resolveFilePaths(client, 'f1', ['a.ts'], undefined, before.signal).then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(DOMException),
    );
    const during = new AbortController();
    const slow: FileProofClient = {
      call: async <Result>() => {
        during.abort();
        return { entries: [entry('a.ts')] } as Result;
      },
    };
    await resolveFilePaths(slow, 'f1', ['a.ts'], undefined, during.signal).then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(DOMException),
    );
    const failing: FileProofClient = {
      call: async () => {
        during.abort();
        throw new Error('boom');
      },
    };
    await resolveFilePaths(failing, 'f1', ['a.ts'], undefined, during.signal).then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(DOMException),
    );
  });
});
