import { ApiError, type Carrier, type CarrierStatus, type SessionLayer } from '@ferretry/kernel/contract';
import { directCarrierSocketRoute } from '../runtime/mounts/direct-carrier.ts';
import type { DirectCarrierDependencies } from './direct-carrier.ts';
/** The Kernel starts this provider with its session layer before accepting direct upgrades. */
export class DirectCarrier implements Carrier {
  #layer: SessionLayer | undefined;
  readonly route: ReturnType<typeof directCarrierSocketRoute>;
  constructor(options: Omit<DirectCarrierDependencies, 'sessions'>) {
    this.route = directCarrierSocketRoute({
      ...options,
      sessions: () => {
        if (this.#layer === undefined)
          throw new ApiError(503, 'the direct carrier is not started', 'plugin_unavailable');
        return this.#layer;
      },
    });
  }
  async start(layer: SessionLayer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.#layer = layer;
    signal.addEventListener(
      'abort',
      () => {
        this.#layer = undefined;
        this.route.stop();
      },
      { once: true },
    );
  }
  status(): CarrierStatus {
    return this.#layer === undefined
      ? { state: 'off', sentence: 'the direct carrier is stopped' }
      : { state: 'ready', sentence: 'the direct carrier is ready' };
  }
}
