import { spawn } from 'node:child_process';
import { describe, it } from 'bun:test';
import should from 'should';

const CHILD = new URL('../../../support/cli/job-attach-child.ts', import.meta.url).pathname;

/** Runs a real attachment against a daemon that stops answering, TERMs it, and times how long it takes to end. */
async function termed(verb: 'attach' | 'wait') {
  const child = spawn(process.execPath, [CHILD, verb], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => (errors += String(chunk)));
  const ended = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => String(chunk).includes('ready') && resolve());
    child.once('exit', () => reject(new Error(`ended before it was ready: ${errors}`)));
  });
  const sent = Date.now();
  child.kill('SIGTERM');
  const timeout = new Promise<'alive'>(resolve => setTimeout(() => resolve('alive'), 3_000));
  const result = await Promise.race([ended, timeout]);
  if (result === 'alive') child.kill('SIGKILL');
  return { code: result, ms: Date.now() - sent, errors };
}

describe('fy job: the signal deadline (a real process, a daemon that has stopped answering)', () => {
  for (const verb of ['attach', 'wait'] as const)
    it(`should exit 75 well inside the second Claude gives a TERM, for ${verb}`, async () => {
      // Act
      const result = await termed(verb);

      // Assert
      should(result.errors).containEql('detached from job');
      should(result.code).equal(75);
      should(result.ms).be.below(1_000);
    });
});
