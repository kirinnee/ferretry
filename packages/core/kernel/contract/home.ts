import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/** The whole-home format. A reader accepts exactly this one (§9.3). */
export const HOME_FORMAT = 1 as const;

export const HomeJsonSchema = z.strictObject({
  format: z.literal(HOME_FORMAT),
  createdBy: z.string().min(1),
  createdAt: InstantSchema,
});
export type HomeJson = z.infer<typeof HomeJsonSchema>;

/** What the kernel (or `fy`) found at `FY_HOME`, read by the adapter; `decideHome` itself touches nothing. */
export type HomeProbe =
  | { readonly kind: 'missing' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'io-error'; readonly message: string }
  | { readonly kind: 'no-home-json' }
  | { readonly kind: 'home-json'; readonly text: string };

export type HomeDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'start'; readonly home: HomeJson }
  | {
      readonly kind: 'refuse';
      readonly found: 'not-empty-no-home-json' | 'unreadable' | 'lower-format' | 'higher-format' | 'io-error';
      readonly sentence: string;
    };

const CARRY_OVER_SENTENCE = (home: string): string =>
  `${home} is not empty and has no home.json, so Ferretry will not use or change it.\n` +
  'If it is a home from an older Ferretry, follow docs/migration/clean-slate-prompt.md: it moves the folder aside ' +
  'with your yes, and Ferretry then starts empty.\n' +
  'If it is a Ferretry 5 home whose home.json was lost, restore home.json from a backup.\n' +
  'Or point FY_HOME at another folder.';

/**
 * The one question the kernel asks on start (§9.3); `fy` calls the same function. The product never decides that a
 * folder is an old home and never moves a whole home: anything but nothing, empty, or a format-1 `home.json` is
 * refused with nothing touched. Pure and total.
 */
export function decideHome(home: string, probe: HomeProbe): HomeDecision {
  switch (probe.kind) {
    case 'missing':
    case 'empty':
      return { kind: 'create' };
    case 'io-error':
      return {
        kind: 'refuse',
        found: 'io-error',
        sentence: `Ferretry could not read ${home} (${probe.message}), so it will not use or change it.`,
      };
    case 'no-home-json':
      return { kind: 'refuse', found: 'not-empty-no-home-json', sentence: CARRY_OVER_SENTENCE(home) };
    case 'home-json': {
      let decoded: unknown;
      try {
        decoded = JSON.parse(probe.text);
      } catch {
        return unreadable(home);
      }
      const format =
        typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>).format : undefined;
      if (typeof format === 'number' && Number.isInteger(format) && format !== HOME_FORMAT) {
        const lower = format < HOME_FORMAT;
        return {
          kind: 'refuse',
          found: lower ? 'lower-format' : 'higher-format',
          sentence: lower
            ? `${home} is a home from an older Ferretry (format ${format}); follow the carry-over prompt to move it aside.`
            : `${home} was written by a newer Ferretry (format ${format}); update Ferretry to use it.`,
        };
      }
      const parsed = HomeJsonSchema.safeParse(decoded);
      return parsed.success ? { kind: 'start', home: parsed.data } : unreadable(home);
    }
  }
}

function unreadable(home: string): HomeDecision {
  return {
    kind: 'refuse',
    found: 'unreadable',
    sentence: `${home}/home.json cannot be read, so Ferretry will not use or change ${home}. Restore it from a backup.`,
  };
}

/** The moved-aside suffix, defined once (§9.3): `<FY_HOME>-before-<YYYY-MM-DD-HHMM>`, `state/<id>-before-<…>`. */
export const BEFORE_SUFFIX = /-before-\d{4}-\d{2}-\d{2}-\d{4}$/;

/**
 * Whether an absolute, symlink-resolved path is inside the fence (§7.7, §9.3): the live home, every
 * `<home>-before-*` folder, and every `state/<id>-before-*` folder. Every root handle, file tool, import, catalog
 * install, attachment and upload staging asks this after resolving symlinks. Pure; paths use `/`.
 */
export function insideFence(home: string, resolvedPath: string): boolean {
  const homePath = stripTrailingSlash(home);
  const path = stripTrailingSlash(resolvedPath);
  if (path === homePath || path.startsWith(`${homePath}/`)) return true;
  const parent = homePath.slice(0, homePath.lastIndexOf('/') + 1);
  const homeName = homePath.slice(parent.length);
  if (!path.startsWith(parent)) return false;
  const first = path.slice(parent.length).split('/')[0] ?? '';
  return first.startsWith(`${homeName}-before-`);
}

/** The folder name a plugin's state is moved aside to. */
export function beforeFolderName(id: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${id}-before-${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
