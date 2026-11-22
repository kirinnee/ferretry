import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durianBuild } from '../../app/vite-durian.ts';

/**
 * A SCENE BUILT THE WAY THE APP IS BUILT (r12 H8 fix): by the app shell's own Vite, in production mode, with the Durian plugin the
 * shell registers. The Bun-bundled scenes the other visual tests use are the right tool for a picture, and the wrong one for a
 * claim about what SHIPS: Bun reads Durian's own scene compiler and chart reader where the shell's build redirects them
 * (`app/vite-durian.ts`), orders chunks its own way, and takes no stylesheet from a `sideEffects` list. This builds the scene
 * with the shell's Vite, so the chunks, their order and the stylesheet are the ones a page is given.
 *
 * It is loaded from the shell's install rather than declared here, because Conversation ships no build tool of its own.
 */

interface Chunk {
  readonly type: 'chunk';
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
  readonly name: string;
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

/**
 * One production build, in memory. `bun test` runs with `NODE_ENV=test`, and Vite takes the environment from it whatever `mode`
 * says (React's development bundle would be built): the variable is `production` for the build and put back after.
 */
const productionBuild = async (options: object): Promise<readonly Output[]> => {
  const { build } = await viteOfTheShell();
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await build({ configFile: false, logLevel: 'silent', mode: 'production', ...options });
    return (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
};

export interface ViteScene {
  /** Every output file by its name under `/` (`assets/x.js`), text or bytes. */
  readonly files: ReadonlyMap<string, string | Blob>;
  /** The stylesheets the scene's build made, by file name: Durian's among them, through the same import the app makes. */
  readonly styles: readonly string[];
  /** `first.js` (the app's zod setting, a script of its own) and `scene.js`, in the order a page loads them. */
  readonly scripts: readonly string[];
}

const conversation = resolve(import.meta.dir, '../..');
const zodJitless = resolve(conversation, '../../app/src/security/zod-jitless.ts');

/**
 * The parts scene (`hypermedia-parts-scene.tsx`) with the Conversation stylesheet import (`hypermedia-vite-scene.tsx`), built
 * with the zod setting as its own FIRST script, which is how the app's page orders it.
 */
export const buildViteScene = async (): Promise<ViteScene> => {
  const output = await productionBuild({
    root: conversation,
    plugins: [
      durianBuild.plugin,
      {
        // The package is `sideEffects`-free but for the stylesheet; this one scene file RUNS (it mounts the page), so the build is
        // told it has effects, or its bare import is dropped and the scene is an empty file.
        name: 'scene-has-effects',
        enforce: 'pre' as const,
        async resolveId(
          this: { resolve(source: string, importer?: string, options?: object): Promise<{ id: string } | null> },
          source: string,
          importer?: string,
        ) {
          if (!source.endsWith('hypermedia-parts-scene.tsx')) return null;
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          return resolved === null ? null : { ...resolved, moduleSideEffects: true };
        },
      },
    ],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      rollupOptions: {
        input: {
          first: zodJitless,
          scene: resolve(conversation, 'tests/integration/app/fixtures/hypermedia-vite-scene.tsx'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  });
  const files = new Map<string, string | Blob>();
  for (const file of output) {
    if (file.type === 'chunk') files.set(file.fileName, file.code);
    else files.set(file.fileName, typeof file.source === 'string' ? file.source : new Blob([file.source as BlobPart]));
  }
  return {
    files,
    styles: output.filter(file => file.type === 'asset' && file.fileName.endsWith('.css')).map(file => file.fileName),
    scripts: ['first.js', 'scene.js'],
  };
};
