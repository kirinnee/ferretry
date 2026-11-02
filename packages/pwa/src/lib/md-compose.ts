/**
 * The sole owner of the Markdown-composer display preference.
 *
 * This is intentionally a reader preference, not daemon data: it affects only
 * how the current browser paints a textarea, so daemon-scoping it would make a
 * daemon switch unexpectedly change the reader's editor chrome.
 */
import { devicePreference } from './device-preference.ts';

export const MD_COMPOSE_KEY = 'fy-markdown-composer-v1';
/** The composer's editor style: `on` Markdown (Notion-style), `rich` Rich text, `off` Plain text box. */
export type MdComposePref = 'on' | 'off' | 'rich';
/** Markdown, Notion-style is the default editor style (Settings › Composer › Editor style). */
export const MD_COMPOSE_DEFAULT: MdComposePref = 'on';

const preference = devicePreference<MdComposePref>(MD_COMPOSE_KEY, ['on', 'off', 'rich'], MD_COMPOSE_DEFAULT);

export const parseMdComposePref = preference.parse;
export const readMdComposePref = preference.read;
export const writeMdComposePref = preference.write;
/** A live browser preference with a deterministic static-rendering snapshot. */
export const useMdComposePref = preference.use;
