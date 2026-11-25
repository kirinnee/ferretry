import { DELEGATE_PLUGINS, DELEGATE_ROUTES } from '../contract/ports/delegate.ts';
import { parseRouteKey } from '../contract/route.ts';
import type { Manifest } from './types.ts';

/** Checked at load for identity/shape, and over the whole graph for route existence (build and boot). */
export function delegateProblems(manifest: Manifest, manifests?: readonly Manifest[]): readonly string[] {
  const keys = manifest.permissions?.delegate;
  if (keys === undefined) return [];
  if (!(DELEGATE_PLUGINS as readonly string[]).includes(manifest.id))
    return [`${manifest.id} may not declare permissions.delegate`];
  const routes =
    manifests === undefined ? undefined : new Set(manifests.flatMap(m => (m.actions?.routes ?? []).map(r => r.key)));
  return keys.flatMap(key => {
    try {
      parseRouteKey(key);
    } catch {
      return [`${manifest.id} permissions.delegate has malformed route ${key}`];
    }
    if (!DELEGATE_ROUTES.includes(key)) return [`${manifest.id} permissions.delegate may not name route ${key}`];
    return routes !== undefined && !routes.has(key)
      ? [`${manifest.id} permissions.delegate names missing route ${key}`]
      : [];
  });
}
