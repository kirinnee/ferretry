/** catalogs#7 — My catalogs' Publish skills picker lists the machine's skills, read from Skills' own inventory. */
import type { FC } from 'react';
import { describe, expect, it } from 'bun:test';
import { mount, RouterProvider } from '@ferretry/app/testing';
import { fetchMachineSkillEntries } from '../../../app/lib/machine-skills.ts';
import { createSharingScreen } from '../../../app/views/catalogs-views.tsx';

const skill = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `${name} skill`,
  harness: 'claude-code',
  scope: 'user',
  path: `/home/.claude/skills/${name}/SKILL.md`,
  runtimes: ['marin'],
  ...over,
});
const INVENTORY = {
  homes: [
    {
      runtime: 'marin',
      harness: 'claude-code',
      home: '/home/.claude',
      skills: [skill('lint', { shadowedBy: 'project' })],
    },
  ],
  projects: [
    {
      name: 'ferretry',
      root: '/work/ferretry',
      skills: [skill('deploy', { scope: 'project', path: '/work/ferretry/.claude/skills/deploy/SKILL.md' })],
    },
  ],
  truncated: false,
};

describe('catalogs#7 machine skills for the Publish skills picker', () => {
  it('lists the account homes first, then each project’s skills naming their project, shadowed ones included', async () => {
    const calls: unknown[] = [];
    const client = {
      call: (async (route: string, init?: unknown) => {
        calls.push([route, init]);
        return INVENTORY;
      }) as never,
    };
    const controller = new AbortController();
    const entries = await fetchMachineSkillEntries(client, controller.signal);
    expect(calls).toEqual([['GET /v1/skills', { signal: controller.signal }]]);
    expect(entries.map(entry => entry.name)).toEqual(['lint', 'deploy']);
    expect(entries[0]?.shadowedBy).toBe('project');
    expect(entries[1]?.project).toEqual({ name: 'ferretry', root: '/work/ferretry' });
    expect((await fetchMachineSkillEntries(client)).length).toBe(2);
  });

  it('hands the sharing screen’s catalogs tab that reader', async () => {
    const client = { call: (async () => INVENTORY) as never };
    const Screen = createSharingScreen(client as never) as unknown as FC<Record<string, unknown>>;
    const view = await mount(
      <RouterProvider>
        <Screen params={{ tab: 'catalogs' }} />
      </RouterProvider>,
    );
    try {
      expect(view.container.querySelector('[data-sharing="catalogs"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
