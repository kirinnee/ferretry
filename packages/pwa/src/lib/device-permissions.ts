/**
 * EVERY PERMISSION FERRETRY CAN USE ON THIS DEVICE, as one list the reader can see and act on.
 *
 * Permissions used to be discovered by failing: the camera prompt appeared (or did not) on the pairing
 * screen, the microphone on the first dictation, notifications behind a toggle. This module names them
 * all in one place so Settings can say what each is for, what its state is right now, and what to do
 * about it — and so a refusal is a sentence a reader can act on rather than a button that does nothing.
 *
 * TWO RULES THE REST FOLLOWS.
 *
 *   * ASKING NEVER HAPPENS BY ITSELF. `status` only READS (a permission query or a feature check — none
 *     of which prompts); `request` is the only call that can put a browser prompt on screen, and the
 *     page calls it from a tap and nowhere else. Browsers punish ambient prompts, and iOS refuses them.
 *
 *   * `request` STARTS ITS BROWSER CALL BEFORE ITS FIRST `await`. iOS shows a camera, microphone or
 *     location prompt only when the call is made inside the user gesture; anything put in front of it —
 *     a permission query, a state read — turns the tap into "no prompt, no error, nothing happens",
 *     which is exactly how the QR scanner failed on iPhone. Every request below is therefore one
 *     synchronous call whose promise is then mapped.
 *
 * NOTHING IS KEPT. A camera or microphone request opens the device just long enough to be answered and
 * stops every track at once; a location request discards its position; a clipboard request discards
 * what it read. The point is the answer, never the data.
 *
 * WHY A PORT. The browser globals this reads cannot be constructed by a test, and the rules worth
 * proving — "an unprompted read stays a read", "a refusal maps to denied", "iOS notifications need the
 * installed app" — are not in any of them. `browserPermissionsHost` is the one function that touches
 * the real APIs, and it takes every one of them as an argument, as OWNERS (`media.getUserMedia(…)`)
 * rather than detached methods, because a stored bare method is the `Illegal invocation` bug.
 */

import { type InstallEnvironment, installPlatform } from './install-prompt.ts';

export type DevicePermissionId =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'location'
  | 'clipboard-read'
  | 'persistent-storage';

/** `prompt` is "not asked yet" — the browser will ask when a request is made. */
export type DevicePermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** The operating-system family decides which Settings screen a refusal is undone in. */
type DeviceFamily = 'ios' | 'android' | 'desktop';

export interface DeviceFacts {
  readonly family: DeviceFamily;
  /** Running as an installed app (home-screen icon), not a browser tab. */
  readonly installed: boolean;
  /** `window.isSecureContext` — cameras, location and push all need it. */
  readonly secure: boolean;
}

export interface DeviceFactsEnvironment extends InstallEnvironment {
  readonly secureContext: boolean;
}

/** What this device is, read once by the composition root. */
export const deviceFacts = (environment: DeviceFactsEnvironment): DeviceFacts => {
  const { userAgent, maxTouchPoints } = environment;
  // iPadOS 13+ announces itself as a Mac; only its touch screen gives it away.
  const ios = /\b(iPhone|iPad|iPod)\b/u.test(userAgent) || (/\bMacintosh\b/u.test(userAgent) && maxTouchPoints > 1);
  const family: DeviceFamily = ios ? 'ios' : /\bAndroid\b/u.test(userAgent) ? 'android' : 'desktop';
  return { family, installed: installPlatform(environment) === 'installed', secure: environment.secureContext };
};

export interface DevicePermissionInfo {
  readonly id: DevicePermissionId;
  readonly label: string;
  /** Plain words: what Ferretry does with it. */
  readonly why: string;
  /** The button that asks, in the reader's words. */
  readonly requestLabel: string;
}

/** In the order Settings lists them: the ones people hit first come first. */
export const DEVICE_PERMISSIONS: readonly DevicePermissionInfo[] = [
  {
    id: 'camera',
    label: 'Camera',
    why: 'Scans the QR code that pairs this device with a machine, and takes photos to attach to a message. It is only on while you are scanning or taking a photo.',
    requestLabel: 'Allow camera',
  },
  {
    id: 'microphone',
    label: 'Microphone',
    why: 'Dictation: turns your speech into text for a message draft. It is only on while you are dictating, and a draft is never sent for you.',
    requestLabel: 'Allow microphone',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    why: 'Tells you when a session needs you, finishes or fails — even with the app closed.',
    requestLabel: 'Allow notifications',
  },
  {
    id: 'location',
    label: 'Location',
    why: 'Lets you share where you are with an agent from the message box (+ › Share my location). One reading, only when you ask; nothing is tracked in the background.',
    requestLabel: 'Allow location',
  },
  {
    id: 'clipboard-read',
    label: 'Clipboard',
    why: 'Pastes text into a remote browser page when you press its paste button. Read only on that tap; Ferretry never watches your clipboard.',
    requestLabel: 'Allow clipboard',
  },
  {
    id: 'persistent-storage',
    label: 'Persistent storage',
    why: 'Asks the browser not to clear what this device keeps — cached sessions and any voice model you downloaded — when it is short on space.',
    requestLabel: 'Keep my data',
  },
];

const INFO_BY_ID: ReadonlyMap<DevicePermissionId, DevicePermissionInfo> = new Map(
  DEVICE_PERMISSIONS.map(info => [info.id, info]),
);

export const devicePermissionInfo = (id: DevicePermissionId): DevicePermissionInfo => {
  const info = INFO_BY_ID.get(id);
  if (info === undefined) throw new Error(`Unknown device permission: ${id}`);
  return info;
};

/** Where a permission is switched back on, per kind of device. Ordered steps, imperative. */
export const howToEnable = (id: DevicePermissionId, facts: DeviceFacts): readonly string[] => {
  const label = devicePermissionInfo(id).label;
  if (id === 'persistent-storage') {
    return [
      'The browser decides this one by itself — usually yes for an installed app or a site you use often.',
      facts.installed
        ? 'You are already using the installed app, which is the best way to get it.'
        : 'Install Ferretry as an app (Settings › This device › Install app), then come back and ask again.',
    ];
  }
  if (facts.family === 'ios') {
    const steps = facts.installed
      ? [
          `Open the Settings app, then find Ferretry in the list of apps (or open Settings › Apps › Safari).`,
          `Turn ${label} to Ask or Allow.`,
        ]
      : [
          `Open the Settings app, then Apps › Safari (or just Safari on older iOS).`,
          `Under Settings For Websites, tap ${label} and choose Ask or Allow.`,
          'Or, in Safari, tap the aA button in the address bar › Website Settings and allow it for this site.',
        ];
    return [...steps, 'Come back to Ferretry and reload; this page checks again when you return.'];
  }
  if (facts.family === 'android') {
    return [
      facts.installed
        ? 'Press and hold the Ferretry icon › App info › Permissions.'
        : 'Tap the lock or settings icon next to the address bar › Permissions.',
      `Set ${label} to Allow (or Ask every time).`,
      'Come back to Ferretry; this page checks again when you return.',
    ];
  }
  return [
    'Click the icon at the left of the address bar (a lock or settings icon) › Site settings.',
    `Set ${label} to Allow (or Ask).`,
    'Reload this page if the browser asks you to.',
  ];
};

/** Why a permission cannot be offered at all on this device, in a sentence that says what would fix it. */
export const unsupportedNote = (id: DevicePermissionId, facts: DeviceFacts): string => {
  if (id === 'notifications' && facts.family === 'ios' && !facts.installed) {
    return 'On iPhone and iPad, notifications only work once Ferretry is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.';
  }
  if (!facts.secure && id !== 'persistent-storage') {
    return 'This needs a secure (https) connection, and this page does not have one.';
  }
  return 'This browser does not offer this.';
};

/** What a row should offer next, decided from its state alone. */
export type PermissionAction = 'request' | 'how-to' | 'none';

export const permissionAction = (state: DevicePermissionState): PermissionAction =>
  state === 'prompt' ? 'request' : state === 'denied' ? 'how-to' : 'none';

/* ---------- the port -------------------------------------------------------- */

export interface DevicePermissionsHost {
  readonly facts: DeviceFacts;
  /** Reads a permission without ever asking for it. Total: a failed read is `prompt`, never a throw. */
  status(id: DevicePermissionId): Promise<DevicePermissionState>;
  /**
   * Asks the browser. Call it from a tap and from nowhere else; the browser call starts before the
   * first `await`. Total: every failure resolves to the state the reader is now in.
   */
  request(id: DevicePermissionId): Promise<DevicePermissionState>;
}

interface MediaTrackLike {
  stop?: () => void;
}

interface MediaStreamLike {
  getTracks?: () => readonly MediaTrackLike[];
}

export interface PermissionsEnvironment {
  readonly facts: DeviceFacts;
  /** `navigator.permissions`. Absent in some browsers; Safari lacks most names. */
  readonly permissions?:
    | { query(descriptor: { readonly name: string }): Promise<{ readonly state: string }> }
    | undefined;
  /** `navigator.mediaDevices` — absent in an insecure context. */
  readonly media?: { getUserMedia?(constraints: unknown): Promise<MediaStreamLike> } | undefined;
  /** The `Notification` class: its static members are the permission. */
  readonly notifications?: { readonly permission: string; requestPermission(): Promise<string> } | undefined;
  readonly geolocation?:
    | {
        getCurrentPosition(
          success: () => void,
          failure: (error: { readonly code: number }) => void,
          options: { readonly maximumAge: number; readonly timeout: number },
        ): void;
      }
    | undefined;
  readonly storage?: { persisted?(): Promise<boolean>; persist?(): Promise<boolean> } | undefined;
  readonly clipboard?: { readText?(): Promise<string> } | undefined;
}

const QUERY_NAMES: Readonly<Partial<Record<DevicePermissionId, string>>> = {
  camera: 'camera',
  microphone: 'microphone',
  location: 'geolocation',
  'clipboard-read': 'clipboard-read',
  'persistent-storage': 'persistent-storage',
};

const REFUSALS = new Set(['NotAllowedError', 'SecurityError']);

const refused = (error: unknown): boolean => REFUSALS.has((error as { name?: string } | null)?.name ?? '');

const stopTracks = (stream: MediaStreamLike): void => {
  for (const track of stream.getTracks?.() ?? []) track.stop?.();
};

export const browserPermissionsHost = (environment: PermissionsEnvironment): DevicePermissionsHost => {
  /** The browser's own word for the state, or `null` when this browser cannot be asked without asking. */
  const query = async (id: DevicePermissionId): Promise<DevicePermissionState | null> => {
    const name = QUERY_NAMES[id];
    if (name === undefined || environment.permissions === undefined) return null;
    try {
      const { state } = await environment.permissions.query({ name });
      return state === 'granted' || state === 'denied' || state === 'prompt' ? state : null;
    } catch {
      // This browser does not know the name; an unknown name is not a refusal.
      return null;
    }
  };

  const status = async (id: DevicePermissionId): Promise<DevicePermissionState> => {
    switch (id) {
      case 'camera':
      case 'microphone':
        if (typeof environment.media?.getUserMedia !== 'function') return 'unsupported';
        return (await query(id)) ?? 'prompt';
      case 'notifications': {
        const notifications = environment.notifications;
        if (notifications === undefined) return 'unsupported';
        return notifications.permission === 'default'
          ? 'prompt'
          : notifications.permission === 'granted'
            ? 'granted'
            : 'denied';
      }
      case 'location':
        if (environment.geolocation === undefined) return 'unsupported';
        return (await query(id)) ?? 'prompt';
      case 'clipboard-read':
        if (typeof environment.clipboard?.readText !== 'function') return 'unsupported';
        return (await query(id)) ?? 'prompt';
      case 'persistent-storage': {
        const storage = environment.storage;
        if (typeof storage?.persist !== 'function') return 'unsupported';
        const asked = await query(id);
        if (asked !== null) return asked;
        try {
          return (await storage.persisted?.()) === true ? 'granted' : 'prompt';
        } catch {
          return 'prompt';
        }
      }
    }
  };

  /** A device open, answered, and shut again in one breath. */
  const openAndRelease = (id: 'camera' | 'microphone'): Promise<DevicePermissionState> => {
    const media = environment.media;
    if (typeof media?.getUserMedia !== 'function') return Promise.resolve('unsupported');
    // The browser call is made HERE, synchronously, with no await before it.
    return media.getUserMedia(id === 'camera' ? { video: true, audio: false } : { audio: true, video: false }).then(
      (stream): DevicePermissionState => {
        stopTracks(stream);
        return 'granted';
      },
      async (error: unknown): Promise<DevicePermissionState> => {
        if (refused(error)) return 'denied';
        const name = (error as { name?: string } | null)?.name;
        return name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unsupported' : await status(id);
      },
    );
  };

  const request = (id: DevicePermissionId): Promise<DevicePermissionState> => {
    switch (id) {
      case 'camera':
      case 'microphone':
        return openAndRelease(id);
      case 'notifications': {
        const notifications = environment.notifications;
        if (notifications === undefined) return Promise.resolve('unsupported');
        return notifications.requestPermission().then(
          (answer): DevicePermissionState =>
            answer === 'granted' ? 'granted' : answer === 'denied' ? 'denied' : 'prompt',
          () => status(id),
        );
      }
      case 'location': {
        const geolocation = environment.geolocation;
        if (geolocation === undefined) return Promise.resolve('unsupported');
        return new Promise<DevicePermissionState>(resolve => {
          geolocation.getCurrentPosition(
            () => resolve('granted'),
            // Code 1 is the refusal. 2 and 3 (no signal, timed out) happen AFTER a grant, so the
            // reader's answer is whatever the browser now says it is.
            error => (error.code === 1 ? resolve('denied') : void status(id).then(resolve)),
            { maximumAge: 600_000, timeout: 15_000 },
          );
        });
      }
      case 'clipboard-read': {
        const clipboard = environment.clipboard;
        if (typeof clipboard?.readText !== 'function') return Promise.resolve('unsupported');
        return clipboard.readText().then(
          (): DevicePermissionState => 'granted',
          async (error: unknown): Promise<DevicePermissionState> => (refused(error) ? 'denied' : await status(id)),
        );
      }
      case 'persistent-storage': {
        const storage = environment.storage;
        if (typeof storage?.persist !== 'function') return Promise.resolve('unsupported');
        return storage.persist().then(
          (granted): DevicePermissionState => (granted ? 'granted' : 'denied'),
          () => status(id),
        );
      }
    }
  };

  return { facts: environment.facts, status, request };
};

/* ---------- the real window ------------------------------------------------- */

/** The slice of `window` the host reads. Every member is an OWNER object, never a detached method. */
export interface PermissionsWindow {
  readonly isSecureContext: boolean;
  readonly navigator: {
    readonly userAgent: string;
    readonly maxTouchPoints: number;
    readonly standalone?: boolean;
    readonly permissions?: PermissionsEnvironment['permissions'];
    readonly mediaDevices?: PermissionsEnvironment['media'];
    readonly geolocation?: PermissionsEnvironment['geolocation'];
    readonly storage?: PermissionsEnvironment['storage'];
    readonly clipboard?: PermissionsEnvironment['clipboard'];
  };
  readonly Notification?: PermissionsEnvironment['notifications'];
  matchMedia(query: string): { readonly matches: boolean };
}

/** This device's facts, read from a window. */
export const windowDeviceFacts = (win: PermissionsWindow): DeviceFacts =>
  deviceFacts({
    userAgent: win.navigator.userAgent,
    maxTouchPoints: win.navigator.maxTouchPoints,
    standaloneDisplay: win.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: win.navigator.standalone,
    secureContext: win.isSecureContext,
  });

/** The production host, bound to a window. */
export const windowPermissionsHost = (win: PermissionsWindow): DevicePermissionsHost =>
  browserPermissionsHost({
    facts: windowDeviceFacts(win),
    permissions: win.navigator.permissions,
    media: win.navigator.mediaDevices,
    notifications: win.Notification,
    geolocation: win.navigator.geolocation,
    storage: win.navigator.storage,
    clipboard: win.navigator.clipboard,
  });
