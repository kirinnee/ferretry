/**
 * Reading a harness child's terminal output — the two text problems both flows have, and nothing else.
 *
 * These are utilities, not a flow. WHICH line means what, WHICH hosts a verification URL may name and
 * WHAT the harness is waiting for are per-harness facts that live with each harness's own flow. What is
 * genuinely shared is that a program writing to a pipe still writes terminal escapes, and that a URL
 * has to be lifted out of a sentence without dragging its punctuation along.
 *
 * ## Escapes are emitted even when stdout is a pipe, and both harnesses do it
 *
 * Observed by running the installed CLIs with piped stdio:
 *
 * - `codex login --device-auth` (codex-cli 0.145.0) colours both the URL and the user code with SGR
 *   sequences, so an unstripped line never equals the code it displays.
 * - `claude auth login --claudeai` (claude-code 2.1.220) wraps the URL in an **OSC 8 hyperlink**:
 *   `ESC ] 8 ; ; <url> BEL <url> ESC ] 8 ; ; BEL`. The address therefore appears TWICE — once inside
 *   the escape as the link target and once as the visible text.
 *
 * Stripping OSC sequences whole is what makes that second case come out right: the first sequence
 * carries the target inside itself and disappears with it, leaving exactly one visible URL. A stripper
 * that only removed colour would leave two copies and a naive match would publish a URL glued to its
 * own duplicate.
 *
 * ## NOTHING HERE PUBLISHES ANYTHING
 *
 * A line these functions cannot classify yields `undefined` and is dropped. The daemon reads harness
 * output for the first time in this feature, which is the actual property change it makes, and bounding
 * what may leave that reader to two recognised fields is what keeps it small
 * (`docs/design/harness-login.md` §3.3 rule 2).
 */

/**
 * An OSC (operating system command) sequence: `ESC ]` up to a `BEL` or a string terminator.
 *
 * Matched greedily over everything that is not itself a terminator so that the URL a hyperlink carries
 * is consumed as part of the sequence rather than surviving it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;

/** A CSI sequence — colour, cursor movement, erasure. Everything `ESC [` … final byte. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

/** A two-character escape such as `ESC ( B`, left over after the two above. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const SHORT_ESCAPE = /\u001b[()#][0-9A-Za-z]|\u001b[<>=]/gu;

/** Control characters that survive stripping and would otherwise sit inside a published value. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** One output line with every terminal escape and stray control character removed. */
export function stripTerminalEscapes(raw: string): string {
  return raw
    .replaceAll(OSC_SEQUENCE, '')
    .replaceAll(CSI_SEQUENCE, '')
    .replaceAll(SHORT_ESCAPE, '')
    .replaceAll(CONTROL_CHARACTERS, '');
}

/** Trailing characters that end an English sentence rather than a URL. */
const SENTENCE_TAIL = /[.,;:!?)\]}'"»]+$/u;

/**
 * The first `https://` address in a line whose host this harness expects, or nothing.
 *
 * **The host allowlist is not decoration.** Without it the daemon would hand a person whatever address
 * the child happened to print and invite them to sign in there, which is a phishing surface the daemon
 * would be operating on its own host. With it, a provider that moves its sign-in host makes this flow
 * fail as itself and name `fy fleet login` — the outcome §4.5 rule 2 requires — rather than publishing
 * something arbitrary.
 *
 * `hosts` are matched as the host itself or as a subdomain of it, never as a suffix: `evil-claude.com`
 * does not match `claude.com`.
 */
export function verificationUrlIn(line: string, hosts: readonly string[]): string | undefined {
  for (const candidate of line.match(/https:\/\/[^\s<>"]+/gu) ?? []) {
    const trimmed = candidate.replace(SENTENCE_TAIL, '');
    if (!URL.canParse(trimmed)) continue;
    const { hostname } = new URL(trimmed);
    if (hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))) return trimmed;
  }
  return undefined;
}
