import type { FerretsApi } from '../../../contract/index.ts';
import type { FerretsService } from './service.ts';

/**
 * What other plugins hold under `ferrets`: an explicit object naming each member of {@link FerretsApi}, each forwarding
 * only the parameters the port declares. Whatever else the service has — a stop's end `cause`, a move's
 * `replaceLiveTerminal` and `target`, a route's `confirmRestore`, `revokeToken`, `rename`, the launch and its tokens —
 * is for this plugin's own callers and is not reachable here at runtime, not just refused by the types. `resume`
 * forwards only `automatic` and an `actor` of `warden` (attribution only). `effectiveLimits` is optional on the port
 * and the service has none, so it is
 * absent.
 */
export function ferretsPort(service: FerretsService): FerretsApi {
  return {
    get: ferret => service.get(ferret),
    list: filter => service.list(filter),
    mayTouch: (caller, target) => service.mayTouch(caller, target),
    children: ferret => service.children(ferret),
    harnesses: () => service.harnesses(),
    start: request => service.start(request),
    stop: (ferret, how, reason) => service.stop(ferret, how, reason),
    resume: (ferret, message, options) => {
      // Only what the port declares: automated recovery, the Warden's attribution for the turn's author, who must be
      // told what the resume decided, and who must be told what it typed for the message.
      const forwarded = {
        ...(options?.automatic === true ? { automatic: true } : {}),
        ...(options?.actor === 'warden' ? { actor: 'warden' as const } : {}),
        ...(options?.decided === undefined ? {} : { decided: options.decided }),
        ...(options?.onCarried === undefined ? {} : { onCarried: options.onCarried }),
      };
      return service.resume(ferret, message, Object.keys(forwarded).length === 0 ? undefined : forwarded);
    },
    attach: (ferret, handle) => service.attach(ferret, handle),
    handle: ferret => service.handle(ferret),
    workFolder: ferret => service.workFolder(ferret),
    sitrep: ferret => service.sitrep(ferret),
    summary: ferret => service.summary(ferret),
    managedWorktrees: () => service.managedWorktrees(),
    systemCallsign: prefix => service.systemCallsign(prefix),
    agentControl: ferret => service.agentControl(ferret),
    harness: (ferret, caller) => service.harness(ferret, caller),
    turns: (ferret, caller) => service.turns(ferret, caller),
    prompt: (ferret, caller) => service.prompt(ferret, caller),
    move: (ferret, runtime, options, caller) => service.move(ferret, runtime, options, caller),
  };
}
