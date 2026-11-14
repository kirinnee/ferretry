/**
 * THIS BROWSER AS A `NotificationSurface`: the only place the watch reaches a browser global, so the watch itself stays
 * provable by executed tests. Permission is only ever READ here (`requestPermission` is the reader-initiated control's,
 * Access's, never an effect), the registration is the page's own worker's, and a page-level click goes to an in-app path.
 */

import type { NotificationPermissionState, NotificationSurface, PageNotificationLike } from './notify.ts';

const permissionOf = (): NotificationPermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as NotificationPermissionState);

export const browserNotificationSurface = (navigate: (path: string) => void): NotificationSurface => ({
  permission: permissionOf,
  requestPermission: async () => {
    if (typeof Notification === 'undefined') return 'unsupported';
    await Notification.requestPermission();
    return permissionOf();
  },
  registration: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  },
  showOnPage:
    typeof Notification === 'undefined'
      ? null
      : (title, options) => new Notification(title, options as NotificationOptions) as unknown as PageNotificationLike,
  navigate,
});

/** Calls `listener` when the permission may have changed: the browser's own change event, and the page coming back. */
export const subscribeNotificationPermission = (listener: () => void): (() => void) => {
  const stops: (() => void)[] = [];
  const target = globalThis as unknown as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
  for (const name of ['focus', 'visibilitychange'] as const) {
    target.addEventListener?.(name, listener);
    stops.push(() => target.removeEventListener?.(name, listener));
  }
  try {
    void navigator.permissions
      ?.query({ name: 'notifications' })
      .then(status => {
        status.addEventListener('change', listener);
        stops.push(() => status.removeEventListener('change', listener));
      })
      .catch(() => undefined);
  } catch {
    // No Permissions API: focus and visibility are enough.
  }
  return () => {
    for (const stop of stops) stop();
  };
};
