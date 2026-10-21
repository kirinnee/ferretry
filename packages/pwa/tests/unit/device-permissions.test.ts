import { describe, expect, it } from 'bun:test';

import {
  browserPermissionsHost,
  DEVICE_PERMISSIONS,
  type DeviceFacts,
  type DevicePermissionId,
  type DevicePermissionState,
  deviceFacts,
  devicePermissionInfo,
  howToEnable,
  type PermissionsEnvironment,
  type PermissionsWindow,
  permissionAction,
  unsupportedNote,
  windowDeviceFacts,
  windowPermissionsHost,
} from '../../src/lib/device-permissions.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0 Safari/537.36';

const facts = (overrides: Partial<DeviceFacts> = {}): DeviceFacts => ({
  family: 'desktop',
  installed: false,
  secure: true,
  ...overrides,
});

const named = (name: string): Error => Object.assign(new Error(name), { name });

describe('deviceFacts', () => {
  const read = (
    userAgent: string,
    rest: { maxTouchPoints?: number; standaloneDisplay?: boolean; secureContext?: boolean } = {},
  ) => deviceFacts({ userAgent, maxTouchPoints: 0, standaloneDisplay: false, secureContext: true, ...rest });

  it('recognises an iPhone, an iPad posing as a Mac, an Android phone and a desktop', () => {
    expect(read(IPHONE).family).toBe('ios');
    expect(read(MAC, { maxTouchPoints: 5 }).family).toBe('ios');
    expect(read(MAC, { maxTouchPoints: 0 }).family).toBe('desktop');
    expect(read(ANDROID).family).toBe('android');
    expect(read(LINUX).family).toBe('desktop');
  });

  it('carries the installed and secure flags', () => {
    expect(read(IPHONE, { standaloneDisplay: true }).installed).toBe(true);
    expect(read(IPHONE).installed).toBe(false);
    expect(read(IPHONE, { secureContext: false }).secure).toBe(false);
  });
});

describe('the catalogue', () => {
  it('lists every permission once, each with a reason and a button label', () => {
    const ids = DEVICE_PERMISSIONS.map(info => info.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['camera', 'microphone', 'notifications', 'location', 'clipboard-read', 'persistent-storage']);
    for (const info of DEVICE_PERMISSIONS) {
      expect(info.why.length).toBeGreaterThan(20);
      expect(info.requestLabel.length).toBeGreaterThan(3);
    }
  });

  it('looks a permission up, and refuses one it does not know', () => {
    expect(devicePermissionInfo('location').label).toBe('Location');
    expect(() => devicePermissionInfo('teleport' as DevicePermissionId)).toThrow('Unknown device permission: teleport');
  });
});

describe('howToEnable', () => {
  it('sends an iPhone browser tab to Safari settings, and an installed app to its own entry', () => {
    const tab = howToEnable('camera', facts({ family: 'ios' }));
    expect(tab.join(' ')).toContain('Safari');
    expect(tab.join(' ')).toContain('Website Settings');
    const app = howToEnable('camera', facts({ family: 'ios', installed: true }));
    expect(app.join(' ')).toContain('find Ferretry in the list of apps');
    expect(app.join(' ')).not.toContain('Website Settings');
    expect(app.at(-1)).toContain('Come back to Ferretry');
  });

  it('sends Android to site settings in a tab and app info once installed', () => {
    expect(howToEnable('location', facts({ family: 'android' })).join(' ')).toContain('lock or settings icon');
    expect(howToEnable('location', facts({ family: 'android', installed: true })).join(' ')).toContain('App info');
  });

  it('names the permission in every step list, and gives a desktop its own steps', () => {
    const steps = howToEnable('microphone', facts());
    expect(steps.join(' ')).toContain('Microphone');
    expect(steps.join(' ')).toContain('Site settings');
  });

  it('explains persistent storage as the browser’s call, and points a tab at installing', () => {
    expect(howToEnable('persistent-storage', facts()).join(' ')).toContain('Install app');
    expect(howToEnable('persistent-storage', facts({ installed: true })).join(' ')).toContain(
      'already using the installed app',
    );
  });
});

describe('unsupportedNote', () => {
  it('tells an iPhone browser tab that notifications need the Home Screen', () => {
    expect(unsupportedNote('notifications', facts({ family: 'ios' }))).toContain('Add to Home Screen');
  });

  it('blames an insecure page for anything that needs https, but not for storage', () => {
    expect(unsupportedNote('camera', facts({ secure: false }))).toContain('secure (https)');
    expect(unsupportedNote('persistent-storage', facts({ secure: false }))).toBe('This browser does not offer this.');
  });

  it('otherwise says the browser does not offer it', () => {
    expect(unsupportedNote('notifications', facts({ family: 'ios', installed: true }))).toBe(
      'This browser does not offer this.',
    );
    expect(unsupportedNote('location', facts())).toBe('This browser does not offer this.');
  });
});

describe('permissionAction', () => {
  it('asks when not asked yet, explains when refused, and offers nothing otherwise', () => {
    expect(permissionAction('prompt')).toBe('request');
    expect(permissionAction('denied')).toBe('how-to');
    expect(permissionAction('granted')).toBe('none');
    expect(permissionAction('unsupported')).toBe('none');
  });
});

interface Stream {
  stopped: number;
  getTracks: () => { stop: () => void }[];
}

const stream = (): Stream => {
  const made: Stream = {
    stopped: 0,
    getTracks: () => [
      {
        stop: () => {
          made.stopped += 1;
        },
      },
    ],
  };
  return made;
};

const host = (environment: Partial<PermissionsEnvironment> = {}) =>
  browserPermissionsHost({ facts: facts(), ...environment });

const queryAnswering = (answers: Partial<Record<string, string | Error>>) => ({
  query: async ({ name }: { readonly name: string }) => {
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return { state: answer ?? 'prompt' };
  },
});

describe('status — a read that never asks', () => {
  it('reports camera and microphone as unsupported without getUserMedia', async () => {
    expect(await host().status('camera')).toBe('unsupported');
    expect(await host({ media: {} }).status('microphone')).toBe('unsupported');
  });

  it('uses the permissions query where it knows the name, else says prompt', async () => {
    const media = { getUserMedia: async () => stream() };
    expect(await host({ media, permissions: queryAnswering({ camera: 'granted' }) }).status('camera')).toBe('granted');
    expect(await host({ media, permissions: queryAnswering({ camera: 'denied' }) }).status('camera')).toBe('denied');
    expect(await host({ media, permissions: queryAnswering({ camera: 'weird' }) }).status('camera')).toBe('prompt');
    expect(
      await host({ media, permissions: queryAnswering({ camera: new TypeError('unknown name') }) }).status('camera'),
    ).toBe('prompt');
    expect(await host({ media }).status('camera')).toBe('prompt');
  });

  it('reads notifications from the Notification class, and says unsupported where there is none', async () => {
    const withPermission = (permission: string) =>
      host({ notifications: { permission, requestPermission: async () => permission } });
    expect(await host().status('notifications')).toBe('unsupported');
    expect(await withPermission('default').status('notifications')).toBe('prompt');
    expect(await withPermission('granted').status('notifications')).toBe('granted');
    expect(await withPermission('denied').status('notifications')).toBe('denied');
  });

  it('reads location, clipboard and storage the same careful way', async () => {
    const geolocation = { getCurrentPosition: () => {} };
    expect(await host().status('location')).toBe('unsupported');
    expect(await host({ geolocation }).status('location')).toBe('prompt');
    expect(await host({ geolocation, permissions: queryAnswering({ geolocation: 'denied' }) }).status('location')).toBe(
      'denied',
    );

    expect(await host().status('clipboard-read')).toBe('unsupported');
    const clipboard = { readText: async () => '' };
    expect(
      await host({ clipboard, permissions: queryAnswering({ 'clipboard-read': 'granted' }) }).status('clipboard-read'),
    ).toBe('granted');
    expect(await host({ clipboard }).status('clipboard-read')).toBe('prompt');
  });

  it('reads persistent storage from the query, else from persisted()', async () => {
    expect(await host().status('persistent-storage')).toBe('unsupported');
    expect(await host({ storage: {} }).status('persistent-storage')).toBe('unsupported');
    const persist = async () => true;
    expect(
      await host({ storage: { persist }, permissions: queryAnswering({ 'persistent-storage': 'granted' }) }).status(
        'persistent-storage',
      ),
    ).toBe('granted');
    expect(await host({ storage: { persist, persisted: async () => true } }).status('persistent-storage')).toBe(
      'granted',
    );
    expect(await host({ storage: { persist, persisted: async () => false } }).status('persistent-storage')).toBe(
      'prompt',
    );
    expect(await host({ storage: { persist } }).status('persistent-storage')).toBe('prompt');
    expect(
      await host({
        storage: {
          persist,
          persisted: async () => {
            throw new Error('nope');
          },
        },
      }).status('persistent-storage'),
    ).toBe('prompt');
  });
});

describe('request — the one call that may prompt', () => {
  it('opens the camera synchronously, answers granted, and stops every track at once', async () => {
    const opened = stream();
    const asked: unknown[] = [];
    const subject = host({
      media: {
        getUserMedia: async constraints => {
          asked.push(constraints);
          return opened;
        },
      },
    });

    const answer = subject.request('camera');
    expect(asked).toEqual([{ video: true, audio: false }]);
    expect(await answer).toBe('granted');
    expect(opened.stopped).toBe(1);
  });

  it('asks the microphone with audio only, and survives a stream with no tracks', async () => {
    const asked: unknown[] = [];
    const subject = host({
      media: {
        getUserMedia: async constraints => {
          asked.push(constraints);
          return {};
        },
      },
    });

    expect(await subject.request('microphone')).toBe('granted');
    expect(asked).toEqual([{ audio: true, video: false }]);
  });

  it('maps a refusal to denied, a missing device to unsupported, and anything else to the current state', async () => {
    const failing = (error: unknown) =>
      host({
        media: {
          getUserMedia: async () => {
            throw error;
          },
        },
        permissions: queryAnswering({ camera: 'prompt' }),
      });

    expect(await failing(named('NotAllowedError')).request('camera')).toBe('denied');
    expect(await failing(named('SecurityError')).request('camera')).toBe('denied');
    expect(await failing(named('NotFoundError')).request('camera')).toBe('unsupported');
    expect(await failing(named('OverconstrainedError')).request('camera')).toBe('unsupported');
    expect(await failing(named('NotReadableError')).request('camera')).toBe('prompt');
    expect(await failing(null).request('camera')).toBe('prompt');
  });

  it('answers unsupported for a camera that does not exist', async () => {
    expect(await host().request('camera')).toBe('unsupported');
  });

  it('asks for notifications from the Notification class and maps its answer', async () => {
    const answering = (answer: string) =>
      host({ notifications: { permission: 'default', requestPermission: async () => answer } });
    expect(await host().request('notifications')).toBe('unsupported');
    expect(await answering('granted').request('notifications')).toBe('granted');
    expect(await answering('denied').request('notifications')).toBe('denied');
    expect(await answering('default').request('notifications')).toBe('prompt');
    const throwing = host({
      notifications: {
        permission: 'denied',
        requestPermission: async () => {
          throw new Error('not allowed here');
        },
      },
    });
    expect(await throwing.request('notifications')).toBe('denied');
  });

  it('takes one position for location and discards it', async () => {
    expect(await host().request('location')).toBe('unsupported');
    const reading = (outcome: 'ok' | number) =>
      host({
        geolocation: {
          getCurrentPosition: (success, failure) => {
            if (outcome === 'ok') success();
            else failure({ code: outcome });
          },
        },
        permissions: queryAnswering({ geolocation: 'granted' }),
      });

    expect(await reading('ok').request('location')).toBe('granted');
    expect(await reading(1).request('location')).toBe('denied');
    // Code 2/3 happen after a grant: the browser's own answer wins.
    expect(await reading(2).request('location')).toBe('granted');
  });

  it('reads the clipboard once on the tap and maps a refusal', async () => {
    expect(await host().request('clipboard-read')).toBe('unsupported');
    expect(await host({ clipboard: { readText: async () => 'secret text' } }).request('clipboard-read')).toBe(
      'granted',
    );
    const failing = (error: unknown) =>
      host({
        clipboard: {
          readText: async () => {
            throw error;
          },
        },
        permissions: queryAnswering({ 'clipboard-read': 'prompt' }),
      });
    expect(await failing(named('NotAllowedError')).request('clipboard-read')).toBe('denied');
    expect(await failing(new Error('focus')).request('clipboard-read')).toBe('prompt');
  });

  it('asks the browser to persist storage', async () => {
    expect(await host().request('persistent-storage')).toBe('unsupported');
    expect(await host({ storage: { persist: async () => true } }).request('persistent-storage')).toBe('granted');
    expect(await host({ storage: { persist: async () => false } }).request('persistent-storage')).toBe('denied');
    const throwing = host({
      storage: {
        persist: async () => {
          throw new Error('x');
        },
      },
    });
    expect(await throwing.request('persistent-storage')).toBe('prompt');
  });

  it('exposes the facts it was given', () => {
    const given = facts({ family: 'android' });
    expect(browserPermissionsHost({ facts: given }).facts).toBe(given);
  });
});

describe('windowPermissionsHost', () => {
  const win = (overrides: Partial<PermissionsWindow['navigator']> = {}, standalone = false): PermissionsWindow => ({
    isSecureContext: true,
    navigator: { userAgent: IPHONE, maxTouchPoints: 5, ...overrides },
    matchMedia: query => ({ matches: standalone && query === '(display-mode: standalone)' }),
  });

  it('reads this device’s facts from the window', () => {
    expect(windowDeviceFacts(win())).toEqual({ family: 'ios', installed: false, secure: true });
    expect(windowDeviceFacts(win({}, true)).installed).toBe(true);
    expect(windowDeviceFacts(win({ standalone: true })).installed).toBe(true);
  });

  it('binds every member as an owner, so a bound request never raises Illegal invocation', async () => {
    let seenThis: unknown;
    const mediaDevices = {
      getUserMedia(this: unknown): Promise<Stream> {
        seenThis = this;
        return Promise.resolve(stream());
      },
    };
    const subject = windowPermissionsHost({ ...win({ mediaDevices }), Notification: undefined });
    const answer: DevicePermissionState = await subject.request('camera');
    expect(answer).toBe('granted');
    expect(seenThis).toBe(mediaDevices);
    expect(subject.facts.family).toBe('ios');
    expect(await subject.status('notifications')).toBe('unsupported');
  });
});
