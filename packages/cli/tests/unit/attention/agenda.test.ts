import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { composeAddRequest, composeEditRequest } from '../../../src/lib/attention/brief';
import { registerAttentionCommands } from '../../../src/lib/attention/commands';
import { ATTENTION_DEPRECATION, AttentionController } from '../../../src/lib/attention/controller';
import { parseNeededBy } from '../../../src/lib/attention/when';
import { agentItem, CapturingOutput, humanItem, RecordingAttentionGateway, SESSION, snapshot } from './fixtures';

const NOW = new Date(2026, 9, 29, 12, 0, 0, 0).getTime();
const board = snapshot([humanItem('A1', 'approve the deploy')]);
const afterAdd = snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')]);

function run(argv: string[]) {
  const gateway = new RecordingAttentionGateway(board, afterAdd);
  const out = new CapturingOutput();
  const sent: Array<{ words: readonly string[]; options: unknown }> = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAttentionCommands(
    program,
    new AttentionController(gateway, out, SESSION, undefined, () => NOW),
    async (words, options) => {
      sent.push({ words, options });
    },
  );
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out, sent };
}

describe('agenda --by time', () => {
  it('should read a wait relative to now, with units combined', () => {
    // Act + Assert
    should(parseNeededBy('in 3h', NOW)).equal(new Date(NOW + 3 * 3_600_000).toISOString());
    should(parseNeededBy('in 90m', NOW)).equal(new Date(NOW + 90 * 60_000).toISOString());
    should(parseNeededBy('in 1d', NOW)).equal(new Date(NOW + 86_400_000).toISOString());
    should(parseNeededBy('in 1h 30m', NOW)).equal(new Date(NOW + 90 * 60_000).toISOString());
  });

  it('should read a clock time as its next occurrence', () => {
    // Act + Assert
    should(parseNeededBy('17:00', NOW)).equal(new Date(2026, 9, 29, 17, 0, 0, 0).toISOString());
    should(parseNeededBy('09:30', NOW)).equal(new Date(2026, 9, 30, 9, 30, 0, 0).toISOString());
    should(parseNeededBy('12:00', NOW)).equal(new Date(2026, 9, 30, 12, 0, 0, 0).toISOString());
  });

  it('should read an ISO time, local when it names no offset', () => {
    // Act + Assert
    should(parseNeededBy('2026-11-02T08:00:00Z', NOW)).equal('2026-11-02T08:00:00.000Z');
    should(parseNeededBy('2026-11-02T08:00:00+02:00', NOW)).equal('2026-11-02T06:00:00.000Z');
    should(parseNeededBy('2026-11-02T08:00', NOW)).equal(new Date(2026, 10, 2, 8, 0, 0, 0).toISOString());
  });

  it('should refuse anything else and say what is accepted', () => {
    // Act + Assert
    for (const bad of ['soon', 'in 0h', '25:00', 'tomorrow', '', 'in h']) {
      should(() => parseNeededBy(bad, NOW)).throw(/is not a time: use an ISO time/u);
    }
  });
});

describe('agenda fields on add and edit', () => {
  it('should carry --blocking, --will-block and the resolved time on an add', () => {
    // Act
    const request = composeAddRequest(
      ['approve the deploy'],
      { title: 'Deploy', blocking: true, willBlock: '  the 14:00 deploy ', neededBy: '2026-10-29T14:00:00.000Z' },
      {},
    );

    // Assert
    should(request).containDeep({
      blockingNow: true,
      willBlock: 'the 14:00 deploy',
      neededBy: '2026-10-29T14:00:00.000Z',
    });
  });

  it('should leave the fields off an add that names none', () => {
    // Act
    const request = composeAddRequest(['pick'], { title: 'Pick' }, {});

    // Assert
    should(request).not.have.property('blockingNow');
    should(request).not.have.property('willBlock');
    should(request).not.have.property('neededBy');
  });

  it('should set and clear the fields on an edit', () => {
    // Act
    const set = composeEditRequest(
      'A1',
      { blocking: true, willBlock: 'release', neededBy: '2026-10-29T14:00:00.000Z' },
      undefined,
    );
    const cleared = composeEditRequest('A1', { notBlocking: true, clearWillBlock: true, clearBy: true }, undefined);

    // Assert
    should(set).containDeep({ blockingNow: true, willBlock: 'release', neededBy: '2026-10-29T14:00:00.000Z' });
    should(set).not.have.property('clear');
    should(cleared).have.property('clear', ['blockingNow', 'willBlock', 'neededBy']);
  });

  it('should refuse setting and clearing the same field at once', () => {
    // Act + Assert
    should(() => composeEditRequest('A1', { blocking: true, notBlocking: true }, undefined)).throw(/contradict/u);
    should(() => composeEditRequest('A1', { willBlock: 'x', clearWillBlock: true }, undefined)).throw(/contradict/u);
    should(() => composeEditRequest('A1', { neededBy: '2026-10-29T14:00:00.000Z', clearBy: true }, undefined)).throw(
      /contradict/u,
    );
  });
});

describe('agenda command flags', () => {
  it('should read --by against the clock on add', async () => {
    // Arrange + Act
    const { parsed, gateway } = run([
      'agenda',
      'add',
      'approve the deploy',
      '--title',
      'Deploy',
      '--blocking',
      '--will-block',
      'the 14:00 deploy',
      '--by',
      'in 3h',
    ]);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).containDeep({
      action: 'add',
      blockingNow: true,
      willBlock: 'the 14:00 deploy',
      neededBy: new Date(NOW + 3 * 3_600_000).toISOString(),
    });
  });

  it('should send the clear list on edit, and refuse a --by it cannot read', async () => {
    // Arrange + Act
    const cleared = run(['agenda', 'edit', '!A1', '--not-blocking', '--clear-by']);
    await cleared.parsed;
    const bad = run(['agenda', 'edit', '!A1', '--by', 'soonish']);

    // Assert
    should(cleared.gateway.applied[0]?.request).deepEqual({
      action: 'edit',
      id: 'A1',
      clear: ['blockingNow', 'neededBy'],
    });
    await should(bad.parsed).be.rejectedWith(/is not a time/u);
    should(bad.gateway.applied).be.empty();
  });

  it('should say nothing on stderr for agenda', async () => {
    // Arrange + Act
    const { parsed, out } = run(['agenda', 'ls']);
    await parsed;

    // Assert
    should(out.diagnostics).be.empty();
  });
});

describe('deprecated attention alias', () => {
  it('should do what agenda does and say once on stderr that the name moved', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['attention', 'dismiss', 'A1', '-n', 'stale']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'dismiss', id: 'A1', note: 'stale' });
    should(out.diagnostics).deepEqual([ATTENTION_DEPRECATION]);
    should(ATTENTION_DEPRECATION).startWith('`fy attention` is now `fy agenda`');
  });

  it('should keep notify on the alias only, handed to fy notify', async () => {
    // Arrange + Act
    const viaAlias = run(['attention', 'notify', 'build is green']);
    await viaAlias.parsed;
    const viaAgenda = run(['agenda', 'notify', 'build is green']);

    // Assert
    should(viaAlias.sent).deepEqual([{ words: ['build is green'], options: {} }]);
    await should(viaAgenda.parsed).be.rejectedWith(/unknown command 'notify'/u);
  });

  it('should not list itself in the top-level help', () => {
    // Arrange
    const program = new Command().name('fy');
    registerAttentionCommands(
      program,
      new AttentionController(new RecordingAttentionGateway(board), new CapturingOutput(), SESSION),
    );

    // Act
    const help = program.helpInformation();

    // Assert
    should(help).containEql('agenda');
    should(help).not.containEql('attention');
  });
});
