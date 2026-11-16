/**
 * THE IN-APP NOTIFICATION WATCH IS MOUNTED (triage B11). Agenda defined `useNotificationWatch` but contributed no
 * background view, so enabled local notifications for an unattended ferret never fired while the app was open. The shell
 * mounts a background view once per paired daemon at the frame root (S5); this one runs the fleet-diff watch for its
 * daemon over its own background-origin client. Permission is never requested here — only read.
 */

import { describe, expect, it } from 'bun:test';
import { mount } from '@ferretry/app/testing';
import half from '../../../app/index.ts';
import { daemonId } from '../../../app/lib/machine.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../../app/lib/notification-preferences.ts';
import type { NotificationSurface } from '../../../app/lib/notify.ts';
import type { NotifiedFleet, NotifiedView } from '../../../app/lib/notification-ledger.ts';
import {
  createNotificationWatchView,
  type NotificationWatchWiring,
} from '../../../app/views/agenda-notification-watch-view.tsx';

const DAEMON = 'daemon-a';

const view = (status: NotifiedView['state']['status']): NotifiedView => ({
  config: { id: 'f1', name: 'Fix it' },
  state: { status },
});

const fleetOf = (status: NotifiedView['state']['status']): NotifiedFleet => ({
  daemons: new Map([[daemonId(DAEMON), { sessions: [view(status)] }]]),
});

const wiring = () => {
  let current = fleetOf('working');
  const listeners = new Set<() => void>();
  const shown: { title: string; tag: string }[] = [];
  let permissionAsks = 0;
  const surface: NotificationSurface = {
    permission: () => 'granted',
    requestPermission: async () => {
      permissionAsks += 1;
      return 'granted';
    },
    registration: async () => ({
      getNotifications: async () => [],
      showNotification: async (title, options) => {
        shown.push({ title, tag: options?.tag ?? '' });
      },
    }),
    showOnPage: null,
    navigate: () => {},
  };
  const wired: NotificationWatchWiring = {
    host: {
      sessions: {
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => current,
      },
      preferences: { get: () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true, onlyWhenHidden: false }) },
      filter: new DeviceNotificationFilterStore(),
      surface,
      hidden: () => true,
      foregroundSession: () => null,
      now: () => 1_000_000,
    },
    permission: () => 'granted',
    subscribePermission: () => () => {},
  };
  return {
    wired,
    shown,
    asks: () => permissionAsks,
    move: (status: NotifiedView['state']['status']) => {
      current = fleetOf(status);
      for (const listener of listeners) listener();
    },
  };
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('Agenda’s notification-watch background view', () => {
  it('is contributed to shell.background, so the shell mounts it once per paired daemon', () => {
    expect(Object.keys(half.shell.background ?? {})).toEqual(['notification-watch']);
  });

  it('draws nothing, notifies a ferret that died, and never asks for permission itself', async () => {
    const rig = wiring();
    const View = createNotificationWatchView(() => rig.wired);
    const mounted = await mount(<View daemon={DAEMON} client={{} as never} />);
    await settle();
    expect(rig.shown).toEqual([]);

    rig.move('failed');
    await settle();
    await mounted.unmount();

    expect(rig.shown.map(each => each.title)).toEqual(['Fix it']);
    expect(rig.asks()).toBe(0);
  });
});
