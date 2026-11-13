/**
 * THE ONE ADDRESS RULE: a page's address, title or text never hands a caller a pairing-shaped fragment.
 *
 * WHY. A pairing link carries a live credential in its URL FRAGMENT (`#v1;url=…;code=…;fp=…`, docs/pairing.md), and a
 * browser page that was opened on one — or that echoes one into its title or text — would otherwise print it into
 * an agent's tool result ("now at …"), the owner's page list, the `%browser` menu, a failed call's message, a daemon
 * log line or a published event. Where the page came from does not matter; what it shows must be safe whatever it did.
 *
 * WHERE IT LIVES. At the kernel seam, once: {@link withAddressRuleKernel} decorates the three ports through which this
 * plugin's text leaves — `kernel.redaction` (every tool result, owner route, error message and menu label passes
 * `scope.text`, S16), `kernel.log` (every message, field and child scope) and `kernel.events` (every string of every
 * payload) — and `buildBrowsers` hands every piece the decorated kernel. No call site names the rule, and a future
 * surface that reads under one of those ports gets it without asking. The pure rule is synchronous (a log line cannot
 * await the Vault), so a log line or event gets the address rule only; the vault's own values are masked where the
 * read is a `Redaction.read`.
 *
 * WHAT IT HIDES. Each `#…` run (or its percent-encoded `%23…` spelling, however many times encoded), taken to the end of
 * the fragment, is classified on a NORMALISED copy — percent-decoded up to four times, case-folded, zero-width
 * characters dropped, whitespace removed (and, in a second reading, turned into `;` so a space cannot hide a part
 * boundary). It is hidden whole when it is
 * - pairing-shaped: matches the access codec's own `PAIRING_FRAGMENT_PATTERN` (spelled below, parity-tested) — which is also
 *   the catalog share (`/join#v1;…share=…`) and catalog get (`/get#v1;b=…;k=…`) form, since they share the `v1` reader; or
 * - carries a `c=`, `code=` or `share=` part (`;`, `&` or `#` separated), however the version is spelled.
 * The classification never weakens the access codec: it only decides what to hide.
 *
 * A run's END is conservative too. It continues across whitespace while the next word continues the fragment (the
 * previous word ends in, or the next word starts with, a `;`, `=`, `&` or `,`, or the next word contains one and is no
 * address or new `#`), so `code= FAKE;fp=00` leaves no credential suffix behind. The cost is deliberate: ordinary text
 * such as `Issue #1 code=5` is hidden from its `#` on, because a credential-looking part is a reason to hide, and an
 * ordinary fragment (`#section`, `#/route/3`) next to ordinary words is untouched.
 *
 * It is replaced by {@link HIDDEN_FRAGMENT}; the path and query stay, so the agent still knows where it is.
 *
 * FAILS CLOSED. A string that is a single address (one run, a scheme) that `URL` cannot parse is returned with
 * everything after its first `#` hidden, because an address nothing can read is one nothing can prove harmless; a value
 * nested deeper than {@link MAX_DEPTH} is withheld; a refusal whose message cannot be masked is withheld whole
 * (`pages/routes.ts`).
 *
 * WHAT IT DOES NOT DO — decided, not forgotten. Query strings are NOT masked here: the pairing code lives only in the
 * fragment (it is never sent in a request), the vault's own redactor already masks any KNOWN secret value wherever it
 * sits, and a blanket "token-shaped value" mask on queries would blind an agent to ordinary OAuth `?code=` and
 * `?state=` callbacks it is allowed to act on. Fragment parts other than the names above (an OAuth implicit
 * `#access_token=`) are likewise not this rule's: they are not pairing credentials. `RedactionScope.cells` and
 * `.lines` are passed through — Browsers masks text only; object KEYS are not masked (they are the plugin's own
 * field names, never page text).
 */

import {
  ApiError,
  type KernelPorts,
  type Log,
  type LogFields,
  type Redaction,
  type RedactionScope,
} from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';

/**
 * The access codec's `PAIRING_FRAGMENT_PATTERN` (packages/plugins/access/contract/pairing.ts), which owns the fact.
 * It is spelled here, not imported, because a plugin-to-plugin package dependency changes the pinned Bun install
 * (`nix/bun-deps.inputs`) for one regular expression. `tests/unit/address-rule.test.ts` reads that file's source and
 * fails when this literal and the owner's differ, so the two cannot drift apart unnoticed.
 */
export const PAIRING_FRAGMENT_PATTERN = /^#?v1(?:;|$)/u;

/** What a hidden fragment reads as: it names what it was, and carries none of it. */
export const HIDDEN_FRAGMENT = '#[pairing link hidden]';

/** What a value nested too deep to walk is replaced by. */
const WITHHELD_VALUE = '[withheld]';

/** The deepest value {@link mapStrings} walks; a deeper one is withheld, not passed. */
const MAX_DEPTH = 32;

/** Where a fragment may start: a `#`, or a `%23` encoded once or several times (`%2523`). */
const START = /#|%(?:25)*23/giu;

/** Characters that end a run outright: quotes, angle brackets, a backtick, a backslash. */
const STOP = /["'<>`\\]/u;

const SEPARATOR_END = /(?:[;=&,]|%(?:25)*(?:3b|3d|26|2c))$/iu;
const SEPARATOR_START = /^(?:[;=&,]|%(?:25)*(?:3b|3d|26|2c))/iu;
const SEPARATOR_INSIDE = /[;=&]|%(?:25)*(?:3b|3d|26)/iu;
const ADDRESS_START = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** Parts whose names say "a credential travels here", whatever the fragment's version. */
const CREDENTIAL_PARTS = new Set(['c', 'code', 'share']);

/** One address on its own: a scheme, then no whitespace. */
const SINGLE_ADDRESS = /^[a-z][a-z0-9+.-]*:\S*$/iu;

const PERCENT_ESCAPE = /%([0-9a-f]{2})/giu;
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu;

/** One pass of percent-decoding, ASCII only, never throwing: a malformed escape stays as written. */
function decodeOnce(text: string): string {
  return text.replace(PERCENT_ESCAPE, (sequence, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code < 0x80 ? String.fromCharCode(code) : sequence;
  });
}

/** The bounded copy a run is classified on: decoded (up to four passes), zero-width characters dropped, case folded. */
function decoded(run: string): string {
  let current = run;
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current.replace(ZERO_WIDTH, '').toLowerCase();
}

function carriesCredentialPart(normal: string): boolean {
  return normal.split(/[;&#]/u).some(part => {
    const at = part.indexOf('=');
    return at > 0 && CREDENTIAL_PARTS.has(part.slice(0, at));
  });
}

function pairingShaped(normal: string): boolean {
  return normal.split('#').some(segment => PAIRING_FRAGMENT_PATTERN.test(segment));
}

/**
 * Whether `#…` is a fragment that must never leave: pairing-shaped, or carrying a credential part, judged on its
 * decoded, case-folded form with whitespace removed or read as a part boundary — either reading hides it.
 */
export function isCredentialFragment(fragment: string): boolean {
  const lowered = decoded(fragment);
  return [lowered.replace(/\s+/gu, ''), lowered.trim().replace(/\s+/gu, ';')].some(
    normal => pairingShaped(normal) || carriesCredentialPart(normal),
  );
}

function parses(address: string): boolean {
  try {
    new URL(address);
    return true;
  } catch {
    return false;
  }
}

function endsRun(char: string, stopAtAmpersand: boolean): boolean {
  return STOP.test(char) || /\s/u.test(char) || (stopAtAmpersand && char === '&');
}

function runEnd(text: string, from: number, stopAtAmpersand: boolean): number {
  let at = from;
  while (at < text.length && !endsRun(text.charAt(at), stopAtAmpersand)) at++;
  return at;
}

/**
 * Where the fragment that starts at `start` ends: the end of its run, then on across whitespace while the next word
 * continues it (see the file header). `stopAtAmpersand` is for a `%23` found inside a query, where a raw `&` is the
 * next query parameter, not part of the encoded fragment.
 */
function spanEnd(text: string, start: number, stopAtAmpersand: boolean): number {
  let end = runEnd(text, start, stopAtAmpersand);
  for (;;) {
    let next = end;
    while (next < text.length && /\s/u.test(text.charAt(next))) next++;
    if (next === end || next >= text.length) return end;
    const wordEnd = runEnd(text, next, stopAtAmpersand);
    const word = text.slice(next, wordEnd);
    const previous = text.slice(start, end);
    const continues =
      word !== '' &&
      !word.startsWith('#') &&
      !ADDRESS_START.test(word) &&
      (SEPARATOR_END.test(previous) || SEPARATOR_START.test(word) || SEPARATOR_INSIDE.test(word));
    if (!continues) return end;
    end = wordEnd;
  }
}

/** `text` with every credential fragment replaced by {@link HIDDEN_FRAGMENT}; text with none comes back unchanged. */
export function hideCredentialFragments(text: string): string {
  if (!text.includes('#') && !/%(?:25)*23/iu.test(text)) return text;
  if (text.includes('#') && SINGLE_ADDRESS.test(text) && !parses(text)) {
    // Unreadable as an address: nothing after its first `#` is shown.
    return `${text.slice(0, text.indexOf('#'))}${HIDDEN_FRAGMENT}`;
  }
  let hidden = '';
  let copied = 0;
  let scanned = 0;
  for (const match of text.matchAll(START)) {
    const start = match.index;
    if (start < scanned) continue;
    const end = spanEnd(text, start + match[0].length, match[0] !== '#');
    scanned = end;
    if (!isCredentialFragment(text.slice(start, end))) continue;
    hidden += text.slice(copied, start) + HIDDEN_FRAGMENT;
    copied = end;
  }
  return hidden + text.slice(copied);
}

function plainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` with `mask` applied to EVERY string in it, however deep (arrays and plain objects; numbers, booleans, null
 * and undefined pass). Structural, not field by field: a field a worker adds tomorrow is masked without anyone naming it.
 * A value nested deeper than {@link MAX_DEPTH}, or of a kind it does not walk (a function, a class instance), is withheld.
 */
export function mapStrings<T>(value: T, mask: (text: string) => string, depth = 0): T {
  if (typeof value === 'string') return mask(value) as T;
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return WITHHELD_VALUE as T;
  if (Array.isArray(value)) return value.map(each => mapStrings(each as unknown, mask, depth + 1)) as T;
  if (typeof value === 'object' && plainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, mapStrings(each, mask, depth + 1)]),
    ) as T;
  return WITHHELD_VALUE as T;
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

function maskedFields(fields: LogFields | undefined): LogFields | undefined {
  return fields === undefined ? undefined : mapStrings(fields, hideCredentialFragments);
}

/** `log` whose every message, field and child scope passes the address rule. */
function withAddressRuleLog(log: Log): Log {
  const line = (write: (message: string, fields?: LogFields) => void) => (message: string, fields?: LogFields) => {
    const masked = maskedFields(fields);
    if (masked === undefined) write(hideCredentialFragments(message));
    else write(hideCredentialFragments(message), masked);
  };
  return {
    debug: line((message, fields) => log.debug(message, fields)),
    info: line((message, fields) => log.info(message, fields)),
    warn: line((message, fields) => log.warn(message, fields)),
    error: line((message, fields) => log.error(message, fields)),
    child: scope => withAddressRuleLog(log.child(hideCredentialFragments(scope))),
  };
}

/** `events` whose every payload string passes the address rule before it is validated and published. */
function withAddressRuleEvents(events: KernelPorts['events']): KernelPorts['events'] {
  return { publish: (event, payload) => events.publish(event, mapStrings(payload, hideCredentialFragments)) };
}

/**
 * Every tool this half registers, behind ONE gate (v4's `AgentToolService` gate, PR 1596): the WHOLE result — text and
 * structured data alike, a picture's base64 included, which is no address and passes unchanged — and the message of
 * every refusal pass the one rule, whatever the tool and whether or not it remembered to. The per-reading masking in
 * the tool service (`scope.text`) stays as the first line; this is the second opinion nobody can forget to ask.
 */
export function withAddressRuleTools<Tools extends Readonly<Record<string, ToolHandler>>>(tools: Tools): Tools {
  const gate =
    (handler: ToolHandler): ToolHandler =>
    async (call, input) => {
      try {
        return mapStrings(await handler(call, input), hideCredentialFragments);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        throw new ApiError(
          error.status,
          hideCredentialFragments(error.message),
          error.code,
          mapStrings(error.validationIssues, hideCredentialFragments),
          mapStrings(error.extra, hideCredentialFragments),
        );
      }
    };
  return Object.fromEntries(Object.entries(tools).map(([name, handler]) => [name, gate(handler)])) as Tools;
}

/**
 * The kernel as this plugin sees it: `redaction`, `log` and `events` pass the address rule, every other port is the
 * kernel's own, read live (a delegating view, not a copy).
 */
export function withAddressRuleKernel(kernel: KernelPorts): KernelPorts {
  return new Proxy(kernel, {
    get: (ports, name) => {
      if (name === 'redaction') return withAddressRule(ports.redaction);
      if (name === 'log') return withAddressRuleLog(ports.log);
      if (name === 'events') return withAddressRuleEvents(ports.events);
      return Reflect.get(ports, name, ports);
    },
  });
}
