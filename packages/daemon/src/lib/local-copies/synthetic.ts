/**
 * What every "copy from this machine" installer shares (docs/catalogs.md § Copying a skill from this machine,
 * § Copying an MCP server from this machine): the SYNTHETIC publisher and catalog the fleet is handed for a
 * runtime install, and the small pure helpers the records and the digests are made with.
 *
 * This machine is not a publisher, so the provenance a copy hands the fleet says so: a fixed publisher id of all
 * zeros named "This machine", and a fixed catalog id. A person reads the origin, never these.
 */

/** The synthetic publisher of a local copy: not a daemon, and not shaped like a real one's key. */
export const LOCAL_PUBLISHER = `fy_daemon_${'0'.repeat(43)}`;
export const LOCAL_PUBLISHER_NAME = 'This machine';
export const LOCAL_CATALOG_ID = `cat_${'0'.repeat(22)}`;

/** JSON with every object's keys sorted, so the same value always has the same text. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** 16 bytes as 22 base64url characters. */
export const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
