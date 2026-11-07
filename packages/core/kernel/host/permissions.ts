import type { FetchPort, SpawnPort } from '../contract/ports.ts';

export class PermissionError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'PermissionError';
  }
}

const programName = (program: string): string => program.slice(program.lastIndexOf('/') + 1);

/** Only programs the manifest declared in `permissions.spawn` (§3.7); refused before anything starts. */
export function restrictSpawn(plugin: string, declared: readonly string[], base: SpawnPort): SpawnPort {
  const allowed = new Set(declared);
  const check = (program: string): void => {
    if (!allowed.has(program) && !allowed.has(programName(program)))
      throw new PermissionError(`${plugin} may not run ${programName(program)}: its manifest does not declare it.`);
  };
  return {
    run: async (program, args, options) => {
      check(program);
      return await base.run(program, args, options);
    },
    start: (program, args, options) => {
      check(program);
      return base.start(program, args, options);
    },
  };
}

/** `*.example.com` matches subdomains only; an exact host matches itself. */
export function hostAllowed(host: string, declared: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return declared.some(entry => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.') ? lower.endsWith(pattern.slice(1)) && lower !== pattern.slice(2) : lower === pattern;
  });
}

/** HTTP only to hosts the manifest declared in `permissions.network`; refused before a socket opens. */
export function restrictFetch(plugin: string, declared: readonly string[], base: FetchPort): FetchPort {
  return {
    request: async (url, init) => {
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        throw new PermissionError(`${plugin} asked for a malformed address.`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new PermissionError(`${plugin} may only make HTTP requests.`);
      if (!hostAllowed(parsed.hostname, declared))
        throw new PermissionError(`${plugin} may not reach ${parsed.hostname}: its manifest does not declare it.`);
      // Redirects are not followed blindly: a declared host could bounce the request anywhere.
      return await base.request(parsed, { ...init, redirect: 'manual' });
    },
  };
}
