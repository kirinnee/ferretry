import type { KernelPorts } from '../contract/ports/kernel-ports.ts';
import { carrierListenerPort, type CarrierListenerDeps } from './carrier-listener.ts';
import { publicDoorPort } from './public-door.ts';

/** Listener ports share one plugin lifecycle and the live dispatcher, composed without growing the boot function. */
export function listenerPorts(deps: CarrierListenerDeps): Pick<KernelPorts, 'carrierListener' | 'publicDoor'> {
  return { carrierListener: carrierListenerPort(deps), publicDoor: publicDoorPort(deps) };
}
