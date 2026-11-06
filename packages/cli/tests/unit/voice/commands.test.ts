import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerVoiceCommands } from '../../../src/lib/voice/commands';
import { VoiceController } from '../../../src/lib/voice/controller';
import { CapturingOutput, FakeGateway, InstantClock, progress, view } from './fixtures';

async function run(argv: string[]) {
  const gateway = new FakeGateway();
  gateway.started = view({ install: progress({ status: 'succeeded', phase: 'finishing' }) });
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerVoiceCommands(program, new VoiceController(gateway, out, new InstantClock(), 'fy'));
  await program.parseAsync(['node', 'fy', ...argv]);
  return { gateway, out };
}

describe('fy voice', () => {
  it('should show the status when no verb is given', async () => {
    const { gateway } = await run(['voice']);
    should(gateway.calls).deepEqual(['status']);
  });

  it.each([
    [['voice', 'status'], ['status']],
    [['voice', 'install', 'parakeet-tdt-0.6b-v3-int8'], ['install:parakeet-tdt-0.6b-v3-int8']],
    [['voice', 'cancel'], ['cancel']],
    [['voice', 'remove', 'whisper-turbo'], ['remove:whisper-turbo']],
    [['voice', 'use', 'whisper-turbo'], ['use:whisper-turbo']],
  ])('should map %j to the gateway call %j', async (argv, expected) => {
    const { gateway } = await run(argv);
    should(gateway.calls[0]).equal(expected[0]);
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    const { out } = await run(['voice', '--json', 'status']);
    should(JSON.parse(out.reports[0] ?? '{}').target).equal('linux-x64');
  });

  it('should refuse install, remove and use without a model id', async () => {
    for (const verb of ['install', 'remove', 'use']) {
      let failure: unknown;
      await run(['voice', verb]).catch(error => {
        failure = error;
      });
      should(String((failure as { message?: string } | undefined)?.message)).match(/missing required argument/u);
    }
  });
});
