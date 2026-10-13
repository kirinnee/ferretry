import { describe, it } from 'bun:test';
import should from 'should';

import type { ReleaseNotice } from '../../src/hooks/use-release-integrity.ts';
import { ReleaseNoticeBanner, releaseNoticeWords } from '../../src/shell/release-notice.tsx';
import { render, run } from '../support/react.ts';

const JARGON = /manifest|hash|service worker|signature file|spki|ed25519|cache/iu;

describe('releaseNoticeWords', () => {
  it.each([
    [
      { kind: 'refused', refusal: 'bad-signature', hadRelease: true },
      'An update failed verification',
      'still using the version you had',
    ],
    [
      { kind: 'refused', refusal: 'unknown-key', hadRelease: false },
      'An update failed verification',
      'could not be checked',
    ],
    [{ kind: 'unsigned-worker' }, 'This app may have been tampered with', 'not one Ferretry signed'],
  ] as const)('says %j plainly', (notice, title, phrase) => {
    // Act
    const actual = releaseNoticeWords(notice as ReleaseNotice);

    // Assert
    should(actual.title).equal(title);
    should(actual.body).containEql(phrase);
    should(`${actual.title} ${actual.body}`).not.match(JARGON);
  });
});

describe('ReleaseNoticeBanner', () => {
  it('shows a refused update as a status the reader can dismiss', () => {
    // Arrange
    let dismissed = 0;
    const renderer = render(
      <ReleaseNoticeBanner
        notice={{ kind: 'refused', refusal: 'older', hadRelease: true }}
        onDismiss={() => {
          dismissed += 1;
        }}
      />,
    );

    // Act
    const root = renderer.root.findByProps({ 'data-release-notice': 'refused' });
    run(() => renderer.root.findByType('button').props.onClick());

    // Assert
    should(root.props.role).equal('status');
    should(dismissed).equal(1);
  });

  it('shows a replaced checker as an alert with no dismiss button', () => {
    // Arrange + Act
    const renderer = render(<ReleaseNoticeBanner notice={{ kind: 'unsigned-worker' }} onDismiss={() => undefined} />);

    // Assert
    should(renderer.root.findByProps({ 'data-release-notice': 'unsigned-worker' }).props.role).equal('alert');
    should(renderer.root.findAllByType('button')).have.length(0);
  });
});
