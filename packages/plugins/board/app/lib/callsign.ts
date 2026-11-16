/**
 * A callsign shown to a reader. Stored lowercase, shown Title-cased (`ms-98` -> `Ms-98`); a callsign Ferretry gave a
 * ferret itself (`warden-00002a`) is an identifier and keeps its prefix with the hex digits uppercase.
 */
const SYSTEM_CALLSIGN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  const system = SYSTEM_CALLSIGN.exec(slug);
  if (system?.[1] !== undefined && system[2] !== undefined && Number.parseInt(system[2], 16) !== 0)
    return `${system[1].toLowerCase()}-${system[2].toUpperCase()}`;
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};
