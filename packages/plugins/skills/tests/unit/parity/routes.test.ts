/**
 * The Skills-owned R rows of docs/design/rebuild-parity.tsv, each driven through the real daemon half on the kernel's
 * test host. Today's `/v1/sessions/:sessionId/skills…` is `/v1/ferrets/:ferretId/skills…` (design §1.4, recorded in
 * descriptor-parity-changes.tsv). `GET /v1/skills` (R-0197) is not here: its runtime homes and registered projects are
 * seams the half does not bind yet (ports-pending.json, skills), so it always answers an empty listing.
 */
import { describe, expect, test } from 'bun:test';
import { doc, skillsHost } from './host.ts';

describe('the skills routes', () => {
  test('R-0175 GET /v1/sessions/:sessionId/skills is GET /v1/ferrets/:ferretId/skills: the composer list, 404 for a stranger', async () => {
    const host = await skillsHost();
    const answered = await host.request('GET', '/v1/ferrets/f1/skills');
    expect(answered.status).toBe(200);
    expect(answered.json()).toMatchObject({
      harness: 'claude-code',
      skills: [
        { name: 'review', scope: 'project', description: 'reviews a diff' },
        { name: 'ship', scope: 'project', description: 'ships a release' },
      ],
    });
    expect((await host.request('GET', '/v1/ferrets/nobody/skills')).status).toBe(404);
  });

  test('R-0176 GET /v1/sessions/:sessionId/skills/inventory is GET /v1/ferrets/:ferretId/skills/inventory: exactly what the ferret sees', async () => {
    const host = await skillsHost();
    const answered = await host.request('GET', '/v1/ferrets/f1/skills/inventory');
    expect(answered.status).toBe(200);
    const inventory = answered.json<{ skills: { name: string; path: string }[] }>();
    expect(inventory).toMatchObject({ ferretId: 'f1', folder: '/work/app', truncated: false });
    expect(inventory.skills.map(skill => skill.name)).toEqual(['review', 'ship']);
    expect(inventory.skills[0]?.path).toBe('/work/app/.claude/skills/review/SKILL.md');
    expect((await host.request('GET', '/v1/ferrets/nobody/skills/inventory')).status).toBe(404);
  });

  test('R-0198 GET /v1/skills/file serves the SKILL.md of a listed skill only, and says what is wrong otherwise', async () => {
    const host = await skillsHost();
    const path = '/work/app/.claude/skills/review/SKILL.md';
    const served = await host.request('GET', '/v1/skills/file', { query: { path, ferretId: 'f1' } });
    expect(served.status).toBe(200);
    expect(served.json()).toEqual({ path, content: doc('review', 'reviews a diff') });
    expect((await host.request('GET', '/v1/skills/file', { query: { ferretId: 'f1' } })).status).toBe(400);
    const unlisted = await host.request('GET', '/v1/skills/file', { query: { path: '/etc/passwd', ferretId: 'f1' } });
    expect(unlisted.status).toBe(404);
    const stranger = await host.request('GET', '/v1/skills/file', { query: { path, ferretId: 'nobody' } });
    expect(stranger.status).toBe(404);
  });
});
