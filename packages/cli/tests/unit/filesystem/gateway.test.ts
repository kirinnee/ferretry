import { describe, it } from 'bun:test';
import should from 'should';
import { filesystemPath, ProtocolFilesystemGateway } from '../../../src/lib/filesystem/gateway.ts';
import { changesView, fileView, listing, RecordingClient } from './fixtures.ts';

describe('filesystem gateway', () => {
  it('should address the session and relative paths without accepting a root', async () => {
    // Arrange
    const client = new RecordingClient();
    client.responses.push(listing, fileView, changesView, 'diff text');
    const subject = new ProtocolFilesystemGateway(client);

    // Act
    await subject.list(' Fable/one ', ' src/nested ');
    await subject.file('Fable/one', ' src/app.ts ', 'head');
    await subject.changes('Fable/one');
    await subject.diff('Fable/one', ' src/app.ts ');

    // Assert
    should(client.calls.map(call => call.path)).deepEqual([
      '/v1/sessions/Fable%2Fone/fs?path=src%2Fnested',
      '/v1/sessions/Fable%2Fone/fs/file?path=src%2Fapp.ts&rev=head',
      '/v1/sessions/Fable%2Fone/fs/changes',
      '/v1/sessions/Fable%2Fone/fs/diff?path=src%2Fapp.ts',
    ]);
  });

  it('should omit an empty listing path and reject blank required values', async () => {
    // Arrange
    const client = new RecordingClient();
    client.responses.push({ ...listing, path: '' });
    const subject = new ProtocolFilesystemGateway(client);

    // Act
    await subject.list('ses-1', '   ');

    // Assert
    should(client.calls[0]?.path).equal('/v1/sessions/ses-1/fs');
    should(() => filesystemPath('   ')).throw('a session id or callsign is required');
    await should(subject.file('ses-1', '   ')).be.rejectedWith('a relative file path is required');
    await should(subject.diff('ses-1', '   ')).be.rejectedWith('a relative diff path is required');
  });

  it('should parse every response instead of trusting daemon bytes', async () => {
    // Arrange
    const client = new RecordingClient();
    client.responses.push({ entries: 'not-an-array' });
    const subject = new ProtocolFilesystemGateway(client);

    // Act + Assert
    await should(subject.list('ses-1')).be.rejected();
  });
});
