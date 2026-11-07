/**
 * Reading the link chain and `nix profile list --json` for one executable. Copied from today's
 * `daemon-update.ts` (`parseNixProfileList`, `symlinkHops`, `nixStorePaths`, `passesThroughHomeManagerPath`);
 * pure, so the filesystem and `nix` stay the adapter's.
 */
import { z } from 'zod';

const NixProfileElementSchema = z.looseObject({ storePaths: z.array(z.string()).optional() });
const NixProfileListSchema = z.looseObject({
  elements: z.union([z.record(z.string(), NixProfileElementSchema), z.array(NixProfileElementSchema)]),
});

/** What a nix profile says about one executable. */
export interface NixProfileFacts {
  /** The element whose store paths lead to the executable, as `nix profile upgrade` names it. */
  readonly element?: string | undefined;
  /** Whether the profile is a home-manager generation. */
  readonly homeManager: boolean;
}

const HOME_MANAGER_PATH = /^\/nix\/store\/[0-9a-z]{32}-home-manager-path(?:\/|$)/u;
const isHomeManagerPath = (storePath: string): boolean => /-home-manager-path$/u.test(storePath);
const isStorePath = (path: string): boolean => /^\/nix\/store\/[0-9a-z]{32}-[^/]+/u.test(path);
const parentDirectory = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

/**
 * The profile element that holds the executable, from `nix profile list --json`.
 *
 * `candidates` is every store path the launched path leads through — the first hop out of the profile AND the
 * final resolved file. The home-manager element is never "the element": it is what `homeManager` reports. Both
 * shapes Nix has shipped are read (version 3 keys elements by name, version 2 is an array whose index is the
 * name); anything else answers "no element", never a guess.
 */
export function parseNixProfileList(value: unknown, candidates: readonly string[]): NixProfileFacts {
  const parsed = NixProfileListSchema.safeParse(value);
  if (!parsed.success) return { homeManager: false };
  const entries: [string, z.infer<typeof NixProfileElementSchema>][] = Array.isArray(parsed.data.elements)
    ? parsed.data.elements.map((element, index) => [String(index), element])
    : Object.entries(parsed.data.elements);
  const holds = (storePath: string): boolean =>
    candidates.some(path => path === storePath || path.startsWith(`${storePath}/`));
  const isHomeManager = ([name, entry]: [string, z.infer<typeof NixProfileElementSchema>]): boolean =>
    name === 'home-manager-path' || (entry.storePaths ?? []).some(isHomeManagerPath);
  const element = entries.find(entry => !isHomeManager(entry) && (entry[1].storePaths ?? []).some(holds))?.[0];
  return { element, homeManager: entries.some(isHomeManager) };
}

/** Link hops are capped at the kernel's own limit, so a loop ends instead of spinning. */
const MAX_LINK_HOPS = 40;

/**
 * Every symbolic link met on the way from `path` to the file it names, each as an absolute target. `readLink`
 * answers a link's target, or `undefined` when the path is not a link (or is not there). Directory links count,
 * so the walk goes component by component.
 */
export async function symlinkHops(
  path: string,
  readLink: (path: string) => Promise<string | undefined>,
): Promise<readonly string[]> {
  const hops: string[] = [];
  let pending = path.split('/').filter(part => part !== '');
  let resolved = '';
  while (pending.length > 0 && hops.length < MAX_LINK_HOPS) {
    const [name = '', ...rest] = pending;
    pending = rest;
    if (name === '.') continue;
    if (name === '..') {
      resolved = parentDirectory(resolved) === '/' ? '' : parentDirectory(resolved);
      continue;
    }
    const candidate = `${resolved}/${name}`;
    const target = await readLink(candidate);
    if (target === undefined) {
      resolved = candidate;
      continue;
    }
    const absolute = target.startsWith('/') ? target : `${resolved}/${target}`;
    hops.push(absolute);
    pending = [...absolute.split('/').filter(part => part !== ''), ...pending];
    resolved = '';
  }
  return hops;
}

/** The store paths a link chain leads through, in order. */
export const nixStorePaths = (hops: readonly string[]): readonly string[] => hops.filter(isStorePath);

/** Whether a link chain passes through a `home-manager-path` store path — home-manager's own generation. */
export const passesThroughHomeManagerPath = (hops: readonly string[]): boolean =>
  hops.some(hop => HOME_MANAGER_PATH.test(hop));
