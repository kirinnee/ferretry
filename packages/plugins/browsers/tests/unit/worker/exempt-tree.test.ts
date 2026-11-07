import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import should from 'should';

/**
 * `daemon/worker/adapters/` runs only inside the browser worker process, so the banned-globals check exempts it
 * (scripts/validate/banned-globals.ts `OUTSIDE_KERNEL_TREES`). That holds only while the daemon loads nothing from it:
 * one daemon-side import would carry an unchecked global timer or socket into the daemon, unseen.
 */
const DAEMON = fileURLToPath(new URL('../../../daemon/', import.meta.url));
const EXEMPT = join(DAEMON, 'worker', 'adapters');

/** Every module specifier a file names: static and type imports, re-exports, and dynamic `import()`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

const daemonSideModules = (): readonly string[] =>
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: DAEMON })]
    .map(path => join(DAEMON, path))
    .filter(path => !path.startsWith(EXEMPT + '/'))
    .sort();

describe('the worker adapter tree — the daemon loads nothing from it', () => {
  it('should import nothing under daemon/worker/adapters/ from any daemon-side module', () => {
    // Arrange
    const modules = daemonSideModules();

    // Act
    const reaching = modules.flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map(match => match[1] ?? '')
        .filter(specifier => specifier.startsWith('.'))
        .filter(specifier => resolve(dirname(file), specifier).startsWith(EXEMPT + '/'))
        .map(specifier => `${relative(DAEMON, file)} -> ${specifier}`),
    );

    // Assert
    should(modules.length).be.above(50);
    should(reaching).deepEqual([]);
  });

  it('should keep the page-script origin bound the daemon and the worker share in pages/wire/', async () => {
    // Act
    const wire = await import('../../../daemon/pages/wire/page-script.ts');

    // Assert
    should(wire.PAGE_SCRIPT_ORIGIN_MAX_CHARS).equal(2_048);
  });
});
