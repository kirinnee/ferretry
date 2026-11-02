import { describe, it } from 'bun:test';
import { MAX_AGENDA_DETAIL_LENGTH, MAX_AGENDA_SUBJECT_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { fitOwnerNotice } from '../../../src/lib/warden/owner-notice.ts';

const WHY = 'The Warden moves a ferret whose login hit a limit to another login.';
const TRIED = `Not moved although codex-ernest hit its usage limit: no login could take it. ${'Tried codex-atomi (only 3% is left, under the 20% the Warden settings need). '.repeat(6)}`;

describe('fitOwnerNotice', () => {
  it('should leave a notice that fits as it was', () => {
    // Arrange
    const notice = { subject: 'codex-ernest could not be moved.', why: WHY };

    // Act + Assert
    should(fitOwnerNotice(notice)).deepEqual(notice);
  });

  it('should cut a long subject at a word and keep the whole of it after the reason', () => {
    // Act
    const fitted = fitOwnerNotice({ subject: TRIED, why: WHY });

    // Assert
    should(fitted.subject.length).be.belowOrEqual(MAX_AGENDA_SUBJECT_LENGTH);
    should(fitted.subject).startWith('Not moved although codex-ernest hit its usage limit').endWith('…');
    should(fitted.why).equal(`${WHY}\n\nIn full: ${TRIED.trim()}`);
  });

  it('should keep the reason within its own limit too', () => {
    // Act
    const fitted = fitOwnerNotice({ subject: TRIED.repeat(6), why: WHY });

    // Assert
    should(fitted.why.length).be.belowOrEqual(MAX_AGENDA_DETAIL_LENGTH);
    should(fitted.why).startWith(WHY).endWith('…');
  });
});
