/**
 * THE SOLE OWNER OF HOW THE PHONE COMPOSER LAYS OUT ITS BUTTONS (Settings › Composer › Button layout).
 *
 * Attach and the mic on one side of the box, Interrupt & send and Send on the other:
 *
 * - `stacked` — each side a column, always (the default: owner, 2026-11-02, !A237). Nothing moves on
 *   focus or as typing starts, and the field keeps its width for typing.
 * - `row` — each side a row, always. Nothing moves either; the box is one line while the text is.
 * - `auto` — a row while the box is empty, stacked once there is a draft: the old switch, kept on purpose
 *   for whoever prefers it, jump and all.
 *
 * A reader preference on this device, like the editor style: it changes only how this browser draws the
 * composer. Only the phone composer reads it; a desktop's controls are one row in every case.
 */
import { devicePreference } from './device-preference.ts';

export const COMPOSER_DOCK_LAYOUT_KEY = 'fy-composer-dock-layout-v1';
export type ComposerDockLayout = 'stacked' | 'row' | 'auto';
export const COMPOSER_DOCK_LAYOUT_DEFAULT: ComposerDockLayout = 'stacked';

const preference = devicePreference<ComposerDockLayout>(
  COMPOSER_DOCK_LAYOUT_KEY,
  ['stacked', 'row', 'auto'],
  COMPOSER_DOCK_LAYOUT_DEFAULT,
);

export const parseComposerDockLayout = preference.parse;
export const readComposerDockLayout = preference.read;
export const writeComposerDockLayout = preference.write;
export const useComposerDockLayout = preference.use;
