import { definePlugin, panel, renderer, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { audit, cap } from '@ferretry/core-gate/contract';
import { FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import {
  SKILLS_AUDIT,
  SKILLS_CONFIG,
  SKILLS_INSTALLED_STATE,
  SKILLS_INSTALLS_STATE,
  SKILLS_READ_MODELS,
  SKILLS_WORDS,
  SkillsChanged,
  SkillsPort,
} from './contract/index.ts';

/**
 * Skills (§2.3): skills as items. Routes are today's `catalogs.ts` skill routes and `local-skill-installs.ts`, descriptor
 * fields copied exactly. Paths follow §3.2/§1.4: `/v1/skill-installs/local…` → `/v1/skills/installs/local…`;
 * `/v1/sessions/:sessionId/skills…` → `/v1/ferrets/:ferretId/skills…`. `/v1/projects` (the other two routes of today's
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
  provides: { skills: SkillsPort },

  actions: {
    routes: [
      // ── what skills exist and what a ferret sees ────────────────────────────────────────────────────────────────
      route('GET /v1/ferrets/:ferretId/skills', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
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

      // ── copying one skill from this machine (G172–G175): every route a PERSON'S act ───────────────────────────────
      route('POST /v1/skills/installs/local/project/preview', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'a preview writes nothing' },
        guard: { none: 'the files of a skill folder in full, for review; no pane text' },
      }),
      route('POST /v1/skills/installs/local/runtime/preview', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'a preview writes nothing' },
        guard: { none: 'the files of a skill folder in full, for review; no pane text' },
      }),
      route('POST /v1/skills/installs/local/project', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('filesystem', 'configure'),
        noStore: true,
        audit: audit(SKILLS_AUDIT.installProject),
        guard: { none: 'the install record: names, paths and hashes' },
      }),
      route('POST /v1/skills/installs/local/runtime', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SKILLS_AUDIT.installRuntime),
        guard: { none: 'the install record: names, paths and hashes' },
      }),
      route('GET /v1/skills/installs/local', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read of install records' },
        guard: { none: 'install records: names, paths and hashes' },
      }),
      route('DELETE /v1/skills/installs/local/project/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('filesystem', 'configure'),
        noStore: true,
        audit: audit(SKILLS_AUDIT.removeProject),
        guard: { none: 'the removed name and destination' },
      }),
      route('DELETE /v1/skills/installs/local/runtime/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(SKILLS_AUDIT.removeRuntime),
        guard: { none: 'the removed name and destination' },
      }),
    ],
    cli: [
      verb('skill install', {
        summary: 'copy one skill from another account or project on this machine, after you review all of it',
      }),
      verb('skill installs', { summary: 'list the skills copied from this machine, and where' }),
      verb('skill uninstall', { summary: 'remove one copy, and only the files it wrote' }),
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
    state: [SKILLS_INSTALLED_STATE, SKILLS_INSTALLS_STATE],
    config: [SKILLS_CONFIG],
    readModels: SKILLS_READ_MODELS,
    publishes: [SkillsChanged],
  },

  hooks: {
    takes: [{ hook: LaunchParts }],
  },

  permissions: {
    roots: ['work', 'imports'],
    network: [],
    spawn: [],
    secrets: [],
  },
});
