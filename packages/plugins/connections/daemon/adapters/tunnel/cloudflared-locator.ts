/**
 * WHERE `cloudflared` IS: the operator's `FY_CLOUDFLARED`, or the daemon's `PATH` as the kernel searches it. Never a download.
 *
 * A NAMED PATH THAT RESOLVES TO NOTHING DOES NOT FALL BACK TO THE SEARCH. The operator named a binary;
 * quietly running a different one found on `PATH` would leave them believing the opposite of what
 * happened. It is refused with its own sentence instead.
 */

import type { PathsPort } from '@ferretry/kernel/contract';
import {
  CLOUDFLARED_NOT_ON_PATH,
  CLOUDFLARED_OVERRIDE_VARIABLE,
  type CloudflaredLocation,
  type CloudflaredLocatorPort,
  cloudflaredOverrideRefusal,
} from '../../lib/tunnel/index.ts';

/**
 * Today's finder's rules over `kernel.paths.locate` (the plugin declared `permissions.which` and `whichOverrides:
 * ['FY_CLOUDFLARED']`): the kernel reads the one override variable, judges it absolute, executable and named
 * `cloudflared`, and searches its bounded `PATH` only when no override is set. A named path that fails is refused
 * in its own sentence, never swapped for another binary. Nothing is executed and no environment is handed over.
 */
export class KernelCloudflaredLocator implements CloudflaredLocatorPort {
  constructor(private readonly paths: Pick<PathsPort, 'locate'>) {}

  async locate(): Promise<CloudflaredLocation> {
    const found = await this.paths.locate('cloudflared', { override: CLOUDFLARED_OVERRIDE_VARIABLE });
    switch (found.kind) {
      case 'found':
        return { kind: 'found', path: found.path, via: found.via };
      case 'override_unusable':
        return cloudflaredOverrideRefusal(found.path);
      case 'absent':
        return CLOUDFLARED_NOT_ON_PATH;
    }
  }
}
