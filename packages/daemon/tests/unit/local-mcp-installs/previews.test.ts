import { describe, it } from 'bun:test';
import should from 'should';
import { type HeldLocalMcp, LocalMcpPreviews } from '../../../src/lib/local-mcp-installs/previews.ts';

const TTL = 600_000;
const CALLER = 'device:dev_a';
const OTHER = 'device:dev_b';
const idOf = (n: number) => `lmp_${String(n).padStart(22, '0')}` as HeldLocalMcp['previewId'];

function held(n: number, createdAt = 1_000, caller = CALLER): HeldLocalMcp {
  return {
    previewId: idOf(n),
    caller,
    expiresAt: createdAt + TTL,
    name: 'search',
    origin: { kind: 'account', owner: 'claude-work', harness: 'claude', scope: 'user', id: 'a'.repeat(24) },
    provenance: {} as HeldLocalMcp['provenance'],
    target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
    setup: { transport: 'command', command: 'npx', args: [], env: { API_TOKEN: '${secret:API_TOKEN}' } },
    placeholders: ['API_TOKEN'],
  };
}

describe('local MCP copy previews waiting for a yes', () => {
  it('finds a preview it holds, for the caller that asked', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), CALLER, 2_000).kind).equal('found');
    should(previews.size).equal(1);
  });

  it('tells anyone else, and a stranger’s id, that it is unknown', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), OTHER, 2_000).kind).equal('unknown');
    should(previews.get(idOf(2), CALLER, 2_000).kind).equal('unknown');
  });

  it('says expired from the moment it runs out', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), CALLER, 1_000 + TTL - 1).kind).equal('found');
    should(previews.get(idOf(1), CALLER, 1_000 + TTL).kind).equal('expired');
  });

  it('drops a preview that expired a whole lifetime ago when another is put', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(1), 1_000);
    previews.put(held(2, 1_000 + 3 * TTL), 1_000 + 3 * TTL);

    should(previews.size).equal(1);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
  });

  it('keeps eight per caller by default, dropping that caller’s oldest', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(100, 1_000, OTHER), 1_000);
    for (let n = 1; n <= 9; n += 1) previews.put(held(n), 1_000);

    should(previews.size).equal(9);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
    should(previews.get(idOf(2), CALLER, 1_000).kind).equal('found');
    should(previews.get(idOf(100), OTHER, 1_000).kind).equal('found');
  });

  it('honours a smaller bound', () => {
    const previews = new LocalMcpPreviews(TTL, 1);
    previews.put(held(1), 1_000);
    previews.put(held(2), 1_000);

    should(previews.size).equal(1);
  });

  it('spends a preview when it is consumed', () => {
    const previews = new LocalMcpPreviews(TTL);
    previews.put(held(1), 1_000);

    previews.consume(idOf(1));

    should(previews.size).equal(0);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
  });
});
