import { PUBLIC_DOOR_PLUGINS } from '../contract/ports/public-door.ts';
import type { Manifest } from './types.ts';

/** Checked at declaration and boot: a public surface can never borrow Gate's authenticated authority. */
export function publicDoorProblems(manifest: Manifest): readonly string[] {
  const problems: string[] = [];
  const allowed = (PUBLIC_DOOR_PLUGINS as readonly string[]).includes(manifest.id);
  if (manifest.permissions?.publicDoor === true && !allowed)
    problems.push(`plugin ${manifest.id}: permissions.publicDoor is not allowed`);
  for (const route of manifest.actions?.routes ?? []) {
    if (route.door === undefined) continue;
    if (
      !allowed ||
      route.door !== 'public' ||
      route.minimum !== 'none' ||
      route.capability !== undefined ||
      route.caller !== 'any' ||
      route.wardenRemedy !== undefined ||
      route.privilegedOnly === true ||
      route.consultsGrants === true
    )
      problems.push(
        `plugin ${manifest.id}: route ${route.key} must be an allow-listed public door with minimum none, caller any and no capability, remedy, grants or privileged requirement`,
      );
  }
  return problems;
}
