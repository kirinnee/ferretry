/**
 * The `end-mascot` panel: the cheering ferret, placed in the `onboarding.end` slot (the picture on Onboarding's last page,
 * "You're set up"). Onboarding offers the slot and imports nothing of this; the ferret is the same one the Connected screen
 * draws, so it answers a hover or a tap the same way (`features/pairing/ferret-mascot.tsx`). No props, no subject, no data.
 */
import { FerretMascot } from '../pairing/ferret-mascot.tsx';

export function EndMascotPanel() {
  return <FerretMascot pose="cheer" />;
}
