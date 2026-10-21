import type { BrowserChallenge, BrowserChallengeProvider } from '@ferretry/protocol';

/**
 * Whether a page appears to be asking the person on it to prove they are human — so the view can say so
 * and hand the page to its owner, who solves it themselves.
 *
 * RECOGNISED, NEVER ANSWERED. This reads only what the browser already knows about a page — its address,
 * its title and the addresses of its frames — and runs nothing inside it. Ferretry does not solve, skip or
 * disguise itself past a challenge; the only thing it does with this is tell a person.
 *
 * A HINT, NOT A VERDICT. A widget that is present but invisible (reCAPTCHA v3, an invisible hCaptcha) is
 * deliberately not flagged, because nothing is being asked of anyone yet; a challenge served in a shape this
 * list has not seen is not flagged either. The view words it as "appears to be".
 *
 * Pure, and free of runtime imports, because the browser worker program runs it too.
 */
export interface BrowserChallengeEvidence {
  readonly url: string;
  readonly title: string;
  readonly frameUrls: readonly string[];
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

export function recogniseBrowserChallenge(evidence: BrowserChallengeEvidence): BrowserChallenge | undefined {
  const page = pageProvider(parsed(evidence.url), evidence.title);
  if (page !== undefined) return { provider: page };
  for (const frame of evidence.frameUrls) {
    const url = parsed(frame);
    const provider = url === undefined ? undefined : frameProvider(url);
    if (provider !== undefined) return { provider };
  }
  return undefined;
}
