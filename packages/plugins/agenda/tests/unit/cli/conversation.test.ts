import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaController } from '../../../cli/lib/controller.ts';
import { CapturingOutput, humanItem, RecordingAgendaGateway, SESSION, snapshot } from './fixtures.ts';

const board = snapshot([humanItem('A1', 'which region'), humanItem('A2', 'which region again')]);

function build() {
  const gateway = new RecordingAgendaGateway(board);
  const out = new CapturingOutput();
  return { gateway, out, controller: new AgendaController(gateway, out, SESSION) };
}

describe('agenda log', () => {
  it('should send the ferret’s words and which way to rest, never the owner’s', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.log('!A1', { reply: ' use eu-west ', message: ' m1 ' });
    await controller.log('A1', { rest: 'checking quota' });

    // Assert
    should(gateway.applied.map(each => each.request)).deepEqual([
      { action: 'log', id: 'A1', mode: 'reply', text: 'use eu-west', messageId: 'm1' },
      { action: 'log', id: 'A1', mode: 'rest', text: 'checking quota' },
    ]);
  });

  it('should refuse both, or neither, of --reply and --rest', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act + Assert
    await should(controller.log('A1', {})).be.rejectedWith(/say one thing/u);
    await should(controller.log('A1', { reply: 'a', rest: 'b' })).be.rejectedWith(/say one thing/u);
    should(gateway.applied).have.length(0);
  });
});

describe('agenda merge', () => {
  it('should merge the second item into the first', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.merge('!A2', '!A1', {});

    // Assert
    should(gateway.applied.map(each => each.request)).deepEqual([{ action: 'merge', id: 'A2', from: 'A1' }]);
  });
});

describe('agenda split', () => {
  it('sends the new brief and moved cards, and reports the new item', async () => {
    const after = snapshot([...board.items, humanItem('A3', 'Which cache?')]);
    const gateway = new RecordingAgendaGateway(board, after);
    const out = new CapturingOutput();
    const controller = new AgendaController(gateway, out, SESSION);
    await controller.split('!A1', ['Which cache?'], {
      title: 'Cache',
      premise: ['A cache is needed.'],
      context: ['It has its own rollout.'],
      moveCards: ' F12, F13, ',
    });
    should(gateway.applied[0]?.request).containDeep({
      action: 'split',
      id: 'A1',
      item: { subject: 'Which cache?', title: 'Cache' },
      moveCards: [{ id: 'F12' }, { id: 'F13' }],
    });
    should(out.messages.join('\n')).containEql('!A3');
  });

  it('refuses invalid moved-card references before writing', async () => {
    const { controller, gateway } = build();
    await should(
      controller.split('A1', ['Which cache?'], {
        title: 'Cache',
        premise: ['A cache is needed.'],
        context: ['It has its own rollout.'],
        moveCards: 'not-a-card',
      }),
    ).be.rejectedWith(/--move-cards/u);
    should(gateway.applied).have.length(0);
  });
});
