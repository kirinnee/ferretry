import { implementDaemon } from '@ferretry/kernel/manifest';
import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';
import manifest from '../manifest.ts';
import { nixTool } from './adapters/nix.ts';
import { shellsRoutes } from './lib/routes.ts';
import { createShellsService } from './lib/service.ts';

/**
 * Shells (daemon half, §4.9): resolves, pins and builds shell items with nix, and contributes the shell a runtime
 * names to that ferret's launch through `launch.parts`. Without nix every ferret keeps the machine's tools.
 */
export default implementDaemon(manifest, {
  build: ({ kernel }) => {
    const service = createShellsService({
      config: kernel.config,
      state: kernel.state,
      nix: nixTool(kernel.spawn),
      clock: kernel.clock,
      events: kernel.events,
      log: kernel.log,
    });
    const source: LaunchPartSource = { parts: async spec => await service.launchParts(spec.runtime) };
    return {
      routes: shellsRoutes(service),
      provides: {
        shells: {
          list: () => service.list(),
          get: async name => {
            const detail = await service.get(name);
            return detail === undefined ? undefined : { item: detail.item, lock: detail.lock };
          },
          nix: () => service.nix(),
        },
      },
      hooks: { 'launch.parts': () => [{ id: 'shells', order: 40, item: source }] },
    };
  },
});
