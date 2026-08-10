import { describe, it } from 'bun:test';
import should from 'should';
import {
  CodexModelCatalogError,
  CodexModelListExchange,
  parseCodexModelListPage,
} from '../../../../src/lib/session/harness/codex-app-server.ts';

/**
 * The `model/list` exchange, driven with no child at all.
 *
 * Every branch that matters here is a failure branch — a refusal, a nameless row, a page that never
 * ends — and none of them is reachable from a real Codex on a good day. Keeping the judgement out of
 * the adapter is what makes them testable at all.
 */

const page = (data: readonly unknown[], nextCursor?: string) => ({
  id: 2,
  result: { data, ...(nextCursor === undefined ? {} : { nextCursor }) },
});

const handshake = { id: 1, result: {} };

describe('the Codex model/list page parser', () => {
  it('should read a model, its label and its advertised levels', async () => {
    // Act
    const parsed = parseCodexModelListPage(
      page([
        {
          model: 'gpt-5.6-codex',
          displayName: 'GPT-5.6 Codex',
          description: 'the coding one',
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'balanced' },
            { reasoningEffort: 'high' },
          ],
          defaultReasoningEffort: 'medium',
        },
      ]),
    );

    // Assert
    should(parsed.choices).deepEqual([
      {
        value: 'gpt-5.6-codex',
        label: 'GPT-5.6 Codex',
        description: 'the coding one',
        isDefault: true,
        reasoningEfforts: [{ value: 'medium', description: 'balanced' }, { value: 'high' }],
        defaultReasoningEffort: 'medium',
      },
    ]);
    should(parsed.nextCursor).equal(undefined);
  });

  it('should take the settings value, never the catalog id', async () => {
    // `id` is catalog-internal metadata. Sending it back selects nothing, which is exactly the kind
    // of failure that looks like the picker ignoring the daemon.
    // Act
    const parsed = parseCodexModelListPage(page([{ id: 'internal-7', model: 'gpt-5.6-terra' }]));

    // Assert
    should(parsed.choices[0]?.value).equal('gpt-5.6-terra');
    should(parsed.choices[0]?.label).equal('gpt-5.6-terra');
  });

  it('should keep a lone default level as the only expressible one', async () => {
    // A provider that advertises no list but names a default still has exactly one level. Inventing
    // a scale the account never offered would let the driver aim at a row that is not there.
    // Act
    const parsed = parseCodexModelListPage(page([{ model: 'gpt-5.6-terra', defaultReasoningEffort: 'high' }]));

    // Assert
    should(parsed.choices[0]?.reasoningEfforts).deepEqual([{ value: 'high' }]);
  });

  it('should drop hidden, nameless and non-object rows without failing the page', async () => {
    // Act
    const parsed = parseCodexModelListPage(
      page([
        { model: 'kept' },
        { model: 'hidden-one', hidden: true },
        { model: '   ' },
        { displayName: 'no model at all' },
        'not an object',
        null,
      ]),
    );

    // Assert
    should(parsed.choices.map(choice => choice.value)).deepEqual(['kept']);
  });

  it('should deduplicate a level the account advertised twice', async () => {
    // Act
    const parsed = parseCodexModelListPage(
      page([
        {
          model: 'gpt-5.6-codex',
          supportedReasoningEfforts: [
            { reasoningEffort: 'high' },
            { reasoningEffort: 'high', description: 'again' },
            { description: 'nameless' },
            'not an object',
          ],
        },
      ]),
    );

    // Assert
    should(parsed.choices[0]?.reasoningEfforts).deepEqual([{ value: 'high' }]);
  });

  it('should carry the cursor that continues the catalog', async () => {
    // Act
    const parsed = parseCodexModelListPage(page([{ model: 'first' }], 'cursor-2'));

    // Assert
    should(parsed.nextCursor).equal('cursor-2');
  });

  it('should restate an app-server refusal as a catalog failure', async () => {
    // Act, Assert
    should(() => parseCodexModelListPage({ error: { message: 'not signed in' } })).throw(
      /Codex model catalog request failed: not signed in/u,
    );
  });

  it('should name the failure even when the refusal carries no message', async () => {
    // Act, Assert
    should(() => parseCodexModelListPage({ error: {} })).throw(/unknown app-server error/u);
  });

  it('should refuse a reply that is not a catalog at all', async () => {
    // Act, Assert
    should(() => parseCodexModelListPage({ result: { data: 'not an array' } })).throw(CodexModelCatalogError);
    should(() => parseCodexModelListPage({ result: { data: 'not an array' } })).throw(/invalid response/u);
    should(() => parseCodexModelListPage('a bare string')).throw(/invalid response/u);
  });
});

describe('the Codex model/list exchange', () => {
  it('should introduce itself before asking for anything', async () => {
    // Arrange
    const subject = new CodexModelListExchange();

    // Act
    const opening = subject.start('fyd', '1.2.3');

    // Assert
    should(opening).deepEqual({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'fyd', title: 'fyd', version: '1.2.3' } },
    });
  });

  it('should acknowledge the handshake and ask for the first page', async () => {
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');

    // Act
    const step = subject.receive(handshake);

    // Assert
    should(step.send).deepEqual([
      { method: 'initialized', params: {} },
      { method: 'model/list', id: 2, params: { includeHidden: false, limit: 100 } },
    ]);
    should(step.choices).equal(undefined);
    should(subject.complete).equal(false);
  });

  it('should answer with the catalog once a page arrives with no cursor', async () => {
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);

    // Act
    const step = subject.receive(page([{ model: 'gpt-5.6-codex' }]));

    // Assert
    should(step.send).deepEqual([]);
    should(step.choices?.map(choice => choice.value)).deepEqual(['gpt-5.6-codex']);
    should(subject.complete).equal(true);
  });

  it('should follow a cursor and keep the first sighting of a repeated model', async () => {
    // Order is the order the picker renders, so a later duplicate must not move a row.
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);

    // Act
    const continued = subject.receive(page([{ model: 'a' }, { model: 'b' }], 'cursor-2'));
    const finished = subject.receive({ id: 3, result: { data: [{ model: 'b' }, { model: 'c' }] } });

    // Assert
    should(continued.send).deepEqual([
      { method: 'model/list', id: 3, params: { includeHidden: false, limit: 100, cursor: 'cursor-2' } },
    ]);
    should(finished.choices?.map(choice => choice.value)).deepEqual(['a', 'b', 'c']);
  });

  it('should ignore a reply whose id is neither the handshake nor the awaited page', async () => {
    // The app-server also emits notifications. Reading one as a page would end the exchange with
    // whatever it happened to contain.
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);

    // Act
    const ignoredById = subject.receive({ id: 99, result: { data: [{ model: 'wrong' }] } });
    const ignoredNotification = subject.receive({ method: 'thread/event', params: {} });

    // Assert
    should(ignoredById).deepEqual({ send: [] });
    should(ignoredNotification).deepEqual({ send: [] });
    should(subject.complete).equal(false);
  });

  it('should ignore anything that arrives after the catalog is complete', async () => {
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);
    subject.receive(page([{ model: 'gpt-5.6-codex' }]));

    // Act
    const trailing = subject.receive(page([{ model: 'too late' }]));

    // Assert
    should(trailing).deepEqual({ send: [] });
  });

  it('should ignore a second handshake reply rather than restarting the exchange', async () => {
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);

    // Act
    const repeated = subject.receive(handshake);

    // Assert
    should(repeated).deepEqual({ send: [] });
  });

  it('should surface a handshake that was refused', async () => {
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');

    // Act, Assert
    should(() => subject.receive({ id: 1, error: { message: 'unsupported protocol' } })).throw(/unsupported protocol/u);
  });

  it('should refuse a catalog with nothing selectable in it', async () => {
    // An account offering no model is not a state a switch can be planned against, and an empty
    // catalog would render as "this account has no choices" rather than as the fault it is.
    // Arrange
    const subject = new CodexModelListExchange();
    subject.start('fyd', '1.2.3');
    subject.receive(handshake);

    // Act, Assert
    should(() => subject.receive(page([]))).throw(CodexModelCatalogError);
    should(() => new CodexModelListExchange().receive(page([]))).throw(/did not advertise any selectable/u);
  });
});
