import { randomUUID } from 'node:crypto';
import { FerretPinsFile, type FerretId } from '../../contract/index.ts';
import { RegistryPinSessionDirectory, StatePinRepository } from '../adapters/pins/index.ts';
import { AgentPinSubsystem, withPinned } from '../lib/agent-pins/index.ts';
import { callerIsAgent } from '../lib/ferrets/launch-origin.ts';
import { PinService } from '../lib/pins/index.ts';
import { pinRoutes } from '../lib/runtime/mounts/pins.ts';
import { sessionPinRoutes } from '../lib/runtime/mounts/session-pin.ts';
import { resolveAgentAddress } from '../../contract/agent-address.ts';
import { callerFerret } from './caller.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, ready, agentPins, pinClock, pathFerret, reviveArchived, publishChanged } = f;
  // Pins (a3's handlers): the owner's sidebar pins (agent-pins.json) and each ferret's note board (<ferret>/pins.json).
  const pinnedReader = withPinned(
    {
      list: async () => {
        await ready();
        return registry
          .list()
          .map(ferret => registry.summary(ferret.id))
          .filter(summary => summary !== undefined);
      },
      get: async reference => {
        await ready();
        const resolution = resolveAgentAddress(
          reference,
          registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
        );
        return resolution.kind === 'session' ? registry.summary(resolution.id as FerretId) : undefined;
      },
    },
    agentPins,
  );
  // A pin is a keep the owner wrote: pinning an archived ferret brings it back into the live set (the store's own
  // idempotent revival, ancestors included). A revival that fails answers the failure; pinning again retries it, since
  // the pin is already saved and the ferret is still archived.
  const pinSubsystem = new AgentPinSubsystem(pinnedReader, agentPins);
  const sidebarPins = sessionPinRoutes(
    {
      pin: async reference => {
        const pinned = await pinSubsystem.pin(reference);
        await reviveArchived(pinned.id);
        return pinned;
      },
      unpin: async reference => await pinSubsystem.unpin(reference),
    },
    // A wake-up for views (the ferret list re-reads): a pin is not a registry change, so nothing else says it moved.
    publishChanged,
  );
  const noteBoard = pinRoutes({
    pins: new PinService(
      new RegistryPinSessionDirectory(ferret => registry.get(ferret as FerretId) !== undefined),
      new StatePinRepository(kernel.state, FerretPinsFile, pinClock),
      pinClock,
      { next: () => randomUUID() },
    ),
    ferretOf: pathFerret,
    callerOf: call => {
      const own = callerFerret(call);
      return { isAgent: callerIsAgent(call), ...(own === undefined ? {} : { ferret: own }) };
    },
  });

  return {
    routes: {
      'POST /v1/ferrets/:ferretId/pin': sidebarPins.pin,
      'POST /v1/ferrets/:ferretId/unpin': sidebarPins.unpin,
      'GET /v1/ferrets/:ferretId/pins': noteBoard.list,
      'POST /v1/ferrets/:ferretId/pins': noteBoard.apply,
    },
  };
}

export default { id: 'pins', register } satisfies FerretsFeature;
