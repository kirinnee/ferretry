/**
 * WHERE `cloudflared` IS: the operator's `FY_CLOUDFLARED`, or the daemon's own `PATH`. Never a download.
 *
 * A NAMED PATH THAT RESOLVES TO NOTHING DOES NOT FALL BACK TO THE SEARCH. The operator named a binary;
 * quietly running a different one found on `PATH` would leave them believing the opposite of what
 * happened. It is refused with its own sentence instead.
 */

import {
  CLOUDFLARED_NOT_ON_PATH,
  CLOUDFLARED_OVERRIDE_VARIABLE,
  type CloudflaredLocation,
  type CloudflaredLocatorPort,
  cloudflaredOverrideRefusal,
} from '../../daemon/lib/tunnel/index.ts';

export class CloudflaredLocator implements CloudflaredLocatorPort {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly search: (name: string, path: string) => string | undefined,
    private readonly executable: (path: string) => boolean,
  ) {}

  locate(): CloudflaredLocation {
    const named = this.environment[CLOUDFLARED_OVERRIDE_VARIABLE]?.trim();
    if (named !== undefined && named !== '')
      return this.executable(named)
        ? { kind: 'found', path: named, via: 'override' }
        : cloudflaredOverrideRefusal(named);
    const found = this.search('cloudflared', this.environment.PATH ?? '');
    return found === undefined ? CLOUDFLARED_NOT_ON_PATH : { kind: 'found', path: found, via: 'path' };
  }
}
