/**
 * Fixture workspaces for the planted-violation tests: a root `package.json` with the real workspace globs, and
 * packages written from small specs. Manifests and contracts import the REAL kernel by absolute path, so a fixture
 * loads without its own node_modules. Each fixture is a fresh folder under `scripts/gen/tests/.tmp/` (git-ignored).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KERNEL = join(import.meta.dir, '..', '..', '..', 'packages', 'core', 'kernel');
export const SDK = join(KERNEL, 'manifest', 'index.ts');
export const LEAF = join(KERNEL, 'contract', 'index.ts');
const TMP = join(import.meta.dir, '.tmp');

let counter = 0;

export interface FixturePackage {
  /** `packages/plugins/<id>` or `packages/core/<id>` (core when `core: true`). */
  readonly id: string;
  readonly core?: boolean;
  /** Manifest body, as TS source of the object literal's fields (after id/title/version/api/core/kinds). */
  readonly manifest?: string;
  /** Extra imports for manifest.ts. */
  readonly manifestImports?: string;
  readonly contract?: string;
  readonly testing?: string;
  readonly daemon?: string;
  readonly app?: string;
  readonly cli?: string;
  readonly kinds?: readonly string[];
  /** False for a package with no daemon/app/cli half (the Kernel's own shape): no half is exported or written. */
  readonly halves?: boolean;
  /** More files, path → source, relative to the package. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface Fixture {
  readonly root: string;
  write(rel: string, text: string): void;
  dispose(): void;
}

export const skeletonHalf = (half: 'Daemon' | 'App' | 'Cli'): string =>
  `import { skeleton${half} } from '${SDK}';\nimport manifest from '../manifest.ts';\nexport default skeleton${half}(manifest);\n`;

export function fixture(
  packages: readonly FixturePackage[],
  options: {
    readonly pending?: readonly string[];
    readonly pendingReasons?: Readonly<Record<string, readonly string[]>>;
    readonly pendingHalves?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Fixture {
  const root = join(TMP, `w${process.pid}-${++counter}`);
  rmSync(root, { recursive: true, force: true });
  const write = (rel: string, text: string): void => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['packages/*', 'packages/core/*', 'packages/plugins/*'],
    }),
  );
  // The generator reads the client binary name from the CLI's `bin` key (the two-name model), so every fixture has one.
  write('packages/cli/package.json', JSON.stringify({ name: 'fixture-cli', private: true, bin: { fx: './bin.ts' } }));
  write(
    'ports-pending.json',
    JSON.stringify({
      format: 1,
      pending: options.pending ?? [],
      ...(options.pendingReasons === undefined ? {} : { pendingReasons: options.pendingReasons }),
      ...(options.pendingHalves === undefined ? {} : { pendingHalves: options.pendingHalves }),
    }),
  );
  for (const pkg of packages) {
    const dir = pkg.core === true ? `packages/core/${pkg.id}` : `packages/plugins/${pkg.id}`;
    const halves = pkg.halves !== false;
    write(
      `${dir}/package.json`,
      JSON.stringify({
        name: pkg.core === true ? `@ferretry/core-${pkg.id}` : `@ferretry/plugin-${pkg.id}`,
        type: 'module',
        ferretry: { id: pkg.id, manifest: './manifest.ts' },
        exports: {
          './contract': './contract/index.ts',
          './contract/testing': './contract/testing/index.ts',
          './manifest': './manifest.ts',
          ...(halves ? { './daemon': './daemon/index.ts', './app': './app/index.ts', './cli': './cli/index.ts' } : {}),
        },
      }),
    );
    const title = pkg.id.charAt(0).toUpperCase() + pkg.id.slice(1);
    write(
      `${dir}/manifest.ts`,
      `import { definePlugin } from '${SDK}';\n${pkg.manifestImports ?? ''}\nexport default definePlugin({\n  id: '${pkg.id}',\n  title: '${title}',\n  version: '5.0.0',\n  api: 5,\n  core: ${pkg.core === true},\n  kinds: ${JSON.stringify(pkg.kinds ?? [])},\n${pkg.manifest ?? ''}\n});\n`,
    );
    write(`${dir}/contract/index.ts`, pkg.contract ?? 'export {};\n');
    write(`${dir}/contract/testing/index.ts`, pkg.testing ?? 'export {};\n');
    if (halves) {
      write(`${dir}/daemon/index.ts`, pkg.daemon ?? skeletonHalf('Daemon'));
      write(`${dir}/app/index.ts`, pkg.app ?? skeletonHalf('App'));
      write(`${dir}/cli/index.ts`, pkg.cli ?? skeletonHalf('Cli'));
    }
    for (const [rel, text] of Object.entries(pkg.files ?? {})) write(`${dir}/${rel}`, text);
  }
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** zod, resolved from the real kernel (fixtures have no node_modules). */
export const ZOD = Bun.resolveSync('zod', KERNEL);

/** A route declaration a fixture manifest can splice in. */
export const routeDecl = (key: string, extra = ''): string =>
  `route('${key}', { minimum: 'authenticated', caller: 'any', audit: { skip: 'fixture' }, guard: { none: 'fixture' }${extra} })`;
