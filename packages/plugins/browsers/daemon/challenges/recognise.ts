import type { PageFacts } from '@ferretry/core-vault/contract';
import { getDomain } from 'tldts';

/** A challenge a page shows, as the card and the view name it (`PageFacts.challenge`). */
export type BrowserChallenge = NonNullable<PageFacts['challenge']>;
type BrowserChallengeProvider = BrowserChallenge['provider'];

/**
 * Whether a page appears to be asking the person on it to prove they are human — so the view can say so
 * and hand the page to its owner, who solves it themselves.
 *
 * RECOGNISED HERE, ANSWERED ELSEWHERE. This reads only what the browser already knows about a page — its address,
 * its title and the addresses of its frames — and runs nothing inside it. It does not solve, skip or disguise
 * itself past a challenge; it tells a person, and only where stealth is in effect does `solver.ts` act on it.
 *
 * A HINT, NOT A VERDICT. A widget that is present but invisible (reCAPTCHA v3, an invisible hCaptcha) is
 * deliberately not flagged, because nothing is being asked of anyone yet; a challenge served in a shape this
 * list has not seen is not flagged either. The view words it as "appears to be".
 *
 * A SUB-REQUEST CHALLENGE counts too. Some sites let the document load but answer every script and stylesheet with
 * a 403 carrying `cf-mitigated: challenge`: a script load cannot show a challenge, so the page is simply blank. That
 * is reported as Cloudflare when a first-party script or stylesheet was challenged, or when the page has no visible
 * text and any was. A page with text and only a blocked third-party tracker is not flagged. The facts are the sub-request's
 * status, one header and its address; no body is read.
 *
 * Pure, and its one runtime import (the public suffix list, to tell one site from another) is bundled, because the
 * browser worker program runs it too.
 */
export interface BrowserChallengeEvidence {
  readonly url: string;
  readonly title: string;
  readonly frameUrls: readonly string[];
  /** Addresses of script and stylesheet sub-requests the page's document made that were answered 403 `cf-mitigated: challenge`. */
  readonly challengedSubresources?: readonly string[];
  /** Whether the page shows no (or almost no) visible text; read only when a sub-request was challenged. */
  readonly blankBody?: boolean;
}

/** The most challenged sub-request addresses a page's record keeps, first-party and other counted apart. */
const CHALLENGED_KEEP = 16;
/** Visible characters or fewer that still count as a blank page. */
export const BLANK_BODY_CHARS = 20;

/** Whether a sub-request's answer is a challenge in place of the script or stylesheet that was asked for. */
export function isChallengedSubresource(answer: {
  readonly type: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}): boolean {
  if (answer.status !== 403 || (answer.type !== 'script' && answer.type !== 'stylesheet')) return false;
  for (const [name, value] of Object.entries(answer.headers))
    if (name.toLowerCase() === 'cf-mitigated') return value.trim().toLowerCase() === 'challenge';
  return false;
}

/** An address without its fragment: what a navigation and the document it commits are matched on. */
function withoutFragment(address: string): string {
  const at = address.indexOf('#');
  return at === -1 ? address : address.slice(0, at);
}

/**
 * The challenged sub-requests of the page's COMMITTED document.
 *
 * First-party ones (same registrable domain as the document, public suffixes included) are kept apart from the
 * rest, each bounded, so a page that fires a flood of challenged trackers cannot push a first-party challenge out.
 * A navigation clears the record only when the document it asked for COMMITS: a navigation that never commits (an
 * HTTP 204, a download) leaves the current page's evidence in place, and a same-document change (a history
 * `pushState`) is no navigation at all.
 */
export class SubresourceChallenges {
  private readonly first: string[] = [];
  private readonly other: string[] = [];
  /** The addresses of the navigation now under way, redirects included, waiting to commit. */
  private pending: string[] = [];

  /** A main-frame navigation request went out: a fresh one replaces the last, a redirect hop joins its chain. */
  navigating(url: string, redirect: boolean): void {
    this.pending = redirect ? [...this.pending, withoutFragment(url)] : [withoutFragment(url)];
  }

  /** The main frame committed `url`: a new document if a navigation asked for it, otherwise the same one. */
  committed(url: string): void {
    // Chrome's own error page stands in for a navigation that failed: it is a committed document too.
    if (!this.pending.includes(withoutFragment(url)) && !url.startsWith('chrome-error:')) return;
    this.pending = [];
    this.first.length = 0;
    this.other.length = 0;
  }

  /** A script or stylesheet of the document at `documentUrl` was challenged. */
  observe(url: string, documentUrl: string): void {
    const document = parsed(documentUrl);
    const target = parsed(url);
    const mine = document !== undefined && target !== undefined && sameSite(target.hostname, document.hostname);
    const kept = mine ? this.first : this.other;
    if (kept.length < CHALLENGED_KEEP && !kept.includes(url)) kept.push(url);
  }

  urls(): readonly string[] {
    return [...this.first, ...this.other];
  }
}

/** The registrable domain of a host under the public suffix list, private suffixes (`github.io`) included. */
function siteOf(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true });
}

/** Whether two hosts are one site: the same host, or one registrable domain (`app.abc.de` and `static.abc.de`). */
function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const site = siteOf(a);
  return site !== null && site === siteOf(b);
}

/** Titles a "checking your browser" page or a captcha wall shows while it is up. */
const CLOUDFLARE_TITLE = /^(?:just a moment|attention required! \| cloudflare)/i;
const HUMAN_CHECK_TITLE =
  /\b(?:verify (?:that )?you(?:'|’)?re (?:a )?human|verify you are (?:a )?human|are you a (?:robot|human)|robot check)\b/i;

function parsed(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const hostIs = (url: URL, domain: string): boolean => url.hostname === domain || url.hostname.endsWith(`.${domain}`);

/** A visible captcha widget in a frame: who serves it, or `undefined` for anything else. */
function frameProvider(url: URL): BrowserChallengeProvider | undefined {
  const href = url.href;
  if (hostIs(url, 'challenges.cloudflare.com')) return 'cloudflare';
  // The reCAPTCHA checkbox lives in its `anchor` frame; an invisible one (v3, invisible v2) says so in the
  // frame's own address and asks nobody anything until it escalates — into the same anchor or a `bframe`
  // that is then shown, which the checkbox case already covers.
  if (
    (hostIs(url, 'google.com') || hostIs(url, 'recaptcha.net')) &&
    /\/recaptcha\/(?:api2|enterprise)\/anchor/.test(url.pathname) &&
    !href.includes('size=invisible')
  )
    return 'recaptcha';
  if (hostIs(url, 'hcaptcha.com') && href.includes('frame=checkbox') && !href.includes('size=invisible'))
    return 'hcaptcha';
  if (hostIs(url, 'captcha-delivery.com')) return 'datadome';
  if (hostIs(url, 'arkoselabs.com') || hostIs(url, 'funcaptcha.com')) return 'arkose';
  if (hostIs(url, 'px-cdn.net') || hostIs(url, 'px-cloud.net'))
    return url.hostname.startsWith('captcha') ? 'perimeterx' : undefined;
  return undefined;
}

/** The page itself is the challenge: an interstitial that stands in for the page that was asked for. */
function pageProvider(url: URL | undefined, title: string): BrowserChallengeProvider | undefined {
  if (url !== undefined) {
    if (url.pathname.includes('/cdn-cgi/challenge-platform/')) return 'cloudflare';
    if (/^(?:www\.)?google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith('/sorry/')) return 'google';
  }
  if (CLOUDFLARE_TITLE.test(title.trim())) return 'cloudflare';
  if (HUMAN_CHECK_TITLE.test(title)) return 'other';
  return undefined;
}

/** A first-party script or stylesheet challenged, or any of them on a page with nothing to read. */
function subresourceChallenged(evidence: BrowserChallengeEvidence, page: URL | undefined): boolean {
  const challenged = evidence.challengedSubresources ?? [];
  if (challenged.length === 0) return false;
  if (evidence.blankBody === true) return true;
  if (page === undefined) return false;
  return challenged.some(address => {
    const url = parsed(address);
    return url !== undefined && sameSite(url.hostname, page.hostname);
  });
}

export function recogniseBrowserChallenge(evidence: BrowserChallengeEvidence): BrowserChallenge | undefined {
  const address = parsed(evidence.url);
  const page = pageProvider(address, evidence.title);
  if (page !== undefined) return { provider: page };
  if (subresourceChallenged(evidence, address)) return { provider: 'cloudflare' };
  for (const frame of evidence.frameUrls) {
    const url = parsed(frame);
    const provider = url === undefined ? undefined : frameProvider(url);
    if (provider !== undefined) return { provider };
  }
  return undefined;
}
