import { describe, it } from 'bun:test';
import should from 'should';
import { FilesystemController } from '../../../src/lib/filesystem/controller.ts';
import { CapturingOutput, changesView, fileView, listing, RecordingFilesystemGateway } from './fixtures.ts';

function controller(gateway = new RecordingFilesystemGateway()) {
  const out = new CapturingOutput();
  return { subject: new FilesystemController(gateway, out), gateway, out };
}

describe('filesystem controller', () => {
  it('should render a listing and every safety badge', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.list('ses-1', 'src', {});

    // Assert
    should(out.messages[0]).containEql('/work/repo:src');
    should(out.messages[0]).containEql('app.ts');
    should(out.messages[0]).containEql('[denied] [ignored] [escapes]');
  });

  it('should read HEAD on request and emit schema-parsed JSON', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.file('ses-1', 'src/app.ts', { head: true, json: true });

    // Assert
    should(gateway.calls[0]).deepEqual({ method: 'file', args: ['ses-1', 'src/app.ts', 'head'] });
    should(JSON.parse(out.messages[0] ?? '')).deepEqual(fileView);
  });

  it('should render changes and raw diffs', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.changes('ses-1', {});
    await subject.diff('ses-1', 'src/app.ts', {});

    // Assert
    should(out.messages[0]).containEql('branch port/clisurface');
    should(out.messages[0]).containEql('+2/-1');
    should(out.messages[0]).containEql('src/new.ts ← src/old.ts');
    should(out.messages[1]).startWith('diff --git');
  });

  it('should keep JSON diff output machine parseable', async () => {
    // Arrange
    const { subject, out } = controller(new RecordingFilesystemGateway({ diff: '' }));

    // Act
    await subject.diff('ses-1', 'unchanged.ts', { json: true });

    // Assert
    should(JSON.parse(out.messages[0] ?? '')).equal('');
  });

  it('should render the root empty state and a non-repository honestly', async () => {
    // Arrange
    const gateway = new RecordingFilesystemGateway({
      listing: { ...listing, path: '', entries: [], truncated: true },
      changes: { repo: false, changes: [] },
      diff: '',
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.list('ses-1', undefined, {});
    await subject.changes('ses-1', {});
    await subject.diff('ses-1', 'plain.txt', {});

    // Assert
    should(out.messages[0]).containEql(':.');
    should(out.messages[0]).containEql('(truncated)');
    should(out.messages[0]).containEql('No entries');
    should(out.messages[1]).equal('The session working directory is not a Git worktree.');
    should(out.messages[2]).equal('No diff for plain.txt.');
  });

  it('should explain every file-content refusal without treating it as empty', async () => {
    // Arrange
    const variants = [
      { ...fileView, content: undefined, denied: true },
      { ...fileView, content: undefined, ignored: true },
      { ...fileView, content: undefined, binary: true },
      { ...fileView, content: undefined, tooLarge: true },
      { ...fileView, content: undefined, reason: 'escapes' as const, rev: 'head' as const },
      { ...fileView, content: undefined },
    ];

    // Act
    const rendered: string[] = [];
    for (const file of variants) {
      const { subject, out } = controller(new RecordingFilesystemGateway({ file }));
      await subject.file('ses-1', file.path, {});
      rendered.push(out.messages[0] ?? '');
    }

    // Assert
    should(rendered.join('\n')).containEql('denied by the repository secrets policy');
    should(rendered.join('\n')).containEql('gitignored or not proven safe');
    should(rendered.join('\n')).containEql('binary');
    should(rendered.join('\n')).containEql('too large');
    should(rendered.join('\n')).containEql('escapes');
    should(rendered.join('\n')).containEql('content unavailable');
    should(rendered.join('\n')).containEql('[HEAD]');
  });

  it('should render a detached clean repository and entries without optional metadata', async () => {
    // Arrange
    const gateway = new RecordingFilesystemGateway({
      listing: { ...listing, entries: [{ name: 'socket', type: 'file' }] },
      changes: { ...changesView, branch: undefined, changes: [], truncated: true },
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.list('ses-1', 'src', {});
    await subject.changes('ses-1', {});

    // Assert
    should(out.messages[0]).containEql('         -  socket');
    should(out.messages[1]).containEql('branch (detached) (truncated)');
    should(out.messages[1]).containEql('No working-tree changes');
  });
});

describe('the file index reading', () => {
  it('should print what the daemon could not cover, even when everything matched', async () => {
    // "No results" over a partial index and "no results" over a complete one are different answers.
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.index('ses-1', {});

    // Assert
    should(out.messages[0]).containEql('3 of 3 indexed files');
    should(out.messages[0]).containEql('(partial)');
    should(out.messages[0]).containEql('not indexed: 2 denied, 1 unreadable');
    should(out.messages[0]).containEql('src/app.ts');
  });

  it('should narrow the index by the same query decision the daemon applies to tasks', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.index('ses-1', { query: 'APP.TS' });

    // Assert
    should(out.messages[0]).containEql('1 of 3 indexed files');
    should(out.messages[0]).containEql('src/app.ts');
    should(out.messages[0]).not.containEql('README.md');
  });

  it('should match a query against the path as well as the basename', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.index('ses-1', { query: 'nested' });

    // Assert
    should(out.messages[0]).containEql('src/nested/deep.ts');
  });

  it('should say so plainly when a query matched nothing', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.index('ses-1', { query: 'no-such-file' });

    // Assert
    should(out.messages[0]).containEql('0 of 3 indexed files');
    should(out.messages[0]).containEql('No matching files.');
  });

  it('should reject a malformed query before making any index request', async () => {
    // Arrange
    const blank = controller();
    const overLong = controller();
    const control = controller();

    // Act
    const failures = await Promise.all([
      blank.subject.index('ses-1', { query: '   ' }).catch((error: unknown) => error),
      overLong.subject.index('ses-1', { query: 'x'.repeat(201) }).catch((error: unknown) => error),
      control.subject.index('ses-1', { query: 'two\nlines' }).catch((error: unknown) => error),
    ]);

    // Assert
    should(failures.every(failure => failure instanceof Error)).be.true();
    should(blank.gateway.calls).be.empty();
    should(overLong.gateway.calls).be.empty();
    should(control.gateway.calls).be.empty();
  });

  it('should emit the narrowed index as JSON when asked', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.index('ses-1', { query: 'deep', json: true });

    // Assert
    should(gateway.calls[0]).deepEqual({ method: 'index', args: ['ses-1'] });
    should(JSON.parse(out.messages[0] ?? '')).match({
      files: [{ path: 'src/nested/deep.ts', name: 'deep.ts' }],
      coverage: 'partial',
    });
  });

  it('should render a complete index with nothing left out', async () => {
    // Arrange
    const gateway = new RecordingFilesystemGateway({
      index: { v: 1, sessionId: 's1', root: '/work/repo', files: [], coverage: 'complete', skipped: [] },
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.index('ses-1', {});

    // Assert
    should(out.messages[0]).containEql('0 of 0 indexed files (complete)');
    should(out.messages[0]).not.containEql('not indexed');
  });

  it('should count one indexed file in the singular', async () => {
    // Arrange
    const gateway = new RecordingFilesystemGateway({
      index: {
        v: 1,
        sessionId: 's1',
        root: '/work/repo',
        files: [{ path: 'only.ts', name: 'only.ts' }],
        coverage: 'complete',
        skipped: [],
      },
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.index('ses-1', {});

    // Assert
    should(out.messages[0]).containEql('1 of 1 indexed file (complete)');
  });
});
