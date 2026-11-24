import { describe, it } from 'bun:test';
import should from 'should';
import { modelListReadDraft } from '../../../daemon/lib/model-lists/audit.ts';

describe('modelListReadDraft', () => {
  it('should write the secrets.used record of one list read: the key’s name, the host, the outcome and the login, nothing else', () => {
    // Act
    const actual = modelListReadDraft({
      loginId: 'deepseek',
      secret: 'DEEPSEEK_API_KEY',
      host: 'api.deepseek.com',
      outcome: 'completion',
    });

    // Assert
    should(actual).eql({
      event: 'secrets.used',
      actor: { kind: 'host' },
      subject: 'DEEPSEEK_API_KEY',
      outcome: 'succeeded',
      detail: { plugin: 'logins', login: 'deepseek', host: 'api.deepseek.com', outcome: 'completion' },
      cause: 'daemon',
    });
  });

  it('should call a reply of any status a use that succeeded, and a send that got no reply one that failed', () => {
    // Arrange
    const note = { loginId: 'deepseek', secret: 'DEEPSEEK_API_KEY', host: 'api.deepseek.com' };

    // Assert
    should(modelListReadDraft({ ...note, outcome: 'status' }).outcome).equal('succeeded');
    for (const outcome of ['timeout', 'unreachable', 'oversized', 'unreadable']) {
      should(modelListReadDraft({ ...note, outcome }).outcome).equal('failed');
    }
  });
});
