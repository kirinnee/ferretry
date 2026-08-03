import { describe, expect, it } from 'bun:test';

import { useQrScan } from '../../src/hooks/use-qr-scan.ts';
import type { QrScanController } from '../../src/hooks/use-qr-scan.ts';
import type { QrPreview, QrScanHost } from '../../src/lib/pair-scan.ts';
import { ScanError } from '../../src/lib/pair-scan.ts';
import { render, runAsync } from '../support/react.ts';

const preview: QrPreview = { show: () => 'source', clear: () => {} };

const settle = async (action: () => void = () => {}): Promise<void> => {
  await runAsync(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
};

interface Deferred {
  readonly host: QrScanHost;
  readonly signals: AbortSignal[];
  resolve: (text: string) => void;
  reject: (reason: unknown) => void;
}

/** A host whose single scan is settled by the test, one call at a time. */
const deferredHost = (supported = true): Deferred => {
  const deferred: Deferred = {
    signals: [],
    resolve: () => {},
    reject: () => {},
    host: {
      supported,
      scan: async (_preview, signal) => {
        deferred.signals.push(signal);
        return await new Promise<string>((resolve, reject) => {
          deferred.resolve = resolve;
          deferred.reject = reject;
        });
      },
    },
  };
  return deferred;
};

const Probe = ({
  host,
  onText,
  seen,
}: {
  host: QrScanHost | null;
  onText: (text: string) => void;
  seen: QrScanController[];
}) => {
  const controller = useQrScan(host, preview, onText);
  seen.push(controller);
  return null;
};

const close = async (view: { unmount: () => void }): Promise<void> => {
  await runAsync(async () => {
    view.unmount();
  });
};

const latest = (seen: QrScanController[]): QrScanController => {
  const controller = seen.at(-1);
  if (controller === undefined) throw new Error('the probe never rendered');
  return controller;
};

describe('useQrScan', () => {
  it('starts idle and reports what the host can do', async () => {
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferredHost().host} onText={() => {}} seen={seen} />);

    expect(latest(seen).phase).toBe('idle');
    expect(latest(seen).message).toBeNull();
    expect(latest(seen).supported).toBe(true);
    await close(view);
  });

  it('reports an absent host as unsupported and refuses to start', async () => {
    const seen: QrScanController[] = [];
    const view = render(<Probe host={null} onText={() => {}} seen={seen} />);

    expect(latest(seen).supported).toBe(false);
    await runAsync(async () => latest(seen).start());
    expect(latest(seen).phase).toBe('idle');
    await close(view);
  });

  it('delivers the decoded text once and returns to idle', async () => {
    const decoded: string[] = [];
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={text => decoded.push(text)} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    expect(latest(seen).phase).toBe('scanning');

    await settle(() => deferred.resolve('pairing-link'));

    expect(decoded).toEqual(['pairing-link']);
    expect(latest(seen).phase).toBe('idle');
    await close(view);
  });

  it('reports a refusal with the host sentence, and anything else with its own', async () => {
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={() => {}} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    await settle(() => deferred.reject(new ScanError('permission-denied', 'Camera access was blocked for this site.')));
    expect(latest(seen).phase).toBe('failed');
    expect(latest(seen).message).toBe('Camera access was blocked for this site.');

    await runAsync(async () => latest(seen).start());
    await settle(() => deferred.reject(new Error('something else entirely')));
    expect(latest(seen).message).toBe('The camera could not be started.');
    await close(view);
  });

  it('aborts the live scan on stop, and reports nothing about a stop the reader asked for', async () => {
    const decoded: string[] = [];
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={text => decoded.push(text)} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    await runAsync(async () => latest(seen).stop());
    expect(deferred.signals[0]?.aborted).toBe(true);
    expect(latest(seen).phase).toBe('idle');

    // Both endings of an aborted scan are silent: a late decode is not
    // delivered, and a late rejection is not shown.
    await settle(() => deferred.resolve('too late'));
    expect(decoded).toEqual([]);
    expect(latest(seen).phase).toBe('idle');

    await runAsync(async () => latest(seen).start());
    await runAsync(async () => latest(seen).stop());
    await settle(() => deferred.reject(new ScanError('cancelled', 'The scan was stopped.')));
    expect(latest(seen).phase).toBe('idle');
    expect(latest(seen).message).toBeNull();
    await close(view);
  });

  it('abandons a previous scan when a new one starts', async () => {
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={() => {}} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    await runAsync(async () => latest(seen).start());

    expect(deferred.signals).toHaveLength(2);
    expect(deferred.signals[0]?.aborted).toBe(true);
    expect(deferred.signals[1]?.aborted).toBe(false);
    await close(view);
  });

  it('aborts the scan when the screen unmounts, so the camera goes out with it', async () => {
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={() => {}} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    expect(deferred.signals[0]?.aborted).toBe(false);
    await close(view);
    expect(deferred.signals[0]?.aborted).toBe(true);
  });

  it('delivers to the newest callback without restarting a live scan', async () => {
    const decoded: string[] = [];
    const deferred = deferredHost();
    const seen: QrScanController[] = [];
    const view = render(<Probe host={deferred.host} onText={() => decoded.push('first')} seen={seen} />);

    await runAsync(async () => latest(seen).start());
    await runAsync(async () => {
      view.update(<Probe host={deferred.host} onText={() => decoded.push('second')} seen={seen} />);
    });
    await settle(() => deferred.resolve('code'));

    expect(deferred.signals).toHaveLength(1);
    expect(decoded).toEqual(['second']);
    await close(view);
  });
});
