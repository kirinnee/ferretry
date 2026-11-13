/**
 * THE ONE ADDRESS RULE: a page's address, title or text never hands a caller a pairing-shaped fragment.
 *
 * WHY. A pairing link carries a live credential in its URL FRAGMENT (`#v1;url=…;code=…;fp=…`, docs/pairing.md), and a
 * browser page that was opened on one — or that echoes one into its title or text — would otherwise print it into
 * an agent's tool result ("now at …"), the owner's page list, the `%browser` menu or a failed call's message. Where
 * the page came from does not matter; what it shows must be safe whatever it did.
 *
 * WHERE IT LIVES. At the redaction seam, once: {@link withAddressRule} decorates `kernel.redaction`, and
 * `buildBrowsers` hands every piece (tools, routes, menu, holds, target) the decorated one. Every address, title,
 * snapshot and error message this plugin returns already passes `scope.text` (S16), so none of them names the rule and
 * a future surface that reads under the same port gets it without asking.
 *
 * WHAT IT HIDES. Each `#…` run (a `#` and everything up to the next space, quote, angle bracket, backtick or
 * backslash) that is
 * - pairing-shaped: matches the access codec's own `PAIRING_FRAGMENT_PATTERN` (spelled below, parity-tested) — which is also the catalog share
 *   (`/join#v1;…share=…`) and catalog get (`/get#v1;b=…;k=…`) form, since they share the `v1` fragment reader; or
 * - carries a `c=`, `code=` or `share=` part (`;` or `&` separated), however the version is spelled.
 * It is replaced by {@link HIDDEN_FRAGMENT}; the path and query stay, so the agent still knows where it is. The same
 * fragment percent-encoded inside a query (`…?next=…%23v1%3B…`) is hidden too. A harmless fragment (`#section`) is
 * untouched.
 *
 * FAILS CLOSED. A string that is a single address (one run, a scheme) that `URL` cannot parse is returned with
 * everything after its first `#` hidden, because an address nothing can read is one nothing can prove harmless.
 *
 * WHAT IT DOES NOT DO — decided, not forgotten. Query strings are NOT masked here: the pairing code lives only in the
 * fragment (it is never sent in a request), the vault's own redactor already masks any KNOWN secret value wherever it
 * sits, and a blanket "token-shaped value" mask on queries would blind an agent to ordinary OAuth `?code=` and
 * `?state=` callbacks it is allowed to act on. Fragment parts other than the names above (an OAuth implicit
 * `#access_token=`) are likewise not this rule's: they are not pairing credentials. `RedactionScope.cells` and
 * `.lines` are passed through — Browsers masks text only.
 */

import type { Redaction, RedactionScope } from '@ferretry/kernel/contract';

/**
 * The access codec's `PAIRING_FRAGMENT_PATTERN` (packages/plugins/access/contract/pairing.ts), which owns the fact.
 * It is spelled here, not imported, because a plugin-to-plugin package dependency changes the pinned Bun install
 * (`nix/bun-deps.inputs`) for one regular expression. `tests/unit/address-rule.test.ts` reads that file's source and
 * fails when this literal and the owner's differ, so the two cannot drift apart unnoticed.
 */
export const PAIRING_FRAGMENT_PATTERN = /^#?v1(?:;|$)/u;

/** What a hidden fragment reads as: it names what it was, and carries none of it. */
export const HIDDEN_FRAGMENT = '#[pairing link hidden]';

/** A `#` and the run after it, as far as a URL's own characters go. */
const HASH_RUN = /#[^\s"'<>`\\]*/gu;

/** A pairing fragment percent-encoded (`%23v1%3B…`), as a query value carrying a link would spell it. */
const ENCODED_PAIRING_RUN = /%23v1(?:%3B|;)[^\s"'<>`\\&]*/giu;

/** Parts whose names say "a credential travels here", whatever the fragment's version. */
const CREDENTIAL_PARTS = new Set(['c', 'code', 'share']);

/** One address on its own: a scheme, then no whitespace. */
const SINGLE_ADDRESS = /^[a-z][a-z0-9+.-]*:\S*$/iu;

function carriesCredentialPart(fragment: string): boolean {
  return fragment
    .slice(1)
    .split(/[;&]/u)
    .some(part => {
      const at = part.indexOf('=');
      return at > 0 && CREDENTIAL_PARTS.has(part.slice(0, at).toLowerCase());
    });
}

/** Whether `#…` is a fragment that must never leave: pairing-shaped, or carrying a credential part. */
export function isCredentialFragment(fragment: string): boolean {
  return PAIRING_FRAGMENT_PATTERN.test(fragment) || carriesCredentialPart(fragment);
}

function parses(address: string): boolean {
  try {
    new URL(address);
    return true;
  } catch {
    return false;
  }
}

/** `text` with every credential fragment replaced by {@link HIDDEN_FRAGMENT}; text with none comes back unchanged. */
export function hideCredentialFragments(text: string): string {
  if (!text.includes('#') && !text.includes('%23')) return text;
  if (text.includes('#') && SINGLE_ADDRESS.test(text) && !parses(text)) {
    // Unreadable as an address: nothing after its first `#` is shown.
    return `${text.slice(0, text.indexOf('#'))}${HIDDEN_FRAGMENT}`;
  }
  return text
    .replaceAll(HASH_RUN, run => (isCredentialFragment(run) ? HIDDEN_FRAGMENT : run))
    .replaceAll(ENCODED_PAIRING_RUN, () => HIDDEN_FRAGMENT);
}

/** One scope whose `text` also applies the address rule, after the inner scope's own masking. */
function scopeWithRule(scope: RedactionScope): RedactionScope {
  return { ...scope, text: text => hideCredentialFragments(scope.text(text)) };
}

/**
 * `redaction` with the address rule applied to every `text` read. The inner redaction still runs first, on the
 * original bytes, so a vault value inside a fragment is masked by name before the fragment is hidden whole.
 */
export function withAddressRule(redaction: Redaction): Redaction {
  return { read: fn => redaction.read(scope => fn(scopeWithRule(scope))) };
}
