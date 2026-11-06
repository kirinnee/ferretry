import { FileRenderRepository } from '../../src/adapters/renders/index.ts';
import { KeyedSerialExecutor } from '../../src/adapters/index.ts';
import { type FileSystemPort, type FoundationPaths, type RenderClock, RenderService } from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { rendersContribution } from '../../src/lib/runtime/mounts/renders.ts';

/**
 * Saved pictures: the `svg` and `html` a ferret keeps as daemon files and cites by a short token
 * (`/v1/renders`, docs/renders.md).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries), no jobs and no releases: the service is inert until a request.
 */

/** What the renders module is built from. */
export interface RendersNeeds {
  /** The state home's directories: the pictures live beside the rest of its state. */
  readonly paths: FoundationPaths;
  /** The state home's confined filesystem. */
  readonly stateFiles: FileSystemPort;
  /** The clock a saved picture is stamped with. */
  readonly clock: RenderClock;
}

export const rendersModule: DaemonModule<void, RendersNeeds, RenderService> = {
  id: 'renders',
  build: needs => {
    // Its saves run one at a time on a queue of their own: the collision check and the quotas read the whole store.
    const renders = new RenderService(
      new FileRenderRepository(needs.paths, needs.stateFiles),
      needs.clock,
      new KeyedSerialExecutor(),
    );
    return { id: 'renders', provides: renders, jobs: {}, contributes: rendersContribution(renders) };
  },
};
