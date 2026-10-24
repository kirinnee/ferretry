/**
 * Compiles ONE standalone executable — the single place every release channel (compile.sh for the
 * archives, cask and packages; nix/ferretry.nix for the flake) turns a package's bin entry into a
 * binary, so the browser worker's build-time fixes cannot be applied in one channel and missed in
 * another.
 *
 *   bun scripts/release/compile-executable.ts --entry <file> --outfile <file> [--target <bun-target>]
 *                                             [--define KEY=VALUE ...]
 *
 * TWO REWRITES OF PLAYWRIGHT'S BUNDLE make the compiled browser worker work at all:
 *
 * 1. Its CDP WebSocket. Playwright's bundled copy of the `ws` client upgrades the connection through
 *    `node:http`, and under Bun 1.3 that upgrade never completes: the 101 reply arrives as an ordinary
 *    response and the handshake times out after ten seconds, so a compiled worker never attaches to
 *    the browser the daemon launched (measured against Chrome 154; Playwright logs `<ws unexpected
 *    response> … 101 WebSocket Protocol Handshake`). Bun's own `ws` module — which Bun substitutes for
 *    the npm package — speaks the same API over Bun's native WebSocket and completes the handshake.
 * 2. Its own `package.json` and `browsers.json`. Playwright reads them with a COMPUTED path
 *    (`join(packageRoot, "package.json")`), which the bundler cannot see, so the build bakes in the
 *    absolute path of the build machine's `node_modules`. The binary then works only where it was
 *    built — measured: a Nix-built worker fails at startup with
 *    `Cannot find module '/build/source/node_modules/…'`. The literal `require("../package.json")`
 *    (relative to `lib/`, where the bundle lives) is resolved by the bundler and embedded.
 *
 * Each rewrite is pinned to the text Playwright declares it with, and the build FAILS when a required
 * anchor is missing: a Playwright upgrade that moves one must be noticed here, not shipped as a worker
 * that silently fails on every machine but the one that built it.
 *
 * AND ONE NATIVE ADDON IS EMBEDDED PER TARGET: the WebRTC engine (`node-datachannel`, see
 * docs/relay-protocol.md §16). Its loader picks `@node-datachannel/<platform>` with a COMPUTED
 * `require`, which the bundler cannot follow, so a compiled `fyd` would look for a package that is
 * not beside it and report the engine unavailable on every machine. The loader module is replaced by
 * one that imports the TARGET's prebuilt `.node` as an embedded file and loads it from there — the
 * target's, not the build machine's, because a release cross-compiles three platforms on one Linux
 * runner. A cross-compile therefore needs every target's prebuild installed (`compile.sh` installs
 * them), and a build for a target with no mapping, or with its prebuild missing, FAILS rather than
 * shipping a daemon whose peer-to-peer carrier can never start.
 *
 * AND EVERY WORKER THREAD'S PROGRAM IS EMBEDDED BESIDE THE ENTRY. A `bin/<name>.worker.ts` next to the
 * entry is compiled in as an extra entrypoint, so the binary holds it as `<root>/<name>.worker.js` —
 * the path `packages/daemon/src/adapters/runtime/bundled-worker.ts` resolves it by. Without this, a
 * `new Worker` in a compiled binary names a file the binary does not have and never starts: the PDF
 * unlock shipped that way. `fyd --check` starts each worker, and the release smoke asserts it.
 */
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import type { BunPlugin } from 'bun';

interface Rewrite {
  readonly file: RegExp;
  readonly from: RegExp;
  readonly to: string;
}

const PLAYWRIGHT_LIB = /playwright-core[\\/]lib[\\/][^\\/]+\.js$/;
const REWRITES: readonly Rewrite[] = [
  {
    file: /playwright-core[\\/]lib[\\/]utilsBundle\.js$/,
    from: /var ws = wrapper_default;/g,
    to: 'var ws = require("ws");',
  },
  {
    file: /playwright-core[\\/]lib[\\/]coreBundle\.js$/,
    from: /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g,
    to: 'require("../$1.json")',
  },
];

/** Playwright's optional BiDi and Electron back ends: never used to drive Chrome over CDP, and absent
 * from the install, so they stay unresolved requires that are only reached if someone asks for them. */
const UNUSED_OPTIONAL_MODULES = ['chromium-bidi/*', 'electron'];

const playwrightPortable: BunPlugin = {
  name: 'playwright-portable',
  setup(build) {
    build.onLoad({ filter: PLAYWRIGHT_LIB }, async args => {
      let source = await Bun.file(args.path).text();
      for (const rewrite of REWRITES.filter(each => each.file.test(args.path))) {
        const rewritten = source.replace(rewrite.from, rewrite.to);
        if (rewritten === source) {
          throw new Error(
            `${args.path} no longer contains ${rewrite.from}; re-measure the compiled browser worker and update scripts/release/compile-executable.ts`,
          );
        }
        source = rewritten;
      }
      return { contents: source, loader: 'js' };
    });
  },
};

const NODE_DATACHANNEL_LOADER = /node-datachannel[\\/]dist[\\/]esm[\\/]lib[\\/]node-datachannel\.mjs$/;
/** The anchor the replaced loader is pinned to: an upgrade that stops computing its path is noticed here. */
const NODE_DATACHANNEL_ANCHOR = 'function loadBinding()';

/**
 * The `@node-datachannel/*` prebuild for a Bun compile target, or for this machine when there is no
 * target (the Nix build compiles natively). glibc for Linux: every Linux target this repository ships
 * is a glibc one, and a musl target is mapped explicitly rather than guessed.
 */
function nodeDataChannelPrebuild(target: string | undefined): string {
  const host = `bun-${process.platform}-${process.arch}`;
  const named = (target ?? host).replace(/-(baseline|modern)$/u, '');
  const prebuilds: Record<string, string> = {
    'bun-linux-x64': 'linux-x64-gnu',
    'bun-linux-arm64': 'linux-arm64-gnu',
    'bun-linux-x64-musl': 'linux-x64-musl',
    'bun-linux-arm64-musl': 'linux-arm64-musl',
    'bun-darwin-arm64': 'darwin-arm64',
    'bun-darwin-x64': 'darwin-x64',
  };
  const prebuild = prebuilds[named];
  if (prebuild === undefined) {
    throw new Error(
      `no node-datachannel prebuild is mapped for ${target ?? host}; add it to scripts/release/compile-executable.ts`,
    );
  }
  return `@node-datachannel/${prebuild}/node_datachannel.node`;
}

const nodeDataChannelEmbedded = (target: string | undefined): BunPlugin => ({
  name: 'node-datachannel-embedded',
  setup(build) {
    build.onLoad({ filter: NODE_DATACHANNEL_LOADER }, async args => {
      const source = await Bun.file(args.path).text();
      if (!source.includes(NODE_DATACHANNEL_ANCHOR)) {
        throw new Error(
          `${args.path} no longer contains ${NODE_DATACHANNEL_ANCHOR}; re-measure the compiled WebRTC engine and update scripts/release/compile-executable.ts`,
        );
      }
      const specifier = nodeDataChannelPrebuild(target);
      let addon: string;
      try {
        addon = createRequire(args.path).resolve(specifier);
      } catch {
        throw new Error(
          `${specifier} is not installed beside ${dirname(args.path)}; a cross-compile needs every target's prebuild (scripts/release/compile.sh installs them)`,
        );
      }
      return {
        contents: [
          `import addon from ${JSON.stringify(addon)} with { type: 'file' };`,
          `import { createRequire } from 'node:module';`,
          `const nodeDataChannel = createRequire(import.meta.url)(addon);`,
          `export { nodeDataChannel as default };`,
        ].join('\n'),
        loader: 'js',
      };
    });
  },
});

interface Options {
  readonly entry: string;
  readonly outfile: string;
  readonly target?: string;
  readonly define: Record<string, string>;
}

function parse(argv: readonly string[]): Options {
  let entry: string | undefined;
  let outfile: string | undefined;
  let target: string | undefined;
  const define: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--entry') entry = value;
    else if (flag === '--outfile') outfile = value;
    else if (flag === '--target') target = value;
    else if (flag === '--define') {
      const split = value.indexOf('=');
      if (split <= 0) throw new Error(`--define expects KEY=VALUE, got ${value}`);
      define[value.slice(0, split)] = value.slice(split + 1);
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (entry === undefined || outfile === undefined) throw new Error('--entry and --outfile are required');
  return { entry, outfile, ...(target === undefined ? {} : { target }), define };
}

const options = parse(Bun.argv.slice(2));
/**
 * The entry spelled the way `join` spells the workers beside it. Bun 1.4 lays a compiled binary's
 * entrypoints out by their spelling: `./packages/daemon/bin/fyd.ts` (compile.sh's) beside
 * `packages/daemon/bin/session.worker.ts` embeds the worker at `<root>/packages/daemon/bin/`, not at
 * `<root>/session.worker.js`, so no worker starts (`ModuleNotFound resolving
 * "/$bunfs/root/session.worker.js"`). Bun 1.3 normalised them itself.
 */
const entry = normalize(options.entry);
/** Every worker program beside the entry, in a stable order. */
const workers = [...new Bun.Glob('*.worker.ts').scanSync({ cwd: dirname(entry) })]
  .sort()
  .map(name => join(dirname(entry), name));
const result = await Bun.build({
  entrypoints: [entry, ...workers],
  compile: {
    outfile: options.outfile,
    ...(options.target === undefined ? {} : { target: options.target as Bun.Build.CompileTarget }),
  },
  define: options.define,
  external: UNUSED_OPTIONAL_MODULES,
  plugins: [playwrightPortable, nodeDataChannelEmbedded(options.target)],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(
  `✅ compiled ${options.entry}${workers.length === 0 ? '' : ` (+ ${workers.join(', ')})`} -> ${options.outfile}`,
);
