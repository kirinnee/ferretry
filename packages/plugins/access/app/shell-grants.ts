/**
 * THE GRANTS / STEP-UP / SECURITY HALF'S SHELL SEAM.
 *
 * Every name below is something today's PWA files imported from a shared PWA module (the app store, the
 * shell primitives, the settings rows, the daemon client) or from an old package (`@ferretry/protocol`'s
 * client, `@ferretry/relay`) that has NO HOME in 5.0 yet. Each is a short, clearly marked copy or a
 * typed stand-in, kept here — in one file — so the app shell can replace them in one place when it lands.
 * Nothing here is new behaviour: a copy is today's code, and a stand-in behaves as today's code does
 * OUTSIDE the app store (no client, no prompt).
 *
 * Where each lives today, and whether `origin/rebuild/spine-app-shell` has it:
 *   - cn / ClassValue ............ pwa/src/lib/class-names.ts ............ nowhere (copy)
 *   - DaemonId / DaemonConnection  pwa/src/lib/daemon-connection.ts ...... nowhere (re-exported from shell-pairing.ts)
 *   - daemonConnection ........... pwa/src/lib/daemon-connection.ts ...... nowhere (re-exported from shell-pairing.ts)
 *   - useDaemonClient ............ pwa/src/lib/store.tsx ................. nowhere (stand-in: no store)
 *   - useStepUpRequest ........... pwa/src/lib/store.tsx ................. nowhere (stand-in: no store)
 *   - Button ..................... pwa/src/shell/primitives.tsx .......... nowhere (copy)
 *   - SettingRow / SettingDisclosureRow  pwa/src/features/settings/setting-row.tsx  nowhere (stand-in)
 *   - settingDefinition .......... pwa/src/features/settings/settings-catalog.ts  nowhere (stand-in, one entry)
 *   - useDialogFocus ............. pwa/src/hooks/use-dialog-focus.ts ..... nowhere (copy)
 *   - installPlatform / InstallEnvironment  pwa/src/lib/install-prompt.ts  nowhere (copy)
 *   - IFyApiClient ............... protocol/src/lib/client.ts ............ nowhere (`request` only)
 *   - FyHttpError ................ protocol/src/adapters/fy-api-client.ts  nowhere (typed stand-in)
 *   - toBase64Url / fromBase64Url  relay/src/lib/binary.ts ............... spine-app-shell
 *                                  `packages/app/src/session/wire/binary.ts` (copy of it)
 *   - SecurityNumberField, SecuritySettingsChange(Schema)  protocol/src/lib/security.ts  not in Gate's contract (copy)
 *   - UnlockGranted .............. protocol/src/lib/security.ts ........... Gate exports only the schema (type here)
 *   - AuditEvent ................. protocol/src/lib/audit.ts .............. Gate's `AuditKindName` (alias here)
 */

import {
  type AuditKindName,
  type SecuritySettingField,
  SecuritySettingsViewSchema,
  type SecuritySwitchField,
  type UnlockGrantedSchema,
} from '@ferretry/core-gate/contract';
import {
  type ComponentPropsWithRef,
  createElement,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import type { DaemonConnection } from './shell-pairing.ts';

// ─── class names (copy of pwa/src/lib/class-names.ts) ─────────────────────────────────────────────────────────────

export type ClassValue = string | number | bigint | null | undefined | boolean | ClassValue[] | ClassDictionary;

interface ClassDictionary {
  readonly [key: string]: unknown;
}

const appendTo = (parts: string[], value: ClassValue): void => {
  if (value === null || value === undefined || value === false || value === true || value === '') return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) appendTo(parts, entry);
    return;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (enabled) parts.push(key);
  }
};

/** Joins every truthy class expression with a single space. */
export function cn(...values: readonly ClassValue[]): string {
  const parts: string[] = [];
  for (const value of values) appendTo(parts, value);
  return parts.join(' ');
}

// ─── the daemon connection (pwa/src/lib/daemon-connection.ts) ─────────────────────────────────────────────────────

/**
 * ONE IDENTITY FOR A DAEMON ACROSS THE ACCESS APP HALF. The pairing half's seam already carries today's `DaemonId`,
 * `DaemonConnection` and `daemonConnection`, and `DaemonId` is a `unique symbol` brand, so a second copy here would be
 * a second type that would not match (the device-notice code takes the pairing half's). Re-exported instead.
 */
export { type DaemonConnection, type DaemonId, daemonConnection } from './shell-pairing.ts';

// ─── the daemon client (stand-ins for `@ferretry/protocol/client`) ───────────────────────────────────────────────

/** The one client capability these screens use (today's `Pick<IFyApiClient, 'request'>`). */
export interface IFyApiClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T>;
}

/** Today's `FyHttpError`: a daemon refusal with its status, code and whole body. */
export class FyHttpError extends Error {
  override readonly name = 'FyHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

// ─── the app store (stand-ins for pwa/src/lib/store.tsx) ─────────────────────────────────────────────────────────

/**
 * The typed client a screen reaches a daemon through. STAND-IN: there is no app store here yet, so this is
 * today's outside-the-store answer — a refusal that says so, never a client pointed at nothing.
 */
export function useDaemonClient(): (daemon: DaemonConnection) => Promise<IFyApiClient> {
  return useCallback(async (_daemon: DaemonConnection): Promise<IFyApiClient> => {
    throw new Error('no daemon client exists outside the app store');
  }, []);
}

/**
 * The app's ONE passkey prompt, as a function a screen can call before a press. STAND-IN: outside the store
 * there is no prompt, so the answer is `undefined` and a screen offers no step-up control.
 */
export function useStepUpRequest(): ((daemon: DaemonConnection, act?: string) => Promise<boolean>) | undefined {
  return undefined;
}

// ─── shell primitives (copy of pwa/src/shell/primitives.tsx `Button`) ─────────────────────────────────────────────

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';
type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({ className, variant = 'outline', size = 'md', ...rest }: ButtonProps) {
  return createElement('button', {
    'data-variant': variant === 'outline' ? undefined : variant,
    className: cn('kt-btn', size === 'sm' && 'kt-btn--sm', className),
    ...rest,
  });
}

// ─── settings rows (stand-ins for pwa/src/features/settings/setting-row.tsx and settings-catalog.ts) ─────────────

export interface SettingRowProps {
  readonly settingId?: string;
  readonly name: string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
}

const rowAnchor = (settingId: string | undefined) =>
  settingId === undefined ? {} : { id: `settings-${settingId}`, 'data-setting-id': settingId, tabIndex: -1 };

/** STAND-IN: one settings row — its name, its hint, and anything it holds. */
export function SettingRow({ settingId, name, hint, children }: SettingRowProps) {
  return createElement(
    'li',
    { ...rowAnchor(settingId), 'data-setting-row': name },
    createElement('span', null, name),
    hint === undefined ? null : createElement('span', null, hint),
    children,
  );
}

export interface SettingDisclosureRowProps extends SettingRowProps {
  readonly value?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}

/** STAND-IN: a settings row that opens to show what it holds, behind one `aria-expanded` button. */
export function SettingDisclosureRow({
  settingId,
  name,
  hint,
  value,
  onOpenChange,
  children,
}: SettingDisclosureRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return createElement(
    'li',
    { ...rowAnchor(settingId), 'data-setting-row': name },
    createElement(
      'button',
      {
        type: 'button',
        'aria-expanded': open,
        'aria-controls': `${id}-more`,
        onClick: () => {
          setOpen(!open);
          onOpenChange?.(!open);
        },
      },
      createElement('span', null, name),
      hint === undefined ? null : createElement('span', null, hint),
      value === undefined ? null : createElement('span', null, value),
    ),
    open ? createElement('div', { id: `${id}-more`, 'data-setting-panel': '' }, children) : null,
  );
}

/** STAND-IN: the settings catalog entry these screens read (today's text for `device-permissions`). */
const SETTING_DESCRIPTIONS = {
  'device-permissions':
    'Every permission Ferretry can use on this device — camera, microphone, notifications, location, clipboard and storage — with what it is for, whether it is allowed, and how to turn it on. Nothing is asked for until you press its button.',
} as const;

export function settingDefinition(id: keyof typeof SETTING_DESCRIPTIONS): { readonly description: string } {
  return { description: SETTING_DESCRIPTIONS[id] };
}

// ─── dialog focus (copy of pwa/src/hooks/use-dialog-focus.ts) ─────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Open overlays, oldest first. Exactly one of them — the last — owns Escape. */
const ESCAPE_LAYERS: object[] = [];

export function pushEscapeLayer(token: object): () => void {
  ESCAPE_LAYERS.push(token);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = ESCAPE_LAYERS.lastIndexOf(token);
    if (at !== -1) ESCAPE_LAYERS.splice(at, 1);
  };
}

export function isTopEscapeLayer(token: object): boolean {
  return ESCAPE_LAYERS.length > 0 && ESCAPE_LAYERS[ESCAPE_LAYERS.length - 1] === token;
}

export interface DialogFocus {
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { autoFocus?: boolean } = {},
): DialogFocus {
  const { autoFocus = true } = options;
  const restoreTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const layer = useRef<object>({});

  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isTopEscapeLayer(token)) return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) {
      restoreTo.current = document.activeElement as HTMLElement | null;
      if (autoFocus) ref.current?.focus();
      return;
    }
    const previous = restoreTo.current;
    restoreTo.current = null;
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
  }, [open, autoFocus, ref]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        element => element.offsetParent !== null || element === document.activeElement,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [ref],
  );

  return { onKeyDown };
}

// ─── install platform (copy of pwa/src/lib/install-prompt.ts, the two names device-permissions reads) ───────────────

export interface InstallEnvironment {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** `matchMedia('(display-mode: standalone)')` — true inside an installed app. */
  readonly standaloneDisplay: boolean;
  /** iOS Safari's own flag for a home-screen app; `undefined` everywhere else. */
  readonly navigatorStandalone?: boolean | undefined;
}

export type InstallPlatform = 'installed' | 'ios' | 'browser';

const IOS_DEVICE = /\b(iPhone|iPad|iPod)\b/u;

export const installPlatform = (environment: InstallEnvironment): InstallPlatform => {
  if (environment.standaloneDisplay || environment.navigatorStandalone === true) return 'installed';
  const iPadAsMac = /\bMacintosh\b/u.test(environment.userAgent) && environment.maxTouchPoints > 1;
  return IOS_DEVICE.test(environment.userAgent) || iPadAsMac ? 'ios' : 'browser';
};

// ─── base64url (copy of spine-app-shell packages/app/src/session/wire/binary.ts) ──────────────────────────────────

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Decode unpadded base64url, refusing anything that is not exactly that. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text)) return null;
  if (text.length % 4 === 1) return null;
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return toBase64Url(bytes) === text ? bytes : null;
}

// ─── wire names Gate's contract does not carry yet (copies of protocol/src/lib/security.ts and audit.ts) ─────────

/** The settings that are a bounded whole number. */
export type SecurityNumberField = Exclude<SecuritySettingField, SecuritySwitchField>;

/**
 * What a change answers: the settings now in force, and how many paired devices the new idle period will unpair
 * at the next check. `0` for a change that did not shorten it.
 */
export const SecuritySettingsChangeSchema = z.strictObject({
  view: SecuritySettingsViewSchema,
  devicesExpiring: z.number().int().min(0),
});
export type SecuritySettingsChange = z.infer<typeof SecuritySettingsChangeSchema>;

/** The answer to an unlock. */
export type UnlockGranted = z.infer<typeof UnlockGrantedSchema>;

/** Every core audit kind by name (today's `AuditEvent`). */
export type AuditEvent = AuditKindName;

/**
 * The machine a settings tab or panel is about. STAND-IN until packages/app's app-half connect interface lands (the
 * lead names it): there is no store here to pick a machine from, so nothing is rendered rather than a guess.
 */
export function useSelectedDaemon(_subject?: string): DaemonConnection | undefined {
  return undefined;
}

/** Opens Settings › ‹machine› › Security. STAND-IN: the router is the shell's. */
export function useOpenSecurity(): () => void {
  return useCallback(() => undefined, []);
}
