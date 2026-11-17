/**
 * The built Ferrets manifest `actions`, as one canonical JSON text: every descriptor field of every route, socket, tool
 * and verb, keys sorted at every depth (a descriptor's key order is not meaningful), arrays in declaration order. A zod
 * `input` is written as its JSON Schema; anything else that is not JSON is named, never dropped. The fixture
 * `tests/fixtures/manifest-actions.base.json` is this dump taken from the commit before the actions moved into
 * `manifest/actions/*.actions.ts`.
 */
import { z } from 'zod';
import manifest from '../../manifest.ts';

const canonical = (value: unknown): unknown => {
  if (value instanceof z.ZodType) return { zod: z.toJSONSchema(value) };
  if (typeof value === 'function') return `[function ${value.name}]`;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
};

export const actionsDump = (): string => {
  const {
    routes = [],
    sockets = [],
    agentTools = [],
    cli = [],
    ...rest
  } = manifest.actions as unknown as Record<string, unknown[]>;
  return `${JSON.stringify(canonical({ routes, sockets, agentTools, cli, rest }), null, 2)}\n`;
};
