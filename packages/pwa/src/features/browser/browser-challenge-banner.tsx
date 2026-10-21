/**
 * "This page wants a person": the strip the browser pane shows when the page on screen appears to be
 * asking for a human check — a captcha, or a "checking your browser" page (docs/browser-mode.md).
 *
 * Ferretry never solves one. The daemon only RECOGNISES a check from the page's address, title and frames,
 * and this strip hands it to the person: take the page over, solve it yourself, hand it back. The wording
 * says "appears", because the recognition is a hint — a check it has not seen is not flagged, and a page
 * that merely embeds a widget can be.
 */

import type { BrowserChallenge, BrowserChallengeProvider, BrowserStatus } from '@ferretry/protocol';
import { ShieldAlert } from 'lucide-react';

/** Who is asking, in the words a person knows them by. `other` names nobody. */
const PROVIDER_WORDS: Readonly<Record<BrowserChallengeProvider, string | undefined>> = {
  cloudflare: 'Cloudflare',
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  google: 'Google',
  datadome: 'DataDome',
  arkose: 'Arkose',
  perimeterx: 'HUMAN (PerimeterX)',
  other: undefined,
};

/** The human check on the page the pane is showing, or `null` when there is none (or no page at all). */
export function shownChallenge(status: BrowserStatus | null): BrowserChallenge | null {
  if (status === null || status.state !== 'running' || !('activePageId' in status)) return null;
  return status.pages.find(page => page.id === status.activePageId)?.challenge ?? null;
}

export function BrowserChallengeBanner({ challenge }: { readonly challenge: BrowserChallenge }) {
  const who = PROVIDER_WORDS[challenge.provider];
  return (
    <div
      role="status"
      data-browser-challenge={challenge.provider}
      className="flex shrink-0 items-start gap-xs border-b border-warn-border bg-warn-bg px-3 py-2 text-meta text-fg"
    >
      <ShieldAlert aria-hidden="true" className="mt-[2px] size-4 shrink-0 text-warn" />
      <p className="m-0 min-w-0 flex-1 break-words leading-base">
        <span className="font-medium">
          This page appears to be asking you to prove you’re a person{who === undefined ? '' : ` (${who})`}.
        </span>{' '}
        Ferretry won’t answer it for you: take the page over, solve it yourself, then hand it back. If a Headless
        browser keeps being asked, set Browser mode to Real window in this machine’s settings.
      </p>
    </div>
  );
}
