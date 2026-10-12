import { type FleetEnvironmentView, FleetEnvironmentViewSchema } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import type { DaemonFetch } from './runtime-models.ts';

export type EnvironmentDifferenceKind = 'target-only' | 'source-only' | 'differs';

export interface EnvironmentDifference {
  readonly key: string;
  readonly kind: EnvironmentDifferenceKind;
  readonly target?: string;
  readonly source?: string;
}

/**
 * Reads one daemon's portable fleet profile environment through the fetch it is handed.
 *
 * The fetch is REQUIRED: this read used to call the network directly with a hand-built header, so on
 * a daemon only the relay could reach the panel said "Read failed" while every other panel worked. A
 * caller hands in the carrier router's fetch, and the body is parsed rather than cast.
 */
export const readFleetEnvironment = async (
  connection: DaemonConnection,
  fetcher: DaemonFetch,
  signal?: AbortSignal,
): Promise<FleetEnvironmentView> => {
  const target = daemonRequest(connection, '/v1/fleet/environment', {
    method: 'GET',
    headers: { 'x-ferretry-client': 'ui' },
    cache: 'no-store',
    signal: signal ?? null,
  });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === 'string' ? body.error : `Read failed (${response.status})`);
  }
  const parsed = FleetEnvironmentViewSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('The daemon answered with an environment this page cannot read.');
  return parsed.data;
};

/** Every key either side publishes, sorted, with how the two sides disagree about it. */
export const environmentDifferences = (
  target: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string>>,
): EnvironmentDifference[] => {
  const result: EnvironmentDifference[] = [];
  for (const key of [...new Set([...Object.keys(target), ...Object.keys(source)])].sort()) {
    const inTarget = Object.hasOwn(target, key);
    const inSource = Object.hasOwn(source, key);
    if (inTarget && !inSource) result.push({ key, kind: 'target-only', target: target[key] });
    else if (inSource && !inTarget) result.push({ key, kind: 'source-only', source: source[key] });
    else if (target[key] !== source[key])
      result.push({ key, kind: 'differs', target: target[key], source: source[key] });
  }
  return result;
};
