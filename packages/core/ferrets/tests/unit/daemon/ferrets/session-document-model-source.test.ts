import { describe, it } from 'bun:test';
import should from 'should';
import { sessionDocument, type SessionDocumentSeed } from '../../../../daemon/lib/ferrets/session-document.ts';

const record = {
  id: 's1',
  name: 'Keep Settings',
  harness: 'claude',
  folder: '/work/ferretry',
} as unknown as SessionDocumentSeed['record'];

const documentFor = (model: string | undefined) =>
  sessionDocument(
    { record, turn: 0, details: { options: model === undefined ? {} : { model } } } as unknown as SessionDocumentSeed,
    '2027-01-15T08:00:00.000Z',
  );

describe('sessionDocument launch model source (B191/B1)', () => {
  it('should record a --model the start named as requested', () => {
    // Arrange / Act
    const config = documentFor('claude-sonnet-5');

    // Assert
    should(config.model).equal('claude-sonnet-5');
    should(config.launchModelSource).equal('requested');
  });

  it('should record a start that named no model as the account default, with no model', () => {
    // Arrange / Act
    const config = documentFor(undefined);

    // Assert
    should(config.model).be.undefined();
    should(config.launchModelSource).equal('account-default');
  });
});
