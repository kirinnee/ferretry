/**
 * THE ISOLATION THE SECURE-COPY PIPELINE RUNS UNDER (secure-clip-1 fix2, R1).
 *
 * The pipeline test launches a REAL Chrome and a real worker through the production Browsers launcher. Left alone, that
 * launcher hands Chrome and the worker the review process's own `HOME` and `XDG_*` (the browser environment forwards them,
 * and a per-call environment wins over a spawn base), and Chrome can reach the network. This binds both:
 *
 * - every child the Browsers half starts gets `HOME`, every `XDG_*` directory and `TMPDIR` under ONE temporary home, whatever
 *   environment it was handed;
 * - every Chrome it starts gets `--proxy-server` to a local tripwire (loopback is never proxied by Chrome, so the loopback
 *   fixtures and the CDP pipe are untouched) and a host-resolver rule that resolves nothing but loopback, so an external URL
 *   can neither resolve nor leave the machine; the tripwire only records that it was asked.
 *
 * Ports are ephemeral. Nothing here names 7431 or 7458.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchPort, SpawnBytesOptions, SpawnOptions, SpawnPort } from '../../../contract/index.ts';

/** The XDG base directories Chrome and its worker may write under, each below the temporary home. */
export const XDG_DIRECTORIES = {
  XDG_CONFIG_HOME: '.config',
  XDG_CACHE_HOME: '.cache',
  XDG_DATA_HOME: '.local/share',
  XDG_STATE_HOME: '.local/state',
  XDG_RUNTIME_DIR: 'run',
} as const;

/** The whole environment that binds a child to `home`. */
export function homeEnvironment(home: string): Record<string, string> {
  const bound: Record<string, string> = { HOME: home, TMPDIR: join(home, 'tmp') };
  for (const [name, below] of Object.entries(XDG_DIRECTORIES)) bound[name] = join(home, below);
  return bound;
}

/** The system font directories a Chrome reads text from, when they exist (read-only; nothing of the real home). */
const SYSTEM_FONT_DIRECTORIES = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/run/current-system/sw/share/X11/fonts',
];

/**
 * Fonts, without the real home. A Chrome whose HOME moved can lose the fonts the user's profile gave it (a Nix profile's
 * fonts are found through HOME), and with no font at all it lays no text out: `innerText` is empty and a copy reads
 * "nothing". So the temporary home gets its own `fonts.conf` naming only system font directories (and, on a Nix machine,
 * the store's own font packages); its path is returned for `FONTCONFIG_FILE`, which the launcher forwards to Chrome.
 */
export async function writeFontConfiguration(home: string): Promise<string> {
  const directories = SYSTEM_FONT_DIRECTORIES.filter(path => existsSync(path));
  if (existsSync('/nix/store')) {
    for (const entry of await readdir('/nix/store').catch(() => [] as string[])) {
      if (/^[a-z0-9]{32}-(?:liberation-fonts|dejavu-fonts)[^/]*$/u.test(entry) && !entry.endsWith('.drv')) {
        const fonts = join('/nix/store', entry, 'share', 'fonts');
        if (existsSync(fonts)) directories.push(fonts);
      }
    }
  }
  const folder = join(home, '.config', 'fontconfig');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'fonts.conf');
  await writeFile(
    file,
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      ...directories.map(path => `  <dir>${path}</dir>`),
      `  <cachedir>${join(home, '.cache', 'fontconfig')}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n'),
  );
  return file;
}

/** The names `homeEnvironment` binds. */
export const BOUND_NAMES: readonly string[] = ['HOME', 'TMPDIR', ...Object.keys(XDG_DIRECTORIES)];

/** The switches that keep a Chrome off the network: its traffic goes to `proxy`, and only loopback resolves. */
export function egressArguments(proxy: string): readonly string[] {
  return [
    `--proxy-server=${proxy}`,
    '--proxy-bypass-list=127.0.0.1;localhost',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
  ];
}

/** One child a wrapped port started. */
export interface Launch {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const isChrome = (args: readonly string[]): boolean => args.some(arg => arg.startsWith('--user-data-dir='));

/**
 * `inner`, with every child bound to `home` and every Chrome kept off the network. `launches` records what was really
 * started, so a test can assert the environment and switches Chrome and the worker actually received.
 */
export function isolatedSpawn(
  inner: SpawnPort,
  options: { readonly home: string; readonly proxy: string; readonly launches: Launch[] },
): SpawnPort {
  const bound = homeEnvironment(options.home);
  const bind = (program: string, args: readonly string[], given: SpawnOptions | undefined) => {
    const plain = (given?.env ?? {}) as Readonly<Record<string, string>>;
    const env = { ...plain, ...bound };
    const full = isChrome(args) ? [...args, ...egressArguments(options.proxy)] : args;
    options.launches.push({ program, args: full, env });
    return { full, given: { ...given, env } as SpawnOptions };
  };
  return {
    run: (program, args, given) => {
      const next = bind(program, args, given);
      return inner.run(program, next.full, next.given);
    },
    runBytes: (program, args, given) => {
      const next = bind(program, args, given);
      return inner.runBytes(program, next.full, next.given as SpawnBytesOptions);
    },
    start: (program, args, given) => {
      const next = bind(program, args, given);
      return inner.start(program, next.full, next.given);
    },
  };
}

/** A fetch port that answers loopback addresses and refuses every other host: no request leaves the machine. */
export function loopbackFetch(inner: FetchPort): FetchPort {
  return {
    request: async (url, init) => {
      const host = new URL(typeof url === 'string' ? url : url.href).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]')
        throw new Error(`the pipeline test refuses an external request to ${host}`);
      return await inner.request(url, init);
    },
  };
}
