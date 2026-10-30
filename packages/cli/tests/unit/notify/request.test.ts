import { describe, it } from 'bun:test';
import should from 'should';
import { composeNoticeRequest } from '../../../src/lib/notify/request';

describe('notice request', () => {
  it('should make the summary the subject, the reason and a clipped title', () => {
    // Arrange
    const summary = 'The staging deploy finished and every check passed, so it is ready for you to look at';

    // Act
    const actual = composeNoticeRequest(summary.split(' '), {});

    // Assert
    should(actual.subject).equal(summary);
    should(actual.why).equal(summary);
    should(actual.title.length).be.belowOrEqual(40);
    should(actual.title.endsWith('…')).be.true();
    should(actual.notice).equal(true);
    should(actual.surface).equal(true);
  });

  it('should carry the body through and add ping only when asked', () => {
    // Act
    const quiet = composeNoticeRequest(['PR', 'ready'], { body: '  # Notes\n\n- one  ' });
    const loud = composeNoticeRequest(['PR', 'ready'], { ping: true });

    // Assert
    should(quiet.body).equal('# Notes\n\n- one');
    should(quiet).not.have.property('ping');
    should(loud.ping).equal(true);
    should(loud).not.have.property('body');
  });

  it('should require a summary', () => {
    // Act + Assert
    should(() => composeNoticeRequest([], {})).throw(/needs a summary/u);
    should(() => composeNoticeRequest(['  ', ''], {})).throw(/needs a summary/u);
  });

  it('should refuse a summary of more than one line, sending the rest to --body', () => {
    // Act + Assert
    should(() => composeNoticeRequest(['first\nsecond'], {})).throw(/one line.*--body/u);
  });

  it('should refuse a summary or body that is too long, in numbers', () => {
    // Act + Assert
    should(() => composeNoticeRequest(['x'.repeat(241)], {})).throw(/241 characters.*240/u);
    should(() => composeNoticeRequest(['ok'], { body: 'y'.repeat(8_001) })).throw(/8001 characters.*8000/u);
  });
});
