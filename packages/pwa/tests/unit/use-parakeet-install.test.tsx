/**
 * Proves the Parakeet install hook: with no voice it reads as unsupported with a sentence, and with
 * one it follows the voice's snapshot, re-renders when the voice publishes, and re-reads what is
 * stored once on mount without ever installing.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { useParakeetInstall } from '../../src/hooks/use-parakeet-install.ts';
import { PARAKEET_TOTAL_BYTES } from '../../src/lib/stt/parakeet-model.ts';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../../src/lib/stt/parakeet-voice.ts';
import { render, run } from '../support/react.ts';

class FakeVoice {
  snapshot: ParakeetInstallSnapshot = { phase: 'absent', totalBytes: 10, downloadedBytes: 0 };
  refreshes = 0;
  installs = 0;
  readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): ParakeetInstallSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh(): Promise<void> {
    this.refreshes += 1;
    return Promise.resolve();
  }
  install(): Promise<void> {
    this.installs += 1;
    return Promise.resolve();
  }
  publish(snapshot: ParakeetInstallSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

const Probe = ({ voice, seen }: { voice: ParakeetVoice | null; seen: ParakeetInstallSnapshot[] }) => {
  seen.push(useParakeetInstall(voice));
  return null;
};

describe('useParakeetInstall', () => {
  it('reads no voice as unsupported with a sentence', () => {
    const seen: ParakeetInstallSnapshot[] = [];
    const view = render(<Probe voice={null} seen={seen} />);
    should(seen.at(-1)).eql({
      phase: 'unsupported',
      totalBytes: PARAKEET_TOTAL_BYTES,
      downloadedBytes: 0,
      reason: 'Parakeet is not available in this copy of Ferretry.',
    });
    run(() => view.unmount());
  });

  it('follows the voice, refreshes on mount, and re-renders on publish without installing', () => {
    const fake = new FakeVoice();
    const seen: ParakeetInstallSnapshot[] = [];
    const view = render(<Probe voice={fake as unknown as ParakeetVoice} seen={seen} />);
    should(seen.at(-1)?.phase).equal('absent');
    should(fake.refreshes).equal(1);
    should(fake.listeners.size).equal(1);
    run(() => fake.publish({ phase: 'installing', totalBytes: 10, downloadedBytes: 4, label: 'Encoder' }));
    should(seen.at(-1)).eql({ phase: 'installing', totalBytes: 10, downloadedBytes: 4, label: 'Encoder' });
    should(fake.installs).equal(0);
    run(() => view.unmount());
    should(fake.listeners.size).equal(0);
  });
});
