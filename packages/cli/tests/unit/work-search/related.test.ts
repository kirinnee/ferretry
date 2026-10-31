import { describe, it } from 'bun:test';
import should from 'should';
import { listedMatches, RELATED_CHECK_UNAVAILABLE, RelatedCheck } from '../../../src/lib/work-search/related';
import { agendaHit, CapturingOutput, FakeWorkSearchGateway, LIZZETTE, response, taskHit } from './fixtures';

const build = () => {
  const gateway = new FakeWorkSearchGateway();
  const output = new CapturingOutput();
  return { gateway, output, check: new RelatedCheck(gateway, output, 'fy') };
};

const guard = (check: RelatedCheck, options: { as?: string; json?: boolean } = {}) =>
  check.guard('task', ' Work search ', 'make it fast', {
    as: options.as,
    json: options.json,
    choices: ['fy task create … --new'],
  });

const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  const failure = await work().then(
    () => undefined,
    (error: unknown) => error,
  );
  should((failure as Error).name).equal('CliInputError');
  return (failure as Error).message;
};

describe('listedMatches', () => {
  it('should list strong matches first and at most three weak ones', () => {
    // Arrange
    const weak = (id: string) => ({ strength: 'weak' as const, hit: taskHit({ id }) });

    // Act
    const listed = listedMatches({
      matches: [weak('F1'), weak('F2'), { strength: 'strong', hit: taskHit({ id: 'F9' }) }, weak('F3'), weak('F4')],
    });

    // Assert
    should(listed.map(match => `${match.strength}:${match.hit.id}`)).eql([
      'strong:F9',
      'weak:F1',
      'weak:F2',
      'weak:F3',
    ]);
  });
});

describe('RelatedCheck.guard', () => {
  it('should ask the daemon with the trimmed title and ask, and let a create with no strong match go', async () => {
    // Arrange
    const { check, gateway, output } = build();
    gateway.relatedAnswer = { matches: [{ strength: 'weak', hit: taskHit() }] };

    // Act
    await guard(check, { as: 'sess-a' });

    // Assert
    should(gateway.relatedCalls).eql([
      { request: { kind: 'task', title: 'Work search', ask: 'make it fast' }, as: 'sess-a' },
    ]);
    should(output.lines).eql([]);
    should(output.notices).eql([]);
  });

  it('should refuse a strong match, strong first, then weak, with the ways out', async () => {
    // Arrange
    const { check, gateway } = build();
    gateway.relatedAnswer = {
      matches: [
        { strength: 'weak', hit: taskHit({ id: 'F8', title: 'Faint echo' }) },
        { strength: 'strong', hit: agendaHit() },
      ],
    };

    // Act
    const message = await refusal(() => guard(check));

    // Assert
    should(message).startWith('Related work already exists, and nothing was created.');
    should(message.indexOf('Strong matches:')).be.below(message.indexOf('Weaker matches:'));
    should(message).containEql('!A3');
    should(message).containEql('&F8');
    should(message).containEql('Instead:\n  fy task create … --new');
  });

  it('should print the matches as JSON, then refuse, when asked for JSON', async () => {
    // Arrange
    const { check, gateway, output } = build();
    gateway.relatedAnswer = { matches: [{ strength: 'strong', hit: taskHit() }] };

    // Act
    const message = await refusal(() => guard(check, { json: true }));

    // Assert
    should(JSON.parse(output.lines[0] ?? '').related[0].hit.id).equal('F303');
    should(message).match(/nothing was created/u);
  });

  it('should label a match the caller owns with the command that updates it', async () => {
    // Arrange
    const { check, gateway } = build();
    gateway.relatedAnswer = { matches: [{ strength: 'strong', hit: agendaHit() }] };

    // Act
    const message = await refusal(() => guard(check, { as: LIZZETTE }));

    // Assert
    should(message).containEql('yours — fy agenda edit A3');
  });

  it('should go on, with one dim line, when the daemon has no related check', async () => {
    // Arrange
    const { check, gateway, output } = build();
    gateway.relatedAnswer = undefined;

    // Act
    await guard(check);

    // Assert
    should(output.notices).eql([RELATED_CHECK_UNAVAILABLE]);
  });

  it('should go on, saying why, when the check itself fails', async () => {
    // Arrange
    const { check, gateway, output } = build();
    gateway.relatedError = new Error('socket closed');

    // Act
    await guard(check);

    // Assert
    should(output.notices).eql(['related check skipped: socket closed']);
  });
});

describe('RelatedCheck.agendaOwner', () => {
  it('should name the ledger an agenda id is in, by callsign', async () => {
    // Arrange
    const { check, gateway } = build();
    gateway.answer = response([agendaHit({ id: 'A30' }), agendaHit()]);

    // Act
    const owner = await check.agendaOwner('A3', undefined);

    // Assert
    should(owner).eql({ sessionId: LIZZETTE, callsign: 'lizzette' });
    should(gateway.searches[0]?.query).containEql({ q: 'A3', kind: 'agenda' });
  });

  it('should answer nothing when no item has that id', async () => {
    // Arrange
    const { check } = build();

    // Act + Assert
    should(await check.agendaOwner('A3', undefined)).be.undefined();
  });
});
