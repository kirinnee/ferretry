import { describe, it } from 'bun:test';
import should from 'should';
import { type HeldLocalSkill, LocalSkillPreviews } from '../../../src/lib/local-skill-installs/previews.ts';

const TTL = 600_000;
const CALLER = 'device:dev_a';
const OTHER = 'device:dev_b';
const idOf = (n: number) => `lsp_${String(n).padStart(22, '0')}` as HeldLocalSkill['previewId'];

function held(n: number, createdAt = 1_000, caller = CALLER): HeldLocalSkill {
  return {
    previewId: idOf(n),
    caller,
    expiresAt: createdAt + TTL,
    name: 'demo',
    origin: { kind: 'account', owner: 'claude-work', harness: 'claude', path: '/h/skills/demo/SKILL.md' },
    provenance: {} as HeldLocalSkill['provenance'],
    target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
    files: [{ path: 'SKILL.md', content: 'x' }],
  };
}

describe('local copy previews waiting for a yes', () => {
  it('finds a preview it holds, for the caller that asked', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(1), 1_000);

    const lookup = previews.get(idOf(1), CALLER, 2_000);

    should(lookup.kind).equal('found');
    should(previews.size).equal(1);
  });

  it('tells anyone else, and a stranger’s id, that it is unknown', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), OTHER, 2_000).kind).equal('unknown');
    should(previews.get(idOf(2), CALLER, 2_000).kind).equal('unknown');
  });

  it('says expired from the moment it runs out', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(1), 1_000);

    should(previews.get(idOf(1), CALLER, 1_000 + TTL - 1).kind).equal('found');
    should(previews.get(idOf(1), CALLER, 1_000 + TTL).kind).equal('expired');
  });

  it('drops a preview that expired a whole lifetime ago when another is put', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(1), 1_000);
    previews.put(held(2, 1_000 + 3 * TTL), 1_000 + 3 * TTL);

    should(previews.size).equal(1);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
  });

  it('keeps eight per caller by default, dropping that caller’s oldest', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(100, 1_000, OTHER), 1_000);
    for (let n = 1; n <= 9; n += 1) previews.put(held(n), 1_000);

    should(previews.size).equal(9);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
    should(previews.get(idOf(2), CALLER, 1_000).kind).equal('found');
    should(previews.get(idOf(100), OTHER, 1_000).kind).equal('found');
  });

  it('honours a smaller bound', () => {
    const previews = new LocalSkillPreviews(TTL, 1);
    previews.put(held(1), 1_000);
    previews.put(held(2), 1_000);

    should(previews.size).equal(1);
  });

  it('spends a preview when it is consumed', () => {
    const previews = new LocalSkillPreviews(TTL);
    previews.put(held(1), 1_000);

    previews.consume(idOf(1));

    should(previews.size).equal(0);
    should(previews.get(idOf(1), CALLER, 1_000).kind).equal('unknown');
  });
});
