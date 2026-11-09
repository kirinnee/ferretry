/** Parity rows F-0012, F-0013, F-0162 (docs/design/rebuild-parity.md, skills). */
import { describe, expect, test } from 'bun:test';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import type { Log } from '@ferretry/kernel/contract';
import { SKILLS_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { doc, skillsHost } from './host.ts';

const HOME = '/home/fy';
const quiet: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

/** The kernel's REAL config writer over an in-memory home that declares the `skills` collection. */
function realSkillsConfig() {
  const fs = hostState.createMemoryHostFs();
  const files = hostConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => Date.parse('2026-11-07T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'skills', def: SKILLS_CONFIG }],
  });
  return { files, port: files.port('skills'), fs };
}

describe('the skills files', () => {
  test('F-0162 today’s config/components/skills/{name}.yaml is config/skills/{name}.yaml: one yaml file per item, written by the kernel’s writer', async () => {
    expect(manifest.data.config).toContain(SKILLS_CONFIG);
    const real = realSkillsConfig();
    const written = await real.port.write(SKILLS_CONFIG, 'review-pack', { patch: { items: ['review', 'ship'] } });
    expect(written.kind).toBe('written');
    const text = await real.fs.readText(`${HOME}/config/skills/review-pack.yaml`);
    expect(text).toContain('items:');
    expect(text).toContain('- review');
    expect(text).toContain('- ship');
    await real.files.reload();
    expect(real.port.collection(SKILLS_CONFIG as never).get('review-pack')).toEqual({ items: ['review', 'ship'] });
    // A name that is not one safe segment is no item; a twice-listed skill is refused, not stored.
    expect(SKILLS_CONFIG.shape === 'collection' ? SKILLS_CONFIG.name.test('../escape') : true).toBe(false);
    const twice = await real.port.write(SKILLS_CONFIG, 'twice', { patch: { items: ['review', 'review'] } });
    expect(twice.kind).toBe('refused');
    expect(await real.fs.readText(`${HOME}/config/skills/twice.yaml`).catch(() => undefined)).toBeUndefined();
  });

  test('F-0013 a skill is the folder {directory}/{name}/SKILL.md the half reads through the work root: a folder with no SKILL.md is no skill', async () => {
    const host = await skillsHost();
    const inventory = (await host.request('GET', '/v1/ferrets/f1/skills/inventory')).json<{
      skills: { name: string; path: string }[];
    }>();
    expect(inventory.skills.map(skill => skill.path)).toEqual([
      '/work/app/.claude/skills/review/SKILL.md',
      '/work/app/.claude/skills/ship/SKILL.md',
    ]);
    const file = await host.request('GET', '/v1/skills/file', {
      query: { ferretId: 'f1', path: '/work/app/.claude/skills/ship/SKILL.md' },
    });
    expect(file.json()).toMatchObject({ content: doc('ship', 'ships a release') });
  });

  test('F-0012 the composer’s `/` and `$` list reads the same {directory}/{name}/SKILL.md, name and description from its front matter', async () => {
    const host = await skillsHost();
    host.putRoot('work', '.claude/skills/ship/SKILL.md', doc('ship', 'ships it twice as fast'));
    const listed = (await host.request('GET', '/v1/ferrets/f1/skills')).json<{
      skills: { name: string; description: string }[];
    }>();
    expect(listed.skills).toEqual([
      expect.objectContaining({ name: 'review', description: 'reviews a diff' }),
      expect.objectContaining({ name: 'ship', description: 'ships it twice as fast' }),
    ]);
  });
});
