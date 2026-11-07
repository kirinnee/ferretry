import { describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import should from 'should';

/**
 * The browser worker runs in source mode under node's type stripping, which refuses TypeScript parameter
 * properties, enums and namespaces anywhere in what it imports. Starting it with no endpoint needs no
 * browser: it must reach its own first check and say so, not die while loading.
 */
describe('browser worker — loads under node type stripping', () => {
  it('should reach its endpoint check, with no browser, instead of crashing on load', () => {
    const worker = fileURLToPath(new URL('../../../../bin/browser-worker.ts', import.meta.url));

    const run = spawnSync('node', [worker], { encoding: 'utf8', timeout: 30_000 });

    should(run.stdout.trim()).equal('{"type":"fatal","error":"a CDP endpoint is required"}');
  });
});
