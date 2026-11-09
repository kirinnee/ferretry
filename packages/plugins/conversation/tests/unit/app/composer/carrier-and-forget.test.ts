import { describe, expect, it, spyOn } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import half from '../../../../app/index.ts';
import { documentDraftStore, documentRestoreStore } from '../../../../app/composer/drafts.ts';
import { carrierDelivery } from '../../../../app/composer/seam.ts';

describe('S12 a send that died on the carrier', () => {
  const outage = new DaemonCallError(0, 'carrier_outage', 'the session closed', undefined, true);

  it('reads "checking whether it arrived" — the client cannot prove the request never left', () => {
    expect(carrierDelivery(outage)).toBe('unknown');
    expect(carrierDelivery(new Error('wrapped', { cause: outage }))).toBe('unknown');
  });

  it('a delivery mark found down the chain still wins', () => {
    expect(carrierDelivery(Object.assign(new Error('x'), { delivery: 'unsent' }))).toBe('unsent');
  });

  it('a daemon’s refusal, or anything else, is not an outage', () => {
    expect(carrierDelivery(new DaemonCallError(409, 'conflict', 'no'))).toBeUndefined();
    expect(carrierDelivery(new Error('plain'))).toBeUndefined();
    expect(carrierDelivery('text')).toBeUndefined();
  });
});

describe('S12 unpairing a machine clears its unsent words', () => {
  it('clears both the drafts and the words waiting to be restored, for that machine only', () => {
    const drafts = spyOn(documentDraftStore, 'clearDaemon').mockImplementation(() => {});
    const restores = spyOn(documentRestoreStore, 'clearDaemon').mockImplementation(() => {});
    try {
      (half.shell as { forget: (daemon: string) => void }).forget('d1');
      expect(drafts.mock.calls).toEqual([['d1']]);
      expect(restores.mock.calls).toEqual([['d1']]);
    } finally {
      drafts.mockRestore();
      restores.mockRestore();
    }
  });
});
