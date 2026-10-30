/**
 * Fixtures for the Context suites, written out longhand as the shared contract and parsed
 * through the real schemas, so a change to the daemon's answer fails here rather than slipping past.
 */

import {
  type McpInventory,
  McpInventorySchema,
  type McpInventoryServer,
  type SessionSkillsInventory,
  SessionSkillsInventorySchema,
  type SkillEntry,
} from '@ferretry/protocol';
import type { ContextDoc } from '../../../../src/features/context-rail/context-rail-model.ts';

export const NOW = Date.parse('2026-10-16T10:00:00.000Z');

export const skill = (overrides: Partial<SkillEntry> & { name: string }): SkillEntry => ({
  description: `What ${overrides.name} does.`,
  harness: 'claude',
  scope: 'user',
  path: `/fy/fleet/homes/claude-work/skills/${overrides.name}/SKILL.md`,
  runtimes: ['claude-work'],
  ...overrides,
});

export const SKILLS: SessionSkillsInventory = SessionSkillsInventorySchema.parse({
  sessionId: 'session-a',
  harness: 'claude',
  runtime: 'claude-work',
  truncated: false,
  skills: [
    skill({ name: 'babysit-pr', description: 'Drive a PR to green', scope: 'ferretry' }),
    skill({ name: 'floop', description: 'Review → fix loop' }),
    skill({
      name: 'summary',
      description: 'Summarise this session for the human',
      scope: 'project',
      path: '/work/app/.claude/skills/summary/SKILL.md',
      project: { root: '/work/app' },
    }),
    skill({ name: 'summary', description: 'An older summary', shadowedBy: 'project' }),
  ],
});

export const mcpServer = (overrides: Partial<McpInventoryServer> & { name: string }): McpInventoryServer => ({
  id: `id-${overrides.name}-${overrides.scope ?? 'component'}`,
  scope: 'component',
  harness: 'claude',
  transport: 'http',
  target: `https://${overrides.name}.example/mcp`,
  runtimes: [{ runtime: 'claude-work' }],
  ...overrides,
});

export const MCP: McpInventory = McpInventorySchema.parse({
  problems: [],
  servers: [
    mcpServer({ name: 'ferretry', scope: 'ferretry', transport: 'stdio', target: 'fy mcp serve' }),
    mcpServer({ name: 'github', scope: 'user', transport: 'stdio', target: 'npx', source: '/fy/home/.claude.json' }),
    mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'signed-in',
        issuer: 'https://auth.linear.example',
        expiresAt: '2026-10-23T10:00:00.000Z',
        renewable: true,
        secrets: [],
      },
    }),
    mcpServer({
      name: 'notion',
      scope: 'project',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'approved' }],
      signIn: { subject: 'notion..a1b2c3d4e5f6', required: false },
    }),
    mcpServer({
      name: 'lint',
      scope: 'project',
      transport: 'stdio',
      target: 'npx',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'pending' }],
    }),
    mcpServer({ name: 'scratch', scope: 'local', transport: 'stdio', target: 'node', project: { root: '/work/app' } }),
  ],
});

export const DOCS: readonly ContextDoc[] = [
  { path: 'CLAUDE.md', name: 'CLAUDE.md', size: 12_800 },
  { path: 'AGENTS.md', name: 'AGENTS.md', size: 1_434 },
];
