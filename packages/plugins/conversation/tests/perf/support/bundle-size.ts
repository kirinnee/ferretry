import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * HOW BIG A BUNDLE IS, the way a phone is charged for it: gzip at level 9 of every file of one production Vite build, split into
 * what the page downloads before it can draw (the entry and every chunk it imports without a dynamic `import()`, plus the
 * stylesheets those chunks name) and what it fetches later, on demand (every other chunk: a chart engine, the 3D stage).
 * Sizes are in bytes of gzip; the budget test turns them into kilobytes.
 *
 * VITE IS THE APP SHELL'S, not this package's: the app is built by the shell's own Vite, so the budget measures that build
 * (the real minifier, the real chunking, the Durian plugin the shell registers), not a second bundler's idea of it. It is
 * loaded from the shell's install rather than declared here, because Conversation ships no build tool of its own.
 */
interface Chunk {
  readonly type: 'chunk';
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
  readonly imports: readonly string[];
  readonly viteMetadata?: { readonly importedCss: ReadonlySet<string> };
}
interface Asset {
  readonly type: 'asset';
  readonly fileName: string;
  readonly source: string | Uint8Array;
}
type Output = Chunk | Asset;
interface ViteBuild {
  build(options: object): Promise<{ output: readonly Output[] } | readonly { output: readonly Output[] }[]>;
}

const viteOfTheShell = async (): Promise<ViteBuild> => {
  const shell = fileURLToPath(import.meta.resolve('@ferretry/app/testing'));
  return (await import(createRequire(shell).resolve('vite'))) as ViteBuild;
};

export interface BundleSize {
  /** The entry's static graph: JavaScript and the CSS it names. */
  readonly firstLoadGz: number;
  /** Every lazy chunk together. */
  readonly lazyGz: number;
  /** Each lazy chunk by its size, biggest first (the line a failing run names). */
  readonly lazy: readonly { readonly name: string; readonly gz: number }[];
}

const gz = (content: string | Uint8Array): number => gzipSync(content, { level: 9 }).length;

export const measureBundle = async (options: {
  readonly root: string;
  readonly entry: string;
  readonly plugins: readonly object[];
}): Promise<BundleSize> => {
  const { build } = await viteOfTheShell();
  // `bun test` runs with NODE_ENV=test, and Vite takes the environment from it whatever `mode` says: React's development bundle
  // would be measured (+18 KB gzip). The size of a PRODUCTION page is asked, so the variable is production for the build.
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let result: Awaited<ReturnType<ViteBuild['build']>>;
  try {
    result = await build({
      configFile: false,
      root: options.root,
      logLevel: 'silent',
      mode: 'production',
      plugins: [...options.plugins],
      build: { write: false, minify: true, target: 'es2022', rollupOptions: { input: options.entry } },
    });
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  const chunks = output.filter((o): o is Chunk => o.type === 'chunk');
  const assets = new Map(output.filter((o): o is Asset => o.type === 'asset').map(a => [a.fileName, a]));
  const entry = chunks.find(c => c.isEntry);
  if (entry === undefined) throw new Error('the build has no entry chunk');
  const first = new Set<string>();
  const visit = (name: string): void => {
    if (first.has(name)) return;
    first.add(name);
    for (const imported of chunks.find(c => c.fileName === name)?.imports ?? []) visit(imported);
  };
  visit(entry.fileName);
  const styles = new Set<string>();
  let firstLoadGz = 0;
  const lazy: { name: string; gz: number }[] = [];
  for (const chunk of chunks) {
    if (!first.has(chunk.fileName)) {
      lazy.push({ name: chunk.fileName, gz: gz(chunk.code) });
      continue;
    }
    firstLoadGz += gz(chunk.code);
    for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
  }
  for (const name of styles) {
    const asset = assets.get(name);
    if (asset !== undefined) firstLoadGz += gz(asset.source);
  }
  lazy.sort((a, b) => b.gz - a.gz);
  return { firstLoadGz, lazyGz: lazy.reduce((sum, c) => sum + c.gz, 0), lazy };
};
