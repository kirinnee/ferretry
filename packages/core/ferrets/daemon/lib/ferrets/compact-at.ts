import { ApiError } from '@ferretry/kernel/contract';
import type { FerretId } from '../../../contract/index.ts';
import { type CompactAt, CompactAtSchema } from '../../../contract/view/compact-at.ts';
import type { FerretsCore } from './core.ts';

/**
 * A ferret's OWN compaction trigger (`FerretsApi.compactAt`): its session config's, else the one its start asked.
 * `undefined` for a ferret this daemon does not know or one that follows its login. The same `mayTouch` rule as `harness`.
 */
export async function compactAt(
  { registry, ports, requireMayTouch }: FerretsCore,
  ferret: FerretId,
  caller?: FerretId,
): Promise<CompactAt | undefined> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return undefined;
  requireMayTouch(caller, ferret);
  return (
    (await ports.session?.compactAt?.(ferret).catch(() => undefined)) ?? registry.detailsOf(ferret)?.options?.compactAt
  );
}

/**
 * Records a ferret's own compaction trigger (`FerretsApi.setCompactAt`). Fails closed: a value the schema cannot parse
 * (below the floor, not `auto`, not an integer) is refused before anything is written, an unknown ferret is 404, a
 * caller that may not touch it is 403, and a Ferrets with no session files cannot record one (503). A clear (`undefined`)
 * also drops the start's own value, so the login's default applies again.
 */
export async function setCompactAt(
  { registry, ports, requireMayTouch, saveDetails }: FerretsCore,
  ferret: FerretId,
  value: unknown,
  caller?: FerretId,
): Promise<void> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) throw new ApiError(404, `no ferret ${ferret}`, 'not-found');
  requireMayTouch(caller, ferret);
  const parsed = value === undefined ? undefined : CompactAtSchema.safeParse(value);
  if (parsed !== undefined && !parsed.success)
    throw new ApiError(400, parsed.error.issues[0]?.message ?? 'not a compact-at value', 'invalid_compact_at');
  const write = ports.session?.setCompactAt?.bind(ports.session);
  if (write === undefined) throw new ApiError(503, "this ferret's session files are unavailable", 'plugin_unavailable');
  await write(ferret, parsed?.data);
  // A clear is the person's deliberate "follow the login again": the start's own value (`options.compactAt`) is what
  // `compactAt` and every launch fall back to when the session config says none, so it goes too, or the start value
  // would come back after a clear. Every other option and detail keeps its value.
  if (parsed === undefined) {
    const before = registry.detailsOf(ferret);
    if (before?.options?.compactAt !== undefined) {
      const { compactAt: _start, ...options } = before.options;
      await saveDetails(ferret, { ...before, options });
    }
  }
}
