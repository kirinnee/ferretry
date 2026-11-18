/**
 * THE SOLE OWNER OF HOW THE PHONE COMPOSER LAYS OUT ITS BUTTONS (Settings › Composer › Button layout).
 *
 * Attach and the mic on one side of the box, Interrupt & send and Send on the other:
 *
 * - `row` — each side a row, always (the default: owner, 2026-11-17 — one clean row of attach, mic, text and send, as v4
 *   draws it; it replaced `stacked`). Nothing moves on focus or as typing starts; the box is one line while the text is.
 * - `stacked` — each side a column, always (the default from 2026-11-02, !A237, until the row above replaced it): the
 *   field keeps its width for typing. A device that chose it keeps it.
 * - `auto` — a row while the box is empty, stacked once there is a draft: the old switch, kept on purpose
 *   for whoever prefers it, jump and all.
 *
 * A reader preference on this device, like the editor style: it changes only how this browser draws the
 * composer. Only the phone composer reads it; a desktop's controls are one row in every case.
 */
import { devicePreference, localKey } from '@ferretry/app';

export const COMPOSER_DOCK_LAYOUT_KEY = localKey('conversation', 'composer-dock-layout');
export type ComposerDockLayout = 'stacked' | 'row' | 'auto';
export const COMPOSER_DOCK_LAYOUT_DEFAULT: ComposerDockLayout = 'row';

const preference = devicePreference<ComposerDockLayout>(
  COMPOSER_DOCK_LAYOUT_KEY,
  ['stacked', 'row', 'auto'],
  COMPOSER_DOCK_LAYOUT_DEFAULT,
);

export const parseComposerDockLayout = preference.parse;
export const readComposerDockLayout = preference.read;
export const writeComposerDockLayout = preference.write;
export const useComposerDockLayout = preference.use;
