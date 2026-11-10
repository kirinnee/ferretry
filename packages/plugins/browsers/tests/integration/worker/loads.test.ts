import { describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import should from 'should';
import { NODE_WORKER_FLAGS } from '../../../daemon/worker/program.ts';

/**
 * The browser worker runs in source mode as its own process under Node (lead decision, port-browsers r1; the daemon
 * half starts it with `NODE_WORKER_FLAGS`, because the kernel and Vault contracts it imports use TypeScript parameter
 * properties, which Node's default type stripping refuses). Starting it with no endpoint needs no browser: it must
 * reach its own first check and say so, not die while loading.
 */
describe('browser worker — loads under node', () => {
  it('should reach its endpoint check, with no browser, instead of crashing on load', () => {
    const worker = fileURLToPath(new URL('../../../daemon/worker/main.ts', import.meta.url));

    const run = spawnSync('node', [...NODE_WORKER_FLAGS, worker], { encoding: 'utf8', timeout: 30_000 });

    should(run.stdout.trim()).equal('{"type":"fatal","error":"a CDP endpoint is required"}');
    should(run.status).equal(2);
  });
});
