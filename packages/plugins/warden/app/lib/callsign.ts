/** How a ferret is named on the Warden's pages: its callsign, the task it was given, its folder. */

import { displaySystemCallsign } from '../wire.ts';

/** What a ferret carries that the Warden names it by. */
export interface TitledConfig {
  readonly id: string;
  readonly name?: string | null;
  readonly task?: string | null;
  readonly cwd?: string | null;
}

/** One ferret as the page lists it: the config it is named by (its state is never read by this half). */
export interface FerretView {
  readonly config: TitledConfig;
  readonly state?: Readonly<Record<string, unknown>>;
}

const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

/** A callsign Ferretry gave a ferret it started itself (`warden-00002a`), shown as an identifier. */
const isSystemCallsign = (callsign: string): boolean => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  return match?.[2] !== undefined && Number.parseInt(match[2], 16) !== 0;
};

/** Title-cases a callsign slug for display: `ms-98` becomes `Ms-98`; a system callsign shows its hex digits uppercase. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  if (isSystemCallsign(slug)) {
    const match = SYSTEM_CALLSIGN_PATTERN.exec(slug);
    return `${(match?.[1] ?? '').toLowerCase()}-${(match?.[2] ?? '').toUpperCase()}`;
  }
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

/** A ferret id cut to eight characters for a label. */
export const shortFerretId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** The ferret's one-line name: its callsign, else its task, else its id. */
export const ferretDisplayName = (ferret: { readonly config: TitledConfig }): string => {
  const { config } = ferret;
  const named = displayCallsign(config.name) || (config.task ?? '').trim() || config.id;
  return displaySystemCallsign(named);
};

const baseName = (path: string): string => path.replace(/\/+$/u, '').split('/').pop() ?? '';

/** The title a row shows (what the ferret is doing, else its folder, else its callsign) and the callsign beside it. */
export const ferretTitles = (config: TitledConfig): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(config.name);
  const task = (config.task ?? '').trim();
  if (task !== '' && task !== callsign) return { title: task, ferret: callsign === '' ? null : callsign };
  const folder = config.cwd ? baseName(config.cwd) : '';
  if (folder !== '') return { title: folder, ferret: callsign === '' ? null : callsign };
  return { title: callsign || config.id, ferret: null };
};
