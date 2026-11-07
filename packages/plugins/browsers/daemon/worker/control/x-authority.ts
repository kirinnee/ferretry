import type { BrowserViewport } from '@ferretry/protocol';

/**
 * The pure half of keeping a private X display private: the cookie, its on-disk encoding and the
 * server's argv. The adapter (`XvfbDisplay`) owns the file, its permissions and the server it starts.
 *
 * WHY A COOKIE AT ALL. An Xvfb started without `-auth` accepts every client that can reach its unix
 * socket, and `/tmp/.X11-unix/X<n>` is reachable by every local user. On a host with other accounts
 * that is a screenshot of the login window — where the owner types passwords — and keystroke
 * injection into the window-mode agent browser. With `-auth` the server admits a client only if it
 * presents the MIT-MAGIC-COOKIE-1 in the file, and the file is `0600`.
 */

/** The authorization protocol name an X client and server both speak for a shared-secret cookie. */
export const X_AUTH_PROTOCOL = 'MIT-MAGIC-COOKIE-1';

/** The cookie's length. The protocol fixes it at 128 bits. */
export const X_COOKIE_BYTES = 16;

/** `FamilyWild`: the entry applies to a connection from any address. */
const FAMILY_WILD = 0xffff;

/** A fresh cookie from the injected entropy source — injected so a test can pin the bytes. */
export function generateXCookie(randomValues: (buffer: Uint8Array) => Uint8Array): Uint8Array {
  return randomValues(new Uint8Array(X_COOKIE_BYTES));
}

/** One length-prefixed field of an Xauthority entry: a big-endian 16-bit length, then the bytes. */
function field(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(2 + bytes.length);
  new DataView(result.buffer).setUint16(0, bytes.length);
  result.set(bytes, 2);
  return result;
}

/**
 * One Xauthority-format entry holding `cookie` for `displayNumber`.
 *
 * Fields, in file order: the family (two raw bytes, NOT length-prefixed), the address, the display
 * number as ASCII, the protocol name and the cookie.
 *
 * `FamilyWild` with an empty address because the entry must match however the client reaches the
 * server — over the local socket the client's idea of this host's name is whatever it finds, and an
 * entry pinned to one hostname would silently stop matching. The DISPLAY NUMBER is what a client
 * keys on (`libxcb` skips an entry whose number differs), so it is the one field that must be right;
 * the server itself ignores the address and number and loads every cookie in the file.
 */
export function xauthorityEntry(displayNumber: string, cookie: Uint8Array): Uint8Array {
  const text = new TextEncoder();
  const parts = [
    field(new Uint8Array(0)),
    field(text.encode(displayNumber)),
    field(text.encode(X_AUTH_PROTOCOL)),
    field(cookie),
  ];
  const family = new Uint8Array(2);
  new DataView(family.buffer).setUint16(0, FAMILY_WILD);
  const entry = new Uint8Array(2 + parts.reduce((total, part) => total + part.length, 0));
  entry.set(family, 0);
  let offset = 2;
  for (const part of parts) {
    entry.set(part, offset);
    offset += part.length;
  }
  return entry;
}

/**
 * The argv for a private, authenticated Xvfb.
 *
 * `-displayfd 1` rather than a number this code picks (see `XvfbDisplay`), `-nolisten tcp` so nothing
 * off this machine reaches the screen, and `-auth` so nothing ON this machine reaches it without the
 * cookie either.
 */
export function xvfbLaunchArguments(
  executable: string,
  screen: BrowserViewport,
  authorityFile: string,
): readonly string[] {
  return [
    executable,
    '-displayfd',
    '1',
    '-screen',
    '0',
    `${screen.width}x${screen.height}x24`,
    '-nolisten',
    'tcp',
    '-auth',
    authorityFile,
  ];
}
