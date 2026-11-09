/**
 * The Skills-owned R rows of docs/design/rebuild-parity.tsv, each driven through the real daemon half on the kernel's
 * test host. Today's `/v1/sessions/:sessionId/skills…` is `/v1/ferrets/:ferretId/skills…` (design §1.4, recorded in
 * descriptor-parity-changes.tsv); the `GET /v1/skills/file` query parameter `sessionId` is `ferretId` in the same way
 * (the app's client must follow it).
 *
 * What these prove: a project's skills, read through a ferret's work root. What they do NOT prove, and why no row here is
 * ticked but R-0198 (ports-pending.json, skills): R-0175, R-0176 and F-0012 are open because the half binds no account or
 * runtime home, so an account's skills (`~/.claude`, `~/.codex`, a runtime home) are never listed and nothing shows a
 * project skill shadowing a same-named global one; `GET /v1/skills` (R-0197) is open because its homes and registered
 * projects are unbound, so it always answers an empty listing, and `GET /v1/skills/file` WITHOUT a ferret (the machine
 * half of R-0198) can only answer 404 for the same reason.
 */
import { describe, expect, test } from 'bun:test';
import { doc, skillsHost } from './host.ts';

describe('the skills routes', () => {
  test('R-0175 GET /v1/sessions/:sessionId/skills is GET /v1/ferrets/:ferretId/skills: the composer list, 404 for a stranger', async () => {
    const host = await skillsHost();
    const answered = await host.request('GET', '/v1/ferrets/f1/skills');
    expect(answered.status).toBe(200);
    expect(answered.headers.get('cache-control')).toBe('no-store');
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
    expect(answered.headers.get('cache-control')).toBe('no-store');
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
    expect(served.headers.get('cache-control')).toBe('no-store');
    // Inside the ferret's folder and its skills folder, but not a listed skill: the rule is the listing, not the fence.
    const unlisted = await host.request('GET', '/v1/skills/file', {
      query: { path: '/work/app/.claude/skills/notes/readme.md', ferretId: 'f1' },
    });
    expect(unlisted.status).toBe(404);
    const outside = await host.request('GET', '/v1/skills/file', { query: { path: '/etc/passwd', ferretId: 'f1' } });
    expect(outside.status).toBe(404);
    const refused = await host.request('GET', '/v1/skills/file', {
      query: { path, ferretId: 'f1' },
      as: { kind: 'device', holder: 'dev_a', capabilities: ['fleet.use'] },
    });
    expect(refused.status).toBe(403);
    const stranger = await host.request('GET', '/v1/skills/file', { query: { path, ferretId: 'nobody' } });
    expect(stranger.status).toBe(404);
  });
});
