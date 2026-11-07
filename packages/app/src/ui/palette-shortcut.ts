/**
 * What the command palette's discoverability hint prints, and what assistive
 * tech is told about it. Ported from the shortcut helpers in kteam
 * `ui/src/components/CommandPalette.tsx`.
 *
 * It lives apart from the palette itself because the app bar renders the same
 * string the dialog answers to, and the bar must not have to import the whole
 * palette to say so.
 */

/**
 * True on Apple platforms, where the shortcut is Cmd-K rather than Ctrl-K.
 * Reads the modern hint first and falls back to the deprecated `platform`
 * string, because getting this wrong prints a key the reader does not have.
 */
export const isApplePlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const hint = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /mac|iphone|ipad|ipod/i.test(hint || navigator.platform || navigator.userAgent || '');
};

/** What the discoverability hint prints. */
export const paletteShortcutLabel = (): string => (isApplePlatform() ? '⌘K' : 'Ctrl K');

/**
 * The `aria-keyshortcuts` value, per the spec's key names. Both are live, on
 * every platform, so both are declared.
 */
export const PALETTE_KEYSHORTCUTS = 'Meta+K Control+K';
