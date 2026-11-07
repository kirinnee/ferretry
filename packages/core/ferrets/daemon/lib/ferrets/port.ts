import type { FerretId, FerretsApi, ResumeOptions } from '../../../contract/index.ts';
import type { FerretsService } from './service.ts';

/**
 * What other plugins hold under `ferrets`: the service itself, except that `resume` forwards only what the port
 * declares. A move's `replaceLiveTerminal` and `target` and a route's `confirmRestore` are for this plugin's own
 * callers, so an options object another plugin built or spread at runtime has them dropped here, not just refused by
 * the types (a live ferret passed through the port keeps its pane and runtime).
 */
export function ferretsPort(service: FerretsService): FerretsApi {
  return new Proxy(service, {
    get(target, property) {
      if (property === 'resume')
        return async (ferret: FerretId, message?: string, options?: ResumeOptions) =>
          await target.resume(ferret, message, options?.automatic === true ? { automatic: true } : undefined);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
