import { describe, expect, it } from 'bun:test';

import { PairScanner } from '../../../src/features/pairing/pair-scanner.tsx';
import { type QrPreview, type QrScanHost, ScanError } from '../../../src/lib/pair-scan.ts';
import { interact, mount, must } from '../../support/dom.ts';

const never: QrScanHost = { supported: true, scan: async () => await new Promise<string>(() => {}) };

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)) ?? null,
    `a button labelled ${text}`,
  );

const viewfinder = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('section[aria-label="Camera viewfinder"]'), 'the viewfinder');

describe('PairScanner', () => {
  it('rests as one obvious action, with the camera hidden until it is asked for', async () => {
    const screen = await mount(<PairScanner host={never} label="Scan QR code" onText={() => {}} onFailed={() => {}} />);

    const scan = buttonNamed(screen.container, 'Scan QR code');
    expect(scan.disabled).toBe(false);
    expect(viewfinder(screen.container).className).toBe('hidden');
    // The video is mounted from the first paint: the decoder reads this exact
    // element, and mounting it with the scan would be a race against the camera.
    expect(screen.container.querySelector('video')).not.toBeNull();
    await screen.unmount();
  });

  it('offers nothing to press when this browser has no camera to offer', async () => {
    const screen = await mount(<PairScanner host={null} label="Scan QR code" onText={() => {}} onFailed={() => {}} />);

    expect(buttonNamed(screen.container, 'Scan QR code').disabled).toBe(true);
    await screen.unmount();
  });

  it('shows the viewfinder while scanning and says the camera is still opening', async () => {
    const screen = await mount(<PairScanner host={never} label="Scan QR code" onText={() => {}} onFailed={() => {}} />);

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(viewfinder(screen.container).className).not.toBe('hidden');
    expect(screen.container.textContent).toContain('Starting the camera…');
    expect(screen.container.textContent).not.toContain('Scan QR code');

    // Frames arriving is what turns "opening" into an instruction.
    const video = must(screen.container.querySelector('video'), 'the preview video');
    await interact(() => video.dispatchEvent(new Event('playing')));
    expect(screen.container.textContent).toContain('Point at the QR code');
    expect(screen.container.textContent).not.toContain('Starting the camera…');
    await screen.unmount();
  });

  it('attaches the stream to the video it decodes from, and detaches it on release', async () => {
    // A real `MediaStream`: `srcObject` is a typed setter and refuses anything else.
    const stream = new MediaStream();
    const seen: unknown[] = [];
    let released: unknown = 'not released';
    const host: QrScanHost = {
      supported: true,
      scan: async (preview: QrPreview) => {
        seen.push(preview.show(stream));
        preview.clear();
        released = (seen[0] as HTMLVideoElement).srcObject;
        return 'scanned-text';
      },
    };
    const decoded: string[] = [];
    const screen = await mount(
      <PairScanner host={host} label="Scan QR code" onText={text => decoded.push(text)} onFailed={() => {}} />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect((seen[0] as HTMLElement).tagName).toBe('VIDEO');
    expect(released).toBeNull();
    expect(decoded).toEqual(['scanned-text']);
    await screen.unmount();
  });

  it('stops on request and returns to the resting action', async () => {
    const screen = await mount(<PairScanner host={never} label="Scan QR code" onText={() => {}} onFailed={() => {}} />);

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());
    await interact(() => buttonNamed(screen.container, 'Stop scanning').click());

    expect(viewfinder(screen.container).className).toBe('hidden');
    expect(buttonNamed(screen.container, 'Scan QR code').disabled).toBe(false);
    await screen.unmount();
  });

  it('says why a scan was refused and tells the caller to reveal its fallback', async () => {
    let revealed = 0;
    const host: QrScanHost = {
      supported: true,
      scan: async () => {
        throw new ScanError('permission-denied', 'Camera access was blocked for this site.');
      },
    };
    const screen = await mount(
      <PairScanner host={host} label="Scan QR code" onText={() => {}} onFailed={() => (revealed += 1)} />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(must(screen.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'Camera access was blocked for this site.',
    );
    expect(revealed).toBe(1);
    await screen.unmount();
  });
});
