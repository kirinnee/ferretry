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
 */
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
const result = await Bun.build({
  entrypoints: [options.entry],
  compile: {
    outfile: options.outfile,
    ...(options.target === undefined ? {} : { target: options.target as Bun.Build.CompileTarget }),
  },
  define: options.define,
  external: UNUSED_OPTIONAL_MODULES,
  plugins: [playwrightPortable],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`✅ compiled ${options.entry} -> ${options.outfile}`);
