import * as registry from './index.ts';

/** The part a registry line `<name>` carries: its `<name>Part` export. */
type PartOf<Namespace> = {
  [Name in keyof Namespace & string]: Namespace[Name] extends Record<`${Name}Part`, infer Part> ? Part : never;
}[keyof Namespace & string];

/**
 * The parts the Claude harness is composed of, in name order, built from the one-line-per-part registry in `index.ts`.
 * The order is explicit here (sorted by registry name), never the order of the lines; a line whose file lacks its
 * `<name>Part` export is refused at once.
 */
export const CLAUDE_PARTS: readonly PartOf<typeof registry>[] = Object.keys(registry)
  .sort()
  .map(name => {
    const part = (registry as Record<string, Record<string, unknown>>)[name]?.[`${name}Part`];
    if (typeof part !== 'function')
      throw new Error(`the Claude harness registry line "${name}" has no ${name}Part export`);
    return part as PartOf<typeof registry>;
  });
