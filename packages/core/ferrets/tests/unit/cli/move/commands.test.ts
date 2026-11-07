import { describe, it } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import { moveVerb } from '../../../../cli/lib/move/commands.ts';
import { MoveController } from '../../../../cli/lib/move/controller.ts';
import { moveHarness } from './fixtures.ts';

/** What the fy shell hands the verb after `fy ferret move` (see packages/cli/src/lib/argv.ts). */
function run(args: string[], options: VerbInvocation['options']) {
  const { gateway, io, presenter } = moveHarness();
  const handler = moveVerb(new MoveController(gateway, presenter));
  return { parsed: handler({ args, options }), gateway, io };
}

describe('fy ferret move verb', () => {
  it('should map every daemon-supported move option', async () => {
    // Arrange + Act
    const { parsed, gateway, io } = run(['Fable'], {
      agent: 'codex-secondary',
      model: 'gpt-5.6-sol',
      'allow-context-downgrade': true,
      conversation: 'fresh',
      'request-id': 'move-1',
      json: true,
    });
    should(await parsed).equal(0);

    // Assert
    should(gateway.calls[0]).deepEqual({
      id: 'Fable',
      agent: 'codex-secondary',
      model: 'gpt-5.6-sol',
      allowContextDowngrade: true,
      requestId: 'move-1',
      forceInflight: false,
      conversation: 'fresh',
    });
    should(JSON.parse(io.out[0] ?? '')).have.property('config');
  });

  it('should require the target account', async () => {
    // Arrange + Act + Assert
    await should(run(['Fable'], {}).parsed).be.rejected();
  });

  it('should take -a as --agent, as today', async () => {
    const { parsed, gateway } = run(['Fable'], { a: 'codex-secondary' });
    await parsed;
    should(gateway.calls[0]).have.property('agent', 'codex-secondary');
  });

  it('should pass an explicit force past the in-flight check, and never force by default', async () => {
    // Arrange + Act
    const forced = run(['Fable'], { agent: 'codex-secondary', 'force-inflight': true });
    await forced.parsed;
    const plain = run(['Fable'], { agent: 'codex-secondary' });
    await plain.parsed;

    // Assert
    should(forced.gateway.calls[0]).have.property('forceInflight', true);
    should(plain.gateway.calls[0]).have.property('forceInflight', false);
  });

  it('should send --convert as the convert conversation, and --preview as a read that moves nothing', async () => {
    // Arrange + Act
    const moved = run(['Fable'], { agent: 'codex-secondary', convert: true });
    await moved.parsed;
    const previewed = run(['Fable'], { agent: 'codex-secondary', convert: true, preview: true });
    await previewed.parsed;

    // Assert
    should(moved.gateway.calls).deepEqual([
      {
        id: 'Fable',
        agent: 'codex-secondary',
        allowContextDowngrade: false,
        forceInflight: false,
        conversation: 'convert',
      },
    ]);
    should(previewed.gateway.calls).be.empty();
    should(previewed.gateway.previews).deepEqual([{ id: 'Fable', agent: 'codex-secondary' }]);
    should(previewed.io.out.join('\n')).containEql('12 of 40 turns will move');
  });
});
