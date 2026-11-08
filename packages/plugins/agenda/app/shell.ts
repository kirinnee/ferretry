/**
 * THE ONE SEAM to the app shell. Every file of this half takes what the shell owns — its UI kit and hooks, the router,
 * the reference surface, the prose kit, the renderer and slot mounts — from here and from nowhere else, and all of it
 * is `@ferretry/app` (or `/ui`), the one home for shared app facilities (DECISIONS-2 #4). The clock is the browser's:
 * a browser app half may read time and set timers (banned-globals bans neither in app halves).
 *
 * What another plugin owns is never stood in for here. A thing another plugin draws inside an ask (a card, a sign-in
 * approval, a question) is mounted by its renderer key (`RendererView`); the ask screen's conversation and composer are
 * Conversation's panel in the `agenda.conversation` slot this half offers (`PanelSlot`). The machine identity, the
 * client calls and the ferret views are this half's own (`lib/machine.ts`, `lib/agenda-call.ts`,
 * `lib/ferret-view.ts`), re-exported here under today's names so the files that read them change no import.
 */

export {
  BottomSheet,
  Button,
  type ClipboardWriter,
  browserClipboardWriter,
  ConcurrencyLimit,
  ContextFilterChips,
  CopyButton,
  cn,
  composerQuoteTarget,
  registerComposerQuoteTarget,
  useQuoteMenu,
  escapeCloses,
  type Marquee,
  marqueeOf,
  nextDetailsTab,
  RouteLink,
  Spinner,
  Textarea,
  useDialogFocus,
  useLayoutMode,
  usePrefersReducedMotion,
  wordCut,
} from '@ferretry/app/ui';
export {
  browserListRefreshEnvironment,
  ChatProse,
  clockOfInstant,
  daemonOfClient,
  ListRefresh,
  type ListRefreshEnvironment,
  MachineDeadlineError,
  Markdown,
  PanelSlot,
  ReferenceSurfaceProvider,
  RendererView,
  TABLE_VIEW_KEY,
  useOptionalRouter,
  useReferenceSurface,
  useRouter,
  useScreenHref,
} from '@ferretry/app';

export {
  type DaemonConnection,
  type DaemonId,
  type DaemonSessionScope,
  daemonConnection,
  daemonId,
  daemonSessionKey,
  daemonSessionScope,
} from './lib/machine.ts';
export { DaemonResponseError, FyHttpError } from './lib/agenda-call.ts';
export {
  type FerretConfig as SessionConfig,
  type FerretState as SessionState,
  type FerretStatus as SessionStatus,
  type FerretView as SessionView,
  rootViews,
} from './lib/ferret-view.ts';

// ─── small pure helpers, this half's own ─────────────────────────────────────────────────────────────────────────

import { type AgendaId, AgendaIdSchema } from '@ferretry/core-asks/contract';
import type { DaemonId } from './lib/machine.ts';
import { DaemonResponseError } from './lib/agenda-call.ts';

const DAEMON_ID_PATTERN = /^fy_daemon_[A-Za-z0-9_-]{43}$/u;

/**
 * The ask an `#agenda/<id>?session=<ferretId>&machine=<daemon id>` fragment names: `null` for any other fragment, an
 * id that is not one, or a machine that is not a daemon id. A fragment only picks which ask the app opens.
 */
export const agendaDeepLinkFromFragment = (
  fragment: string,
): { readonly id: AgendaId; readonly sessionId?: string; readonly machine?: DaemonId } | null => {
  const match = /^#?agenda\/([^?]+)(?:\?(.*))?$/u.exec(fragment);
  if (match === null) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
  const id = AgendaIdSchema.safeParse(raw);
  if (!id.success) return null;
  const query = new URLSearchParams(match[2] ?? '');
  const session = query.get('session');
  const named = query.get('machine');
  if (named !== null && !DAEMON_ID_PATTERN.test(named)) return null;
  return {
    id: id.data,
    ...(session === null || session.trim() === '' ? {} : { sessionId: session }),
    ...(named === null ? {} : { machine: named as DaemonId }),
  };
};

/** A release or transcript replacement invalidated the caller's message evidence. */
const staleMessageEvidence = (reason: unknown, code: 'message_cursor_stale' | 'selection_stale'): boolean =>
  reason instanceof DaemonResponseError && reason.status === 409 && reason.code === code;

/** Restart a whole paged read once, with fresh accumulators and no cursor from the failed attempt. */
export const withFreshMessageCursor = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (reason) {
    if (!staleMessageEvidence(reason, 'message_cursor_stale')) throw reason;
    return await read();
  }
};

const BRACKET_PREFIX = /^\[([^[\]]+)\]\s*(.*)$/s;

export interface ParsedTask {
  /** Bracketed prefix, when the value had one AND had a task after it. */
  readonly prefix: string | null;
  /** The task text. Empty only when the name itself was empty. */
  readonly task: string;
}

/** Splits a ferret's name into its teammate prefix and its task: `[Hayden] Fix the scroller`. */
export const parseTaskName = (name?: string | null): ParsedTask => {
  const raw = (name ?? '').trim();
  if (!raw) return { prefix: null, task: '' };
  const matched = BRACKET_PREFIX.exec(raw);
  if (!matched) return { prefix: null, task: raw };
  const prefix = (matched[1] ?? '').trim();
  const rest = (matched[2] ?? '').trim();
  if (!rest) return { prefix: null, task: prefix || raw };
  return { prefix: prefix || null, task: rest };
};

const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

/** A callsign Ferretry gave a ferret it started itself (`warden-00002a`), shown as an identifier. */
const isSystemCallsign = (callsign: string): boolean => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  return match?.[2] !== undefined && Number.parseInt(match[2], 16) !== 0;
};

/** Title-cases a callsign slug for display: `ms-98` → `Ms-98`; a system callsign shows its hex digits uppercase. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  if (isSystemCallsign(slug)) {
    const match = SYSTEM_CALLSIGN_PATTERN.exec(slug);
    return `${(match?.[1] ?? '').toLowerCase()}-${(match?.[2] ?? '').toUpperCase()}`;
  }
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

/** A machine's own pages (`/d/<id>`) and the app's home: the notification paths' roots. */
export { daemonHomeHref, HOME_HREF, notificationTapTarget } from '@ferretry/app';
