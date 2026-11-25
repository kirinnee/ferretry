import { PUBLIC_DOOR_PLUGINS } from '../contract/ports/public-door.ts';
import type { Manifest } from './types.ts';

/** API and process-health namespaces belong to the daemon, even if the plugin declares no private route there. */
const RESERVED = new Set([
  'v1',
  'api',
  'health',
  'healthz',
  'metrics',
  'live',
  'livez',
  'ready',
  'readyz',
  'liveness',
  'readiness',
]);

function literalPublicPath(path: string): boolean {
  if (!/^(?:\/[A-Za-z0-9._~-]+)+$/u.test(path)) return false;
  const segments = path.slice(1).split('/');
  return !RESERVED.has(segments[0]?.toLowerCase() ?? '') && !segments.some(part => part === '.' || part === '..');
}

/** Checked at declaration and boot: a public surface can never borrow Gate's authenticated authority. */
export function publicDoorProblems(manifest: Manifest): readonly string[] {
  const problems: string[] = [];
  const allowed = (PUBLIC_DOOR_PLUGINS as readonly string[]).includes(manifest.id);
  if (manifest.permissions?.publicDoor === true && !allowed)
    problems.push(`plugin ${manifest.id}: permissions.publicDoor is not allowed`);
  for (const route of manifest.actions?.routes ?? []) {
    if (route.door === undefined) continue;
    if (!literalPublicPath(route.path) || !/^[A-Z]+$/u.test(route.method))
      problems.push(
        `plugin ${manifest.id}: route ${route.key} must use an exact canonical literal path outside daemon API and liveness namespaces`,
      );
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
