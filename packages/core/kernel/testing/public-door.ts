import type { PublicDoorPort } from '../contract/ports/public-door.ts';
import { PUBLIC_DOOR_PLUGINS } from '../contract/ports/public-door.ts';
import type { Manifest } from '../manifest/types.ts';

/** Same permission wall as the real listener; a test supplies a listener fake rather than binding a socket. */
export function testPublicDoor(manifest: Manifest, supplied?: PublicDoorPort): PublicDoorPort {
  return {
    open: async input => {
      if (
        manifest.permissions?.publicDoor !== true ||
        !(PUBLIC_DOOR_PLUGINS as readonly string[]).includes(manifest.id)
      )
        throw new Error(`${manifest.id}: publicDoor is not permitted.`);
      if (supplied === undefined) throw new Error(`${manifest.id}: open a public door with no publicDoor fake`);
      return await supplied.open(input);
    },
  };
}
