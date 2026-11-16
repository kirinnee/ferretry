import manifest from '../../manifest.ts';

/** The hosts Logins declared in `permissions.network`: the only origins its fetch port will reach. */
export const manifestHosts = (): readonly string[] => manifest.permissions.network;
