import type { PushNumberProvider } from './input-contracts.ts';

/**
 * THE NUMBER A PUSH APPROVAL SHOWS, READ OFF THE PROVIDER'S OWN PAGE (docs/input-requests.md, "Approve on your
 * phone"). A sign-in that waits for a tap on the owner's phone often shows a number on the page that the phone asks
 * for: the owner taps it (Okta, Microsoft, Google) or types it into the app (Duo Verified Push). The owner's card shows
 * it so they need not look at the page, and that number is exactly what an attacker who started a sign-in of their own
 * would want the owner to approve. So it is read by the BROWSER, and only:
 *
 * - from a document test that holds for the provider's own challenge view (English only: another locale is no number);
 * - from a VISIBLE element no one can type into (not a field, not inside one, not editable), whose whole text is the
 *   digits, in the page's MAIN frame (a provider's view is never framed);
 * - for Okta and Google, when the sentence telling the person to tap it names the SAME number.
 *
 * Where the page is (its origin, and whether a ferret scripted it) is the DAEMON's decision on the browser's answer,
 * not this module's: {@link identityProviderOf} and {@link numberSourceFits} are the host rules it applies.
 *
 * The selectors are pinned from the providers' public sources (tests/fixtures/push/, each fixture names its own):
 * - Okta Identity Engine widget Gen2 (okta-signin-widget `src/v2/view-builder/views/ov/NumberChallengePhoneView.js`)
 *   and Classic (`src/v1/views/mfa-verify/NumberChallengeView.js`): `[data-se="challenge-number"]`, inside
 *   `.number-challenge-section` / `.number-challenge-view`;
 * - Okta Gen3 (`src/v3/src/transformer/oktaVerify/transformOktaVerifyCustomAppChallengePoll.ts`, rendered in
 *   `src/v3/test/integration/__snapshots__/authenticator-verification-okta-verify-push-code.test.tsx.snap`):
 *   `#code [data-se="text-code"]`, with the sentence in `[data-se="numberchallenge-instr-value"]`;
 * - Microsoft Entra: `#idRichContext_DisplaySign`;
 * - Google: the sentence "tap 42 on your phone", and an element whose whole text is that number;
 * - Duo Universal Prompt (Verified Duo Push): `.verification-code`, under "Enter code in Duo Mobile".
 *
 * NOTHING A FERRET POINTS AT IS READ: a page may echo back text the ferret typed (Okta shows the username it was given,
 * in a visible element no one can type into), so only these views give a number (secrev-1244 H1).
 *
 * Pure, and free of runtime imports: the browser worker runs {@link scanPushNumber} INSIDE the page (`page.evaluate`),
 * so it is self-contained, its helpers nested in it.
 */

/** A host is `domain` or one of its subdomains, on a label boundary: never a look-alike that merely ends the same. */
const under = (host: string, domain: string): boolean => host.endsWith(`.${domain}`) && host.length > domain.length + 1;

const MICROSOFT_HOSTS: ReadonlySet<string> = new Set(['login.microsoftonline.com', 'login.live.com']);
const GOOGLE_HOST = 'accounts.google.com';
const OKTA_DOMAINS = ['okta.com', 'oktapreview.com', 'okta-emea.com'] as const;
const DUO_DOMAIN = 'duosecurity.com';

/**
 * Which identity provider a page's host belongs to, from a FIXED list: Microsoft's and Google's sign-in hosts exactly,
 * and an organisation's own subdomain of Okta's or Duo's (never the bare apex). `undefined` for any other host.
 */
export function identityProviderOf(host: string): PushNumberProvider | undefined {
  const name = host.toLowerCase();
  if (MICROSOFT_HOSTS.has(name)) return 'microsoft';
  if (name === GOOGLE_HOST) return 'google';
  if (OKTA_DOMAINS.some(domain => under(name, domain))) return 'okta';
  if (under(name, DUO_DOMAIN)) return 'duo';
  return undefined;
}

/**
 * Whether a number from `from` can have been read on `host`: Microsoft's only on its two sign-in hosts, Google's only on
 * accounts.google.com, Duo's only on a Duo host. Okta's widget also runs on an organisation's own domain
 * (`login.company.com`), so it fits any host: whether the host is one the daemon trusts is its own gate.
 */
export function numberSourceFits(from: PushNumberProvider, host: string): boolean {
  const name = host.toLowerCase();
  switch (from) {
    case 'microsoft':
      return MICROSOFT_HOSTS.has(name);
    case 'google':
      return name === GOOGLE_HOST;
    case 'duo':
      return under(name, DUO_DOMAIN);
    case 'okta':
      return true;
  }
}

/** What a scan of a page found: whose challenge it is, and the number, or why none. */
export interface PushNumberScan {
  readonly provider?: PushNumberProvider;
  readonly number?: { readonly value: string; readonly from: PushNumberProvider };
  readonly missing?: 'none-found';
}

/**
 * Runs IN THE PAGE (the main frame): the provider whose challenge view this document is, and the number it shows. The
 * host is the document's own `location`, never anything a caller passes. `env` is the page's window; a test passes
 * one of its own.
 */
export function scanPushNumber(_args: Readonly<Record<string, never>> = {}, env: unknown = globalThis): PushNumberScan {
  type Node = {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
    readonly innerText?: string;
    readonly textContent?: string | null;
    readonly children?: ArrayLike<Node>;
    getBoundingClientRect?(): { x: number; y: number; width: number; height: number };
    closest?(selector: string): Node | null;
    contains?(other: Node): boolean;
    querySelector?(selector: string): Node | null;
    querySelectorAll?(selector: string): ArrayLike<Node>;
  };
  const win = env as {
    readonly location: { readonly hostname: string; readonly pathname: string };
    readonly document: Node & { readonly body: Node | null; elementFromPoint?(x: number, y: number): Node | null };
    getComputedStyle?(element: Node): { readonly visibility?: string; readonly display?: string };
  };
  const doc = win.document;
  const host = win.location.hostname.toLowerCase();
  const textOf = (node: Node | null | undefined): string =>
    (node?.innerText ?? node?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  const one = (selector: string): Node | null => doc.querySelector?.(selector) ?? null;
  const all = (selector: string): Node[] => Array.from(doc.querySelectorAll?.(selector) ?? []);
  const sub = (domain: string): boolean => host.endsWith(`.${domain}`) && host.length > domain.length + 1;
  // Visible: a box, not hidden by style, and on top at its centre (it, or something inside it, is what is there).
  const visible = (node: Node): boolean => {
    const box = node.getBoundingClientRect?.();
    if (box === undefined || !(box.width > 0) || !(box.height > 0)) return false;
    const style = win.getComputedStyle?.(node);
    if (style?.visibility === 'hidden' || style?.display === 'none') return false;
    const hit = doc.elementFromPoint?.(box.x + box.width / 2, box.y + box.height / 2) ?? null;
    return hit !== null && (hit === node || node.contains?.(hit) === true);
  };
  // Not something anyone can type into: no field, nothing inside one, nothing editable.
  const fixed = (node: Node): boolean => {
    const tag = (node.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    if (node.isContentEditable === true) return false;
    return (node.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') ?? null) === null;
  };
  // The number an element shows: its whole text, only digits of the provider's length, visible, not editable.
  const numberIn = (node: Node | null, digits: RegExp): string | undefined => {
    if (node === null) return undefined;
    const text = textOf(node);
    return digits.test(text) && visible(node) && fixed(node) ? text : undefined;
  };
  const TAP = /^[0-9]{1,3}$/u;
  const TYPE = /^[0-9]{3,6}$/u;
  const found = (value: string | undefined, from: PushNumberProvider): PushNumberScan =>
    value === undefined ? { provider: from, missing: 'none-found' } : { provider: from, number: { value, from } };

  // Microsoft Entra: its own sign-in hosts, and the number-match view.
  if (host === 'login.microsoftonline.com' || host === 'login.live.com') {
    const sign = one('#idRichContext_DisplaySign');
    if (sign === null && one('#idDiv_SAOTCAS_Title') === null) return { missing: 'none-found' };
    return found(numberIn(sign, TAP), 'microsoft');
  }

  // Duo Universal Prompt, Verified Duo Push: a code to TYPE into Duo Mobile.
  if (sub('duosecurity.com')) {
    if (!/\benter (?:this )?(?:verification )?code in duo mobile\b/iu.test(textOf(doc.body)))
      return { missing: 'none-found' };
    const codes = all('.verification-code')
      .map(node => numberIn(node, TYPE))
      .filter((value): value is string => value !== undefined);
    return found(codes.length > 0 && codes.every(code => code === codes[0]) ? codes[0] : undefined, 'duo');
  }

  // Google: the sentence names the number, and an element shows exactly that number on its own.
  if (host === 'accounts.google.com') {
    if (!win.location.pathname.includes('/challenge/')) return { missing: 'none-found' };
    const said = [...textOf(doc.body).matchAll(/\btap ([0-9]{1,3}) on your (?:phone|device)\b/giu)].map(
      match => match[1],
    );
    if (said.length === 0) return { missing: 'none-found' };
    const number = said[0];
    if (number === undefined || said.some(other => other !== number)) return found(undefined, 'google');
    const shown = all('body *').some(
      node =>
        textOf(node) === number &&
        !Array.from(node.children ?? []).some(child => textOf(child) === number) &&
        numberIn(node, TAP) === number,
    );
    return found(shown ? number : undefined, 'google');
  }

  // Okta's widget (Classic, Gen2 and Gen3), on an Okta host or the organisation's own domain.
  if (one('#okta-sign-in') !== null || one('[data-se="o-form"]') !== null) {
    const view = one('.number-challenge-section, .number-challenge-view, [data-se="numberchallenge-instr-value"]');
    if (view === null) return { missing: 'none-found' };
    const sentence = textOf(
      one(
        '[data-se="numberchallenge-instr-value"], .number-challenge-section > p, [data-se="number-challenge-instruction"]',
      ),
    );
    const said = /\btap ([0-9]{1,3}) (?:in|on) okta verify\b/iu.exec(sentence)?.[1];
    const shown = all('[data-se="challenge-number"], #code [data-se="text-code"]')
      .map(node => numberIn(node, TAP))
      .filter((value): value is string => value !== undefined);
    const agreed = said !== undefined && shown.length > 0 && shown.every(value => value === said) ? said : undefined;
    return found(agreed, 'okta');
  }

  return { missing: 'none-found' };
}
