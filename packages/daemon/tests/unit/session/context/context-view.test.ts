import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import { sessionContextOf, withContext } from '../../../../src/lib/session/context/context-view.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const AT = '2026-10-30T08:00:00.000Z';

const view = (id: string, config: Record<string, unknown> = {}, state: Record<string, unknown> = {}): SessionView =>
  sessionView(id, { model: 'opus[1m]', ...config }, { contextTokens: 118_000, contextAt: AT, ...state });

describe('sessionContextOf', () => {
  it('should answer the size, window, percent and instant when all are known', () => {
    // Arrange / Act
    const actual = sessionContextOf(view('a'), undefined);

    // Assert
    should(actual).deepEqual({ usedTokens: 118_000, windowTokens: 1_000_000, percent: 11.8, at: AT });
  });

  it('should take the window the catalog declares for a model that states none itself', () => {
    // Arrange
    const subject = view('a', { model: 'plain' });

    // Act / Assert
    should(sessionContextOf(subject, 400_000)?.windowTokens).equal(400_000);
  });

  it('should believe the window the harness reported and the overrides over the selector', () => {
    // Arrange / Act / Assert
    should(sessionContextOf(view('a', {}, { contextWindow: 272_000 }), undefined)?.windowTokens).equal(272_000);
    should(
      sessionContextOf(view('a', {}, { observedModel: 'glm-5.2' }), undefined, { 'glm-5.2': 131_072 })?.windowTokens,
    ).equal(131_072);
  });

  it('should answer nothing when the window is unknown, never a guess', () => {
    // Arrange / Act / Assert
    should(sessionContextOf(view('a', { model: 'plain' }), undefined)).be.undefined();
  });

  it('should answer nothing when the transcript has stated no size', () => {
    // Arrange / Act / Assert
    should(sessionContextOf(sessionView('a', { model: 'opus[1m]' }, {}), undefined)).be.undefined();
  });
});

describe('withContext', () => {
  const setup = (declared: () => Promise<(view: SessionView) => number | undefined>) => {
    let clock = 0;
    let asked = 0;
    const reader = withContext(
      {
        list: async () => [view('a'), view('b', { model: 'plain' }), sessionView('c', {}, {})],
        get: async id => (id === 'none' ? undefined : view(id)),
      },
      {
        declared: async () => {
          asked += 1;
          return await declared();
        },
        overrides: {},
        now: () => clock,
        ttlMs: 5_000,
      },
    );
    return {
      reader,
      asked: () => asked,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  it('should mark each view whose size and window are known, and fill the percent the CLI reads', async () => {
    // Arrange
    const { reader } = setup(async () => () => undefined);

    // Act
    const list = await reader.list();

    // Assert
    should(list[0]?.context).deepEqual({ usedTokens: 118_000, windowTokens: 1_000_000, percent: 11.8, at: AT });
    should(list[0]?.state.contextPercent).equal(11.8);
    should(list[1]?.context).be.undefined();
    should(list[2]?.context).be.undefined();
    should((await reader.get('a'))?.context?.percent).equal(11.8);
    should(await reader.get('none')).be.undefined();
  });

  it('should use the catalog window for a model that states none', async () => {
    // Arrange
    const { reader } = setup(async () => v => (v.config.model === 'plain' ? 200_000 : undefined));

    // Act
    const list = await reader.list();

    // Assert
    should(list[1]?.context?.windowTokens).equal(200_000);
  });

  it('should read the catalog once per ttl, not once per session', async () => {
    // Arrange
    const { reader, asked, advance } = setup(async () => () => undefined);

    // Act
    await reader.list();
    await reader.get('a');
    advance(4_999);
    await reader.get('a');
    const within = asked();
    advance(2);
    await reader.get('a');

    // Assert
    should(within).equal(1);
    should(asked()).equal(2);
  });

  it('should treat an unreadable catalog as one that declares nothing', async () => {
    // Arrange
    const { reader } = setup(async () => {
      throw new Error('catalog unreadable');
    });

    // Act
    const list = await reader.list();

    // Assert
    should(list[0]?.context?.windowTokens).equal(1_000_000);
    should(list[1]?.context).be.undefined();
  });
});
