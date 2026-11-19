import { describe, expect, it } from 'bun:test';

import { PairScanner } from '../../../../app/features/pairing/pair-scanner.tsx';
import { DevicePermissionsContext } from '../../../../app/hooks/use-device-permissions.ts';
import { NO_QR_IN_IMAGE, QrImageError } from '../../../../app/features/pairing/qr-image.ts';
import { type QrPreview, type QrScanHost, ScanError } from '../../../../app/lib/pair-scan.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

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
    const screen = await mount(
      <PairScanner host={never} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    const scan = buttonNamed(screen.container, 'Scan QR code');
    expect(scan.disabled).toBe(false);
    expect(viewfinder(screen.container).className).toBe('hidden');
    // The video is mounted from the first paint: the decoder reads this exact
    // element, and mounting it with the scan would be a race against the camera.
    expect(screen.container.querySelector('video')).not.toBeNull();
    await screen.unmount();
  });

  it('offers nothing to press when this browser has no camera to offer', async () => {
    const screen = await mount(
      <PairScanner host={null} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    expect(buttonNamed(screen.container, 'Scan QR code').disabled).toBe(true);
    await screen.unmount();
  });

  it('shows the viewfinder while scanning and says the camera is still opening', async () => {
    const screen = await mount(
      <PairScanner host={never} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

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
      <PairScanner
        host={host}
        pasteOpen={false}
        onPaste={() => {}}
        onText={text => decoded.push(text)}
        onFailed={() => {}}
      />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect((seen[0] as HTMLElement).tagName).toBe('VIDEO');
    expect(released).toBeNull();
    expect(decoded).toEqual(['scanned-text']);
    await screen.unmount();
  });

  it('writes the attributes iOS needs onto the video and starts playback from the tap', async () => {
    const stream = new MediaStream();
    let video: HTMLVideoElement | undefined;
    let played = 0;
    const host: QrScanHost = {
      supported: true,
      scan: async (preview: QrPreview) => {
        video = preview.show(stream) as HTMLVideoElement;
        video.play = () => {
          played += 1;
          return Promise.resolve();
        };
        preview.show(stream);
        return await new Promise<string>(() => {});
      },
    };
    const screen = await mount(
      <PairScanner host={host} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(video?.muted).toBe(true);
    expect(video?.hasAttribute('muted')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(played).toBe(1);
    await screen.unmount();
  });

  it('does not mind a browser that refuses to autoplay the preview', async () => {
    const host: QrScanHost = {
      supported: true,
      scan: async (preview: QrPreview) => {
        const video = preview.show(new MediaStream()) as HTMLVideoElement;
        video.play = () => Promise.reject(new Error('NotAllowedError'));
        preview.show(new MediaStream());
        return await new Promise<string>(() => {});
      },
    };
    const screen = await mount(
      <PairScanner host={host} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(screen.container.textContent).toContain('Stop scanning');
    await screen.unmount();
  });

  it('stops on request and returns to the resting action', async () => {
    const screen = await mount(
      <PairScanner host={never} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

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
        throw new ScanError('permission-denied', 'Camera access is turned off for Ferretry on this device.');
      },
    };
    const screen = await mount(
      <PairScanner
        host={host}
        pasteOpen={false}
        onPaste={() => {}}
        onText={() => {}}
        onFailed={() => (revealed += 1)}
      />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(must(screen.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'Camera access is turned off for Ferretry on this device.',
    );
    expect(revealed).toBe(1);
    await screen.unmount();
  });

  it('tells a refused camera how to turn it back on for this device, and to paste instead', async () => {
    const host: QrScanHost = {
      supported: true,
      scan: async () => {
        throw new ScanError('permission-denied', 'Camera access is turned off for Ferretry on this device.');
      },
    };
    const hostWithFacts = {
      facts: { family: 'ios', installed: true, secure: true } as const,
      status: async () => 'denied' as const,
      request: async () => 'denied' as const,
    };
    const screen = await mount(
      <DevicePermissionsContext.Provider value={hostWithFacts}>
        <PairScanner host={host} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />
      </DevicePermissionsContext.Provider>,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    const howTo = must(screen.container.querySelector('[data-camera-howto]'), 'the how-to');
    expect(howTo.textContent).toContain('find Ferretry in the list of apps');
    expect(howTo.textContent).toContain('paste the pairing link');
    await screen.unmount();
  });

  it('does not show camera steps for a refusal that is not about permission', async () => {
    const host: QrScanHost = {
      supported: true,
      scan: async () => {
        throw new ScanError('camera-busy', 'The camera is in use by another app.');
      },
    };
    const screen = await mount(
      <PairScanner host={host} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(screen.container.querySelector('[data-camera-howto]')).toBeNull();
    await screen.unmount();
  });

  it('says why there is no scanner, on a secure page and on an insecure one', async () => {
    const secure = await mount(
      <PairScanner host={null} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );
    expect(must(secure.container.querySelector('[data-camera-unavailable]'), 'the note').textContent).toContain(
      'This browser cannot scan here',
    );
    await secure.unmount();

    const insecure = {
      facts: { family: 'desktop', installed: false, secure: false } as const,
      status: async () => 'unsupported' as const,
      request: async () => 'unsupported' as const,
    };
    const screen = await mount(
      <DevicePermissionsContext.Provider value={insecure}>
        <PairScanner host={null} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />
      </DevicePermissionsContext.Provider>,
    );
    expect(must(screen.container.querySelector('[data-camera-unavailable]'), 'the note').textContent).toContain(
      'secure (https)',
    );
    await screen.unmount();
  });

  it('shows no unavailable note when the browser can scan', async () => {
    const screen = await mount(
      <PairScanner host={never} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );
    expect(screen.container.querySelector('[data-camera-unavailable]')).toBeNull();
    await screen.unmount();
  });
});

describe('PairScanner: the three equal ways', () => {
  const FAKE_LINK = 'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=FAKE-0000;fp=fy_fake';

  /** Choose one picture in the upload input, as the file picker would. */
  const choose = async (container: HTMLElement): Promise<HTMLInputElement> => {
    const input = must(container.querySelector('input[data-pair-upload]'), 'the upload input') as HTMLInputElement;
    const picture = new File(['pixels'], 'screenshot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [picture] });
    Object.defineProperty(input, 'value', {
      configurable: true,
      writable: true,
      value: 'C:\\fakepath\\screenshot.png',
    });
    await interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    return input;
  };

  it('offers scan, upload and paste side by side, none of them full width', async () => {
    const screen = await mount(
      <PairScanner host={never} pasteOpen={false} onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    const ways = must(screen.container.querySelector('[data-pair-ways]'), 'the ways');
    const labels = [...ways.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toEqual(['Scan QR code', 'Upload a QR image', 'Paste a link']);
    const input = must(
      screen.container.querySelector('input[data-pair-upload]'),
      'the upload input',
    ) as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    await screen.unmount();
  });

  it('keeps upload and paste available where there is no camera', async () => {
    const screen = await mount(
      <PairScanner host={null} pasteOpen onPaste={() => {}} onText={() => {}} onFailed={() => {}} />,
    );

    expect(buttonNamed(screen.container, 'Scan QR code').disabled).toBe(true);
    expect(buttonNamed(screen.container, 'Upload a QR image').disabled).toBe(false);
    expect(buttonNamed(screen.container, 'Paste a link').getAttribute('aria-pressed')).toBe('true');
    await screen.unmount();
  });

  it('hands the decoded link up as text, clears the input, and shows and stores nothing of it', async () => {
    const decoded: string[] = [];
    const read: string[] = [];
    const screen = await mount(
      <PairScanner
        host={never}
        pasteOpen={false}
        onPaste={() => {}}
        readImage={async file => {
          read.push((file as File).name);
          return FAKE_LINK;
        }}
        onText={text => decoded.push(text)}
        onFailed={() => {}}
      />,
    );

    const input = await choose(screen.container);

    expect(read).toEqual(['screenshot.png']);
    expect(decoded).toEqual([FAKE_LINK]);
    expect(input.value).toBe('');
    // The code reaches neither the page's text nor either storage.
    expect(document.body.textContent).not.toContain('FAKE-0000');
    expect(document.body.innerHTML).not.toContain('FAKE-0000');
    expect(JSON.stringify({ ...localStorage })).not.toContain('FAKE-0000');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('FAKE-0000');
    await screen.unmount();
  });

  it('says "No QR code found in that image" when the picture has none, and delivers nothing', async () => {
    const decoded: string[] = [];
    const screen = await mount(
      <PairScanner
        host={never}
        pasteOpen={false}
        onPaste={() => {}}
        readImage={async () => {
          throw new QrImageError('no-qr', NO_QR_IN_IMAGE);
        }}
        onText={text => decoded.push(text)}
        onFailed={() => {}}
      />,
    );

    const input = await choose(screen.container);

    expect(must(screen.container.querySelector('[data-pair-upload-problem]'), 'the problem').textContent).toBe(
      'No QR code found in that image.',
    );
    expect(decoded).toEqual([]);
    expect(input.value).toBe('');
    await screen.unmount();
  });

  it('opens the paste field from the third way', async () => {
    let pasted = 0;
    const screen = await mount(
      <PairScanner
        host={never}
        pasteOpen={false}
        onPaste={() => (pasted += 1)}
        onText={() => {}}
        onFailed={() => {}}
      />,
    );

    await interact(() => buttonNamed(screen.container, 'Paste a link').click());

    expect(pasted).toBe(1);
    await screen.unmount();
  });
});
