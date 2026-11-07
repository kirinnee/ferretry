/**
 * THE ACCOUNTS APP HALF'S SHELL SEAM. Every name here is something today's PWA files took from a shared PWA module or
 * an old package that has NO HOME in 5.0 yet; each is a short copy or a typed stand-in, kept in this one file so the
 * app shell can replace them in one place (the pattern Access's app port keeps in its own seam).
 *
 *   - AccountsClient ......... protocol `IFyApiClient.request` ........ the plugin client's `call`, by route key
 *   - icons .................. lucide-react (not a 5.0 dependency) ... inline SVG of the same eight shapes
 *   - readDefaults ........... config-files-api `readConfigFile` ..... STAND-IN: Gate's config route is not a route a
 *                                                                        plugin client can call, so the defaults read
 *                                                                        as "cannot be shown here" (never as "none")
 *   - grantRefusalNotice ..... pwa/src/lib/grants.ts ................. STAND-IN: the codes are Gate's; one plain
 *                                                                        explanation, then the daemon's own sentence
 *                                                                        (Access's app port carries the full copy)
 *   - useAddKeyStepUp ........ pwa/src/lib/store.tsx ................. NOT PASSED: Access's passkey ceremony is not on
 *                                                                        this base, so `addKey` is absent and no seed
 *                                                                        can be saved from here (today's no-passkey path)
 */
import { GRANT_REFUSALS, grantRefusalCode } from '@ferretry/core-gate/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { DefaultsRead } from './lib/accounts-screen.ts';

/** The only client capability the app half's calls consume. */
export type AccountsClient = Pick<PluginClient, 'call'>;

/** The defaults, as this build can show them: never, so the screen says where to read them instead. */
export const readDefaults = async (_client: AccountsClient): Promise<DefaultsRead> => ({
  kind: 'unreadable',
  why: 'This app cannot show accounts.yaml yet: read it under Settings › Config files, or with `fy config`',
});

const GRANT_CODES: ReadonlySet<string> = new Set(GRANT_REFUSALS.map(grantRefusalCode));

/** A grant refusal (a 403, or a 503 when the daemon cannot read its grants) as words, or `null` for any other failure. */
export function grantRefusalNotice(
  error: unknown,
): { readonly detail: string; readonly guidance: { readonly explanation: string } } | null {
  if (error === null || typeof error !== 'object') return null;
  const failure = error as { readonly status?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (typeof failure.code !== 'string' || !GRANT_CODES.has(failure.code)) return null;
  if (failure.status !== 403 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' ? failure.message : '';
  return { detail, guidance: { explanation: 'This device’s access to this machine does not allow that.' } };
}

// ─── icons (lucide-react's shapes, inline) ────────────────────────────────────────────────────────────────────────

type IconProps = { readonly size?: number; readonly className?: string; readonly 'aria-hidden'?: boolean | 'true' };

const icon =
  (paths: ReactNode) =>
  ({ size = 16, className, ...rest }: IconProps) => (
    <svg
      aria-hidden={rest['aria-hidden'] ?? true}
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
    >
      {paths}
    </svg>
  );

export const ArrowLeft = icon(
  <>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </>,
);
export const ChevronRight = icon(<path d="m9 18 6-6-6-6" />);
export const Plus = icon(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
);
export const Trash2 = icon(
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </>,
);
export const Check = icon(<path d="M20 6 9 17l-5-5" />);
export const Pencil = icon(
  <>
    <path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
    <path d="m15 5 4 4" />
  </>,
);
export const X = icon(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);
