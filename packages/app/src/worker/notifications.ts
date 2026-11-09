/**
 * THE WORKER'S OWN PUSH AND NOTIFICATION RULES, copied from today's PWA (`lib/push-scope.ts`, `lib/notification-open.ts`,
 * `lib/notify.ts`): the parts the service worker itself runs. Pure — the worker binds the browser objects — so it is
 * tested without a worker.
 *
 * ONE PUSH WORKER PER MACHINE. A browser holds one push subscription per service-worker registration, bound to the
 * VAPID key of the daemon that made it. So each machine gets its own registration of the SAME signed worker file at
 * `/push/<daemonId>/`, and the worker learns which machine it serves from its own registration scope — which this
 * browser chose, never a push. It then titles every notification with the reader's own label for that machine (carried
 * in the worker script's query), and a tap opens only a page the shell's route parse accepts under that machine (`/d/<daemonId>`),
 * whatever URL a push named. A push that reaches the app-wide registration (`/`) is titled "Unverified" and carries the app
 * (`/app/`), whatever it named; a notification the PAGE showed there keeps its machine page on a tap (below).
 *
 * NO PLUGIN CODE RUNS IN THIS WORKER. Every byte here is the shell's own and part of the signed release. A plugin that
 * needs worker behaviour (Agenda's notification kinds, a `clear` push, this device's notification filter) asks for it as
 * declarative data the worker interprets, declared in the KERNEL's contract: the push message (`readPushMessage`: a show
 * with `tag`, `kind`, `count`, `urgency`, or a `clear` naming tags) and this device's filter document. A payload that
 * has none is shown the way today's worker shows one it cannot read: plainly, so a subscription that received a push is
 * never left showing nothing (the browser penalises that and eventually revokes it).
 */

import { PUSH_TAG_PATTERN, PUSH_URL_MAX } from '@ferretry/kernel/contract/push-envelope';
import { daemonHomeHref, HOME_HREF, routeTable } from '../router/routes.ts';
import { PUSH_TAP_SCREENS } from '../router/tap-target.ts';
import { NOTIFICATION_OPEN_ACK, PUSH_LABEL_PARAMETER, PUSH_SCOPE_ROOT } from './facts.ts';
import { notificationOpenMessage } from './notification-open.ts';

export { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE, PUSH_SCOPE_ROOT } from './facts.ts';

/**
 * The Ferretry mark every notification carries, from the app's own committed icons. Same-origin paths, so a push never
 * names an image service. Platforms without one of them (iOS has no badge) simply ignore it.
 */
export const NOTIFICATION_ICON = '/icons/icon-any-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-96.png';

/** The mark, as notification options. */
export const notificationBrand = (): { readonly icon: string; readonly badge: string } => ({
  icon: NOTIFICATION_ICON,
  badge: NOTIFICATION_BADGE,
});

/** The machine one push registration serves, as this browser registered it. */
export interface PushMachine {
  readonly daemonId: string;
  /** The reader's label for it; the daemon id when the script named none. */
  readonly label: string;
}

/**
 * Which machine a registration serves, from its scope URL and its script URL — or `null` for the app's own
 * registration (scope `/`) and anything else that is not a per-machine push scope.
 */
export const pushMachineOf = (scope: string, scriptUrl: string): PushMachine | null => {
  const path = URL.parse(scope)?.pathname ?? '';
  if (!path.startsWith(PUSH_SCOPE_ROOT)) return null;
  const segment = path.slice(PUSH_SCOPE_ROOT.length).replace(/\/$/u, '');
  if (segment === '' || segment.includes('/')) return null;
  let daemonId: string;
  try {
    daemonId = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const label = URL.parse(scriptUrl)?.searchParams.get(PUSH_LABEL_PARAMETER)?.trim() ?? '';
  return { daemonId, label: label === '' ? daemonId : label };
};

/** What a push that reached the app-wide registration says it is: from no machine this browser can name. */
export const UNVERIFIED_LABEL = 'Unverified';

/** What a push nobody composed is shown as, so a subscription is never punished for a silent push. */
export const unreadablePushTitle = (machine: PushMachine | null): string =>
  machine === null ? `${UNVERIFIED_LABEL} · Ferretry` : `${machine.label} · Ferretry`;

/** The body of that notification. */
const UNREADABLE_PUSH_BODY = 'Something is waiting in your Agenda.';

/** The screens a push may name, as the shell's own route parse knows them (see `PUSH_TAP_SCREENS`). */
const TAP_ROUTES = routeTable(PUSH_TAP_SCREENS);

/**
 * The most `?ask=` may carry: an Agenda id (Asks' `AgendaIdSchema`). The app reads no more of the query than this one
 * parameter. The worker imports no plugin contract, so a unit test beside Agenda pins this to that schema.
 */
export const PUSH_ASK_PATTERN = /^A[1-9][0-9]*$/u;
/** A ferret's id in a chat address (Ferrets' `FerretIdSchema`); a test beside Conversation pins the two together. */
export const PUSH_FERRET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PATH_CHARACTERS = /^[A-Za-z0-9._~%/-]*$/u;
/** A decoded segment that is a separator or a control character (code 0-31 or 127) is no ferret or machine name. */
const isUnsafeSegment = (decoded: string): boolean =>
  [...decoded].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return character === '/' || character === '\\' || code <= 0x1f || code === 0x7f;
  });

const sameMachine = (segment: string | undefined, machine: PushMachine): boolean => {
  try {
    return segment !== undefined && decodeURIComponent(segment) === machine.daemonId;
  } catch {
    return false;
  }
};

/** The raw value of the one query parameter a tap reads, `ask`; any other parameter is ignored. */
const askIn = (query: string): string | null => {
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at) === 'ask') return pair.slice(at + 1);
  }
  return null;
};

const appHome = (origin: string): string => new URL(HOME_HREF, origin).href;

/** Where a quiet line's tap goes: the machine's home, or — for the app-wide registration — the app. */
export const machineHomeUrl = (machine: PushMachine | null, origin: string): string =>
  new URL(machine === null ? HOME_HREF : daemonHomeHref(machine.daemonId), origin).href;

const decodeSegment = (segment: string): string | null => {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '' || decoded === '.' || decoded === '..' || isUnsafeSegment(decoded) ? null : decoded;
  } catch {
    return null;
  }
};

/** A machine id a stored address names: any id the shell can file a machine under (it may hold a `/`), but never a dot segment or a control character. */
const decodeMachineId = (segment: string): string | null => {
  try {
    const decoded = decodeURIComponent(segment);
    const unsafe = [...decoded].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return character === '\\' || code <= 0x1f || code === 0x7f;
    });
    return decoded === '' || decoded === '.' || decoded === '..' || unsafe ? null : decoded;
  } catch {
    return null;
  }
};

/**
 * Where a push's `url` asks to go, as a path under `machine` plus an optional `ask`, or `null` when it names nothing
 * the shell's route parse accepts. The grammar is closed: the machine's home (`/d/<id>`) and the screens in
 * {@link PUSH_TAP_SCREENS}, named relative to the machine (`/ferrets/<id>/chat?ask=A3`) or already under it
 * (`/d/<id>/ferrets/<id>/chat?ask=A3`). Nothing is passed through: the address is REBUILT from the parsed route, so
 * only an accepted route, one `ask`, and nothing else the push said can reach the tap.
 */
const machineTarget = (raw: string, machine: PushMachine | null): { path: string; ask: string | null } | null => {
  if (raw.length > PUSH_URL_MAX || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const parts = /^([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/u.exec(raw);
  const pathname = parts?.[1];
  if (pathname === undefined || !PATH_CHARACTERS.test(pathname)) return null;
  const segments = (pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname)
    .slice(1)
    .split('/');
  const first = segments[0];
  let absolute = segments;
  let daemonId: string;
  if (first === 'ferrets' || first === 'agenda') {
    // A machine-relative page needs a machine to be relative to: the app-wide registration has none.
    if (machine === null || segments.some(segment => decodeSegment(segment) === null)) return null;
    daemonId = machine.daemonId;
    absolute = ['d', encodeURIComponent(daemonId), ...segments];
  } else {
    if (first !== 'd' || segments.slice(2).some(segment => decodeSegment(segment) === null)) return null;
    // A machine's own worker keeps to its machine; the id is compared as the shell encodes it (an id may itself hold a `/`,
    // as `%2F`, which no other segment may). With no machine, the stored address names one and the page decides (below).
    const named = segments[1] === undefined ? null : decodeMachineId(segments[1]);
    if (machine === null ? named === null : !sameMachine(segments[1], machine)) return null;
    daemonId = machine === null ? (named as string) : machine.daemonId;
  }
  const query = parts?.[2];
  const ask = query === undefined ? null : askIn(query);
  if (ask !== null && !PUSH_ASK_PATTERN.test(ask)) return null;
  const route = TAP_ROUTES.parse(`/${absolute.join('/')}`);
  if (route.kind === 'daemon-home' && route.daemon === daemonId && ask === null) {
    return { path: daemonHomeHref(daemonId), ask };
  }
  if (route.kind === 'screen' && route.daemon === daemonId) {
    const ferret = route.params.ferret;
    if (ferret !== undefined && !PUSH_FERRET_PATTERN.test(ferret)) return null;
    return { path: TAP_ROUTES.href(route.screen, route.params, route.daemon), ask };
  }
  return null;
};

/**
 * Where a notification tap may go, decided from a push's `url` — NOT TRUSTED INPUT. A tap opens only this site, and
 * only a page the shell's route parse accepts and that belongs to the machine whose worker received the push:
 * that machine's home or a screen in {@link PUSH_TAP_SCREENS} under it. Anything else — another origin, `javascript:`,
 * `//host`, a backslash, encoded or literal traversal, an encoded slash, another machine's page, an unknown route, `/`
 * — opens the app (`/app/`).
 *
 * The app-wide registration knows no machine and its pushes are named "Unverified", so a PUSH it receives always carries
 * the app, whatever it says (see {@link notificationClickUrl} for a line a page showed).
 */
export const notificationUrl = (raw: unknown, origin: string, machine: PushMachine | null): string => {
  if (machine === null || typeof raw !== 'string') return appHome(origin);
  const target = machineTarget(raw, machine);
  if (target === null) return appHome(origin);
  return new URL(target.ask === null ? target.path : `${target.path}?ask=${target.ask}`, origin).href;
};

/**
 * The `data.url` a notification carries back to its click, read through the same closed list: a notification with no
 * `data`, or one a page showed with a foreign address, still opens only what the rule allows. A relative address is read
 * against the site.
 *
 * A machine's worker keeps to its machine. The app-wide worker has none, so it keeps an absolute `/d/<id>/…` page on the
 * list (rebuilt) — the deep link a page-shown "needs input" line carries — and the PAGE refuses a machine this browser has
 * not paired (`notificationTapTarget`, run by the open handler), because only the page holds the pairings.
 */
export const notificationClickUrl = (stored: unknown, origin: string, machine: PushMachine | null): string => {
  // A relative address (a page's own `data.url`) is read against this site, like the browser would.
  const url = typeof stored === 'string' ? URL.parse(stored, origin) : null;
  if (url === null || url.origin !== origin) return appHome(origin);
  const target = machineTarget(`${url.pathname}${url.search}`, machine);
  if (target === null) return appHome(origin);
  return new URL(target.ask === null ? target.path : `${target.path}?ask=${target.ask}`, origin).href;
};

/**
 * What the worker shows for a push it cannot read (no `readPushMessage`): plainly, with no page, so a subscription that
 * received a push is never left showing nothing.
 */
export const unreadablePush = (machine: PushMachine | null): { readonly title: string; readonly body: string } => ({
  title: unreadablePushTitle(machine),
  body: UNREADABLE_PUSH_BODY,
});

/**
 * The tap a notification carries back to its click: the page it may open (read through the same closed list as ever) and
 * the daemon's own tag of the line, kept only if it fits the kernel's tag grammar. `data` is NOT TRUSTED — a notification a
 * page showed carries whatever that page put there.
 */
export const notificationClick = (
  stored: unknown,
  origin: string,
  machine: PushMachine | null,
): { readonly url: string; readonly tag?: string } => {
  const data = typeof stored === 'object' && stored !== null ? (stored as { url?: unknown; tag?: unknown }) : undefined;
  const tag = typeof data?.tag === 'string' && PUSH_TAG_PATTERN.test(data.tag) ? data.tag : undefined;
  return { url: notificationClickUrl(data?.url, origin, machine), ...(tag === undefined ? {} : { tag }) };
};

// ─── a tap opens its page inside the running app, not by reloading it ─────────────────────────────────────────────

/** How long the worker waits for the page to say it took the open before it navigates the window instead. */
export const NOTIFICATION_OPEN_ACK_MS = 1_000;

/** The open window, as the worker sees it. */
export interface NotificationWindow {
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** What the worker needs to wait for a reply; the real channel and timers unless a suite fixes them. */
export interface NotificationOpenEnvironment {
  readonly channel: () => Pick<MessageChannel, 'port1' | 'port2'>;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const browserOpenEnvironment: NotificationOpenEnvironment = {
  channel: () => new MessageChannel(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Brings the window forward — first, while the tap still counts as the reader's own gesture — then asks its page to
 * route to `url`. When no page says it took it, navigates the window; when that is refused too (this worker does not
 * control the window: a machine's push worker controls no page), opens `url` in a window of its own.
 */
export const openInWindow = async (
  window: NotificationWindow,
  url: string,
  openWindow: (url: string) => Promise<unknown>,
  environment: NotificationOpenEnvironment = browserOpenEnvironment,
  tag?: string,
): Promise<'routed' | 'navigated' | 'opened'> => {
  await window.focus().catch(() => undefined);
  const routed = await new Promise<boolean>(resolve => {
    const channel = environment.channel();
    const settle = (answer: boolean): void => {
      environment.clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(answer);
    };
    const timer = environment.setTimeout(() => settle(false), NOTIFICATION_OPEN_ACK_MS);
    channel.port1.onmessage = event => {
      if (event.data === NOTIFICATION_OPEN_ACK) settle(true);
    };
    try {
      window.postMessage(notificationOpenMessage(url, tag), [channel.port2]);
    } catch {
      settle(false);
    }
  });
  if (routed) return 'routed';
  try {
    await window.navigate(url);
    return 'navigated';
  } catch {
    await openWindow(url);
    return 'opened';
  }
};

/** Pages on this site that are not the app: a popup a sign-in opened, a push worker's own scope. */
const NOT_THE_APP = ['/oauth/', '/push/'];

/** The app's own pages, as `public/_redirects` serves them; everything else is the landing page or the setup guide. */
const isAppPage = (pathname: string): boolean =>
  pathname === '/app' ||
  pathname.startsWith('/app/') ||
  pathname.startsWith('/d/') ||
  pathname === '/setup' ||
  // `/join` is left out on purpose: a notification tap must not route a tab away mid-join and drop the code.
  pathname === '/shared' ||
  pathname === '/pair' ||
  pathname.startsWith('/pair/');

/** The slice of a `WindowClient` the choice reads; `focused` and `visibilityState` are optional for tests. */
export interface NotificationWindowCandidate {
  readonly url: string;
  readonly focused?: boolean;
  readonly visibilityState?: string;
}

/**
 * Which open window a tap should reuse, or `undefined` to open a new one. Only this site's windows, never a sign-in
 * popup or a push scope; an APP window wins over the landing page, and among those the focused, then the visible one.
 * Ties keep the browser's own order (most recently focused first).
 */
export const notificationWindow = <T extends NotificationWindowCandidate>(
  windows: readonly T[],
  origin: string,
): T | undefined => {
  const score = (candidate: T): number => {
    const url = URL.parse(candidate.url);
    if (url === null || url.origin !== origin || NOT_THE_APP.some(prefix => url.pathname.startsWith(prefix))) return -1;
    return (
      (isAppPage(url.pathname) ? 4 : 0) +
      (candidate.focused === true ? 2 : 0) +
      (candidate.visibilityState === 'visible' ? 1 : 0)
    );
  };
  let best: T | undefined;
  let bestScore = -1;
  for (const candidate of windows) {
    const value = score(candidate);
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }
  return best;
};
