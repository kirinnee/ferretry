import { describe, it } from 'bun:test';
import type { AgendaActionRequest, AgendaId, AgendaItem, AgendaSnapshot } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  agendaSnapshot,
  applyAgendaCommand,
  emptyAgendaLedger,
  type RaiseAgendaRequest,
} from '../../../../daemon/src/lib/agenda/state-machine.ts';
import { points } from '../../../src/lib/agenda/candidates';
import { registerAgendaCommands } from '../../../src/lib/agenda/commands';
import { AgendaController } from '../../../src/lib/agenda/controller';
import type { IAgendaGateway } from '../../../src/lib/agenda/ports';
import { CapturingOutput, SESSION } from './fixtures';

/**
 * The join the listing prints is applied to the REAL agenda state machine (the one the daemon runs), through the real
 * Commander registration and the real controller: whatever the printed `fy agenda edit` does to an agenda there is what
 * the owner would see, so a join that drops part of the new ask fails here.
 */
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const HUMAN: AgendaActor = { kind: 'human' };

class LedgerGateway implements IAgendaGateway {
  ledger: AgendaLedger = emptyAgendaLedger(SESSION, '2026-07-31T09:00:00.000Z');
  #tick = 0;

  readonly #at = (): string => {
    this.#tick += 1;
    return new Date(Date.UTC(2026, 6, 31, 9, 0, this.#tick)).toISOString();
  };

  snapshot(): Promise<AgendaSnapshot> {
    return Promise.resolve(agendaSnapshot(this.ledger));
  }

  apply(_sessionId: string, request: AgendaActionRequest): Promise<AgendaSnapshot> {
    const at = this.#at();
    const command =
      request.action === 'add'
        ? (() => {
            const { action: _action, surface: _surface, ...raise } = request;
            return { action: 'raise' as const, actor: AGENT, request: raise as RaiseAgendaRequest, at };
          })()
        : request.action === 'edit'
          ? (() => {
              const { action: _action, id, now: _now, back, ...patch } = request;
              return { action: 'edit' as const, actor: AGENT, id, patch, back: back === true, at };
            })()
          : undefined;
    if (command === undefined) throw new Error(`the test ledger does not apply ${request.action}`);
    const result = applyAgendaCommand(this.ledger, command);
    if (!result.ok) return Promise.reject(new Error(result.error.message));
    this.ledger = result.ledger;
    return Promise.resolve(result.snapshot);
  }

  ownerReplies(id: AgendaId): void {
    const result = applyAgendaCommand(this.ledger, { action: 'reply', actor: HUMAN, id, at: this.#at() });
    if (!result.ok) throw new Error(result.error.message);
    this.ledger = result.ledger;
  }

  sendReplies(): Promise<AgendaSnapshot> {
    return this.snapshot();
  }

  clearAgents(): Promise<{ cleared: number; sessions: number }> {
    return Promise.resolve({ cleared: 0, sessions: 0 });
  }

  features(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }

  item(id: AgendaId): AgendaItem {
    const found = this.ledger.entries.find(entry => entry.lifecycle === 'active' && entry.item.id === id);
    if (found === undefined) throw new Error(`no active ${id}`);
    return found.item;
  }
}

/** One shell line as the words the shell would hand `fy`: single quotes only, as the listing prints them. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === '\\' && line.charAt(at + 1) !== '') {
      at += 1;
      word += line.charAt(at);
    } else if (char === ' ') {
      if (started || word !== '') words.push(word);
      word = '';
      started = false;
    } else word += char;
  }
  if (started || word !== '') words.push(word);
  return words;
}

function world() {
  const gateway = new LedgerGateway();
  const out = new CapturingOutput();
  const controller = new AgendaController(gateway, out, SESSION);
  const run = async (argv: readonly string[]) => {
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerAgendaCommands(program, controller);
    await program.parseAsync(['node', ...argv]);
  };
  return { gateway, out, run };
}

const brief = (premise: string, context: string): string[] => ['--premise', premise, '--context', context];

describe('the suggested join, applied to the real agenda state machine', () => {
  it('should add a plain-words ask to an info agenda and lose nothing of either', async () => {
    // Arrange
    const { gateway, run } = world();
    await run([
      'fy',
      'agenda',
      'add',
      'Deploy approved',
      '--title',
      'Deploy',
      '--kind',
      'info',
      ...brief('The deploy is approved.', 'It goes out at noon.'),
    ]);
    const before = gateway.item('A1');

    // Act — the add is refused with the join; the join is run as printed.
    const refused = await run([
      'fy',
      'agenda',
      'add',
      'Watch the dashboards',
      '--title',
      'Dashboards',
      '--kind',
      'info',
      ...brief('The dashboards are noisy.', 'Alerts fire after a deploy.'),
    ]).catch((error: unknown) => (error as Error).message);
    const command = String(refused)
      .split('\n')
      .find(line => line.trim().startsWith('fy agenda edit A1'));
    await run(['fy', ...shellWords(command ?? '').slice(1)]);

    // Assert
    const after = gateway.item('A1');
    should(gateway.ledger.entries).have.length(1);
    should(after.subject).equal(before.subject);
    should(after.kind).equal('info');
    should(points(after.stillOpen)).eql(['Watch the dashboards']);
    should(points(after.premise)).eql(['The deploy is approved.', 'The dashboards are noisy.']);
    should(points(after.context)).eql(['It goes out at noon.', 'Alerts fire after a deploy.']);
  });

  it('should not print an edit for a choice with options, blocking and a deadline; --new keeps both agendas whole', async () => {
    // Arrange
    const { gateway, run } = world();
    await run([
      'fy',
      'agenda',
      'add',
      'Deploy approved',
      '--title',
      'Deploy',
      '--kind',
      'info',
      ...brief('The deploy is approved.', 'It goes out at noon.'),
    ]);
    const before = gateway.item('A1');
    const choice = [
      'fy',
      'agenda',
      'add',
      'Choose the deployment region',
      '--title',
      'Region',
      '-o',
      'EU',
      '-o',
      'US',
      '--blocking',
      '--by',
      '2026-08-01T09:00:00Z',
      ...brief('The deploy needs a region.', 'EU is cheaper, US is nearer.'),
    ];

    // Act
    const refused = String(await run(choice).catch((error: unknown) => (error as Error).message));
    const stillOne = gateway.ledger.entries.length;
    await run([...choice, '--new', 'it needs its own answer; closest is !A1']);

    // Assert — nothing was merged, so nothing was lost; the new agenda carries every part of the ask.
    should(refused).containEql('options to choose from');
    should(refused).containEql('blocking the ferret now');
    should(refused).containEql('a deadline');
    should(refused).not.containEql('agenda edit A1');
    should(refused).containEql('--new "<why none fits; closest is !A1>"');
    should(stillOne).equal(1);
    should(gateway.item('A1')).eql(before);
    const region = gateway.item('A2');
    should(region.ask).eql({
      kind: 'multiple-choice',
      options: [{ label: 'EU' }, { label: 'US' }],
    });
    should(region.blockingNow).be.true();
    should(region.neededBy).equal('2026-08-01T09:00:00.000Z');
    should(points(region.premise)).eql(['The deploy needs a region.']);
  });

  it('should bring a replied agenda back with the old ask kept in what is still open', async () => {
    // Arrange
    const { gateway, run } = world();
    await run([
      'fy',
      'agenda',
      'add',
      'Pick the relay size',
      '--title',
      'Relay',
      '--still-open',
      'Which cache size',
      ...brief('The relay is going live.', 'Two sizes are near.'),
    ]);
    gateway.ownerReplies('A1');
    const before = gateway.item('A1');
    should(before.parked?.reason).equal('replied');

    // Act
    const refused = String(
      await run([
        'fy',
        'agenda',
        'add',
        'Pick the relay region',
        '--title',
        'Relay region',
        ...brief('The relay needs a region.', 'EU and US are both up.'),
      ]).catch((error: unknown) => (error as Error).message),
    );
    const command = refused.split('\n').find(line => line.trim().startsWith('fy agenda edit A1'));
    should(command).containEql('--question-answer');
    await run(['fy', ...shellWords(command ?? '').slice(1)]);

    // Assert
    const after = gateway.item('A1');
    should(gateway.ledger.entries).have.length(1);
    should(after.parked).be.undefined();
    should(after.subject).equal('Pick the relay region');
    should(points(after.stillOpen)).eql(['Which cache size', 'Pick the relay size', 'Pick the relay region']);
    should(points(after.premise)).eql(['The relay is going live.', 'The relay needs a region.']);
    should(points(after.context)).eql(['Two sizes are near.', 'EU and US are both up.']);
  });

  it('should not join a todo with its own --up answer into a todo without it; --new keeps the Skip answer', async () => {
    // Arrange
    const { gateway, run } = world();
    await run([
      'fy',
      'agenda',
      'add',
      'Rotate the key',
      '--title',
      'Key',
      '--kind',
      'todo',
      ...brief('The key is old.', 'It expires soon.'),
    ]);
    const before = gateway.item('A1');
    const skippable = [
      'fy',
      'agenda',
      'add',
      'Rotate the backup key',
      '--title',
      'Backup key',
      '--kind',
      'todo',
      '--up',
      'Skip',
      '--up-why',
      'The backup is retired',
      ...brief('The backup key is old.', 'It expires soon too.'),
    ];

    // Act
    const refused = String(await run(skippable).catch((error: unknown) => (error as Error).message));
    await run([...skippable, '--new', 'it can be skipped; closest is !A1']);

    // Assert
    should(refused).containEql('answers of its own (--up)');
    should(refused).not.containEql('agenda edit A1');
    should(refused).containEql('--new "<why none fits; closest is !A1>"');
    should(gateway.item('A1')).eql(before);
    should(gateway.ledger.entries).have.length(2);
    should(
      gateway
        .item('A2')
        .answers?.some(answer => answer.label === 'Skip' && answer.description === 'The backup is retired'),
    ).be.true();
  });

  it('should still join a todo without --up into a todo that has it, which loses nothing', async () => {
    // Arrange
    const { run } = world();
    await run([
      'fy',
      'agenda',
      'add',
      'Rotate the key',
      '--title',
      'Key',
      '--kind',
      'todo',
      '--up',
      'Skip',
      ...brief('The key is old.', 'It expires soon.'),
    ]);

    // Act
    const refused = String(
      await run([
        'fy',
        'agenda',
        'add',
        'Rotate the backup key',
        '--title',
        'Backup key',
        '--kind',
        'todo',
        ...brief('The backup key is old.', 'It expires too.'),
      ]).catch((error: unknown) => (error as Error).message),
    );

    // Assert
    should(refused).containEql('agenda edit A1');
  });
});
