/** Lower-case hexadecimal, the spelling every SHA-256 in a bundle manifest uses. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
