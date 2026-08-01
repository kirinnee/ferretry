import { describe, it } from 'bun:test';
import should from 'should';
import {
  DETAILS_TAB_ORDER,
  PCM16_WORKLET_NAME,
  RemoteBrowserPane,
  SessionAnalyticsSurface,
  packageRole,
} from '../../src/lib/index.ts';

describe('pwa package entry', () => {
  it('should expose its workspace role', () => {
    // Act
    const actual = packageRole;

    // Assert
    should(actual).equal('pwa');
  });

  it('should expose the audio worklet through the package entry', () => {
    // Act
    const actual = PCM16_WORKLET_NAME;

    // Assert
    should(actual).equal('kteam-pcm16-capture');
  });

  it('should expose the daemon-aware details tabs through the package entry', () => {
    // Act
    const actual = DETAILS_TAB_ORDER;

    // Assert
    should(actual).deepEqual(['identity', 'runtime', 'progress', 'budget']);
  });

  it('should expose the composed browser and session analytics surfaces', () => {
    // Act + Assert — these are library composition roots until the PWA app
    // assembler mounts concrete side-pane bodies in its own migration unit.
    should(RemoteBrowserPane).be.a.Function();
    should(SessionAnalyticsSurface).be.a.Function();
  });
});
