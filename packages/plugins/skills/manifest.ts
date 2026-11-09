import { definePlugin, panel, renderer, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { cap } from '@ferretry/core-gate/contract';
import { FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import { ConversationPort, ReferenceCatalog } from '@ferretry/plugin-conversation/contract';
import {
  SKILLS_CONFIG,
  SKILLS_INSTALLED_STATE,
  SKILLS_READ_MODELS,
  SKILLS_WORDS,
  SkillsPort,
} from './contract/index.ts';

/**
 * Skills (§2.3): skills as items. Routes are today's `catalogs.ts` skill routes, descriptor fields copied
 * exactly. Path: `/v1/sessions/:sessionId/skills…` → `/v1/ferrets/:ferretId/skills…`. `/v1/projects` (the other two routes of today's
 * `catalogs.ts` mount) is Projects', not Skills'.
 *
 * Departure: today's `GET /v1/sessions/:sessionId/skills` carries `precedence: 1` to keep a winner over
 * `/v1/sessions/by-request/skills`. That shadow belongs to the old layout; the new path has no such sibling, so the
 * field is dropped (the descriptor-parity harness will say if one turns up).
 */
export default definePlugin({
  id: 'skills',
  title: 'Skills',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['item', 'command', 'view'],
  words: SKILLS_WORDS,

  needs: { ferrets: FerretsPort },
  // Optional (lead ruling 2026-11-07: a reference.catalog provider takes Conversation as optional `uses`). With Conversation
  // off, Skills boots and nothing asks it for a menu.
  uses: { conversation: ConversationPort },
  provides: { skills: SkillsPort },

  actions: {
    routes: [
      // ── what skills exist and what a ferret sees ────────────────────────────────────────────────────────────────
      route('GET /v1/ferrets/:ferretId/skills', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        precedence: 1,
        audit: { skip: 'a read of names and descriptions' },
        guard: { none: 'skill names and descriptions; no pane text, no secret' },
      }),
      route('GET /v1/ferrets/:ferretId/skills/inventory', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of names, descriptions and paths' },
        guard: { none: 'skill names, descriptions and paths; no pane text, no secret' },
      }),
      route('GET /v1/skills', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read of names, descriptions and paths' },
        guard: { none: 'skill names, descriptions and paths; no pane text, no secret' },
      }),
      // The inventory's Open: the one route that returns SKILL.md text, and only for a path the inventory lists.
      route('GET /v1/skills/file', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'a read of a file the inventory lists; not recorded today' },
        guard: { none: 'the text of a SKILL.md the person asked to read; it is their own file' },
      }),
    ],
    cli: [
      verb('skill ls', { summary: 'the skills a ferret or this machine has' }),
      verb('skill show', { summary: 'one skill item and where it is used' }),
      verb('skill add', { summary: 'add a skills item' }),
      verb('skill edit', { summary: 'change a skills item; every profile and runtime that uses it changes too' }),
      verb('skill rm', { summary: 'remove a skills item' }),
    ],
  },

  ui: {
    // The Skills tab of a ferret's "This folder" context, and the inventory under Settings.
    panels: [panel('ferret.side', { id: 'skills', order: 50 })],
    settings: [settingsTab('skills', { label: 'Skills', order: 60 })],
    // `/name` and `$name` are one skill reference: Claude invokes `/name`, Codex `$name` (docs/reference-standard.md).
    renderers: [renderer('reference', { prefix: '/' }), renderer('reference', { prefix: '$' })],
  },

  data: {
    state: [SKILLS_INSTALLED_STATE],
    config: [SKILLS_CONFIG],
    readModels: SKILLS_READ_MODELS,
  },

  hooks: {
    // `/` and `$` are one skill: Claude invokes `/name`, Codex `$name`. Conversation's composer asks for the menu entries
    // of each prefix; Skills answers with the skill names the ferret can invoke.
    takes: [{ hook: LaunchParts }, { hook: ReferenceCatalog, key: '/' }, { hook: ReferenceCatalog, key: '$' }],
  },

  permissions: {
    roots: ['work', 'imports'],
    network: [],
    spawn: [],
    secrets: [],
  },
});
