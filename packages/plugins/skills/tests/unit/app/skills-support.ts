/** Fixtures and a scripted client for Skills' app half: wire-shaped values, and a client that records its calls. */
import { DaemonCallError } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { FerretSkillsInventory, MachineSkillsInventory, SkillEntry } from '../../../contract/index.ts';

export const skill = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({
  name,
  description: `${name} does one thing`,
  harness: 'claude-code',
  scope: 'user',
  path: `/home/me/.claude/skills/${name}/SKILL.md`,
  runtimes: ['claude-default'],
  ...over,
});

export const ferretInventory = (
  skills: readonly SkillEntry[],
  over: Partial<FerretSkillsInventory> = {},
): FerretSkillsInventory => ({
  ferretId: 'f1',
  harness: 'claude-code',
  folder: '/work/dojo/api',
  runtime: 'claude-default',
  skills: [...skills],
  truncated: false,
  ...over,
});

export const machineInventory = (over: Partial<MachineSkillsInventory> = {}): MachineSkillsInventory => ({
  homes: [
    {
      runtime: 'claude-work',
      harness: 'claude-code',
      home: '/home/me/.claude-work',
      skills: [skill('review', { path: '/home/me/.claude-work/skills/review/SKILL.md', runtimes: ['claude-work'] })],
    },
  ],
  projects: [
    {
      id: 'p1',
      name: 'dojo',
      root: '/work/dojo',
      skills: [skill('deploy', { scope: 'project', path: '/work/dojo/.claude/skills/deploy/SKILL.md', runtimes: [] })],
    },
  ],
  truncated: false,
  ...over,
});

export interface Call {
  readonly route: string;
  readonly init: unknown;
}

export type Answers = Readonly<Record<string, unknown | ((init: unknown) => unknown)>>;

/** A client that answers by route key, records every call, and is bound to daemon `studio` for the composer scope. */
export const scripted = (answers: Answers, daemon = 'studio'): { client: PluginClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      const answer = answers[route];
      if (answer === undefined) throw new Error(`unscripted route ${route}`);
      const value = typeof answer === 'function' ? (answer as (init: unknown) => unknown)(init) : answer;
      if (value instanceof Error) throw value;
      return value;
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, daemon);
  return { client, calls };
};

/** A refusal as the shell's client throws it. */
export const refusal = (status: number, code: string, message: string): DaemonCallError =>
  new DaemonCallError(status, code, message);
