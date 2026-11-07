import type { Clock, StatePort } from '@ferretry/kernel/contract';
import { StateRenderRepository } from './adapters/render-store.ts';
import { RenderService } from './lib/service.ts';
import { serialExecutor } from './lib/types.ts';
import { bodyRoute, metaRoute, saveRoute } from './routes.ts';

export { RENDER_META_STATE, RENDER_PAYLOAD_STATE } from './adapters/state.ts';
export { RenderError } from './lib/types.ts';
export { RenderService } from './lib/service.ts';

/** What the renders slice is built from: the kernel's state and clock, nothing else. */
export interface RendersNeeds {
  readonly state: Pick<StatePort, 'read' | 'write' | 'list'>;
  readonly clock: Pick<Clock, 'now'>;
}

/** The saved pictures: the service, and the three routes of the manifest. Inert until a request. */
export function buildRenders(needs: RendersNeeds) {
  const renders = new RenderService(
    new StateRenderRepository(needs.state),
    { now: () => needs.clock.now() },
    serialExecutor(),
  );
  return {
    service: renders,
    routes: {
      'POST /v1/renders': saveRoute(renders),
      'GET /v1/renders/:id/meta': metaRoute(renders),
      'GET /v1/renders/:id': bodyRoute(renders),
    },
  } as const;
}
