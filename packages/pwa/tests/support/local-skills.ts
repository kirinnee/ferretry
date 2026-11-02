/**
 * Fixed fake data for the "On this machine" source: the machine's skills inventory, the copy routes' answers
 * and a daemon refusal, all parsed through the real schemas so a change to the daemon's answer fails here.
 */

import {
  type LocalSkillInstall,
  type LocalSkillInstalled,
  LocalSkillInstalledSchema,
  LocalSkillInstallSchema,
  type LocalSkillPreview,
  LocalSkillPreviewSchema,
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

const AT = '2026-11-02T09:00:00.000Z';
const LOCAL_PREVIEW_ID = `lsp_${'v'.repeat(22)}`;
const LOCAL_INSTALL_ID = `lsi_${'n'.repeat(22)}`;
export const OTHER_INSTALL_ID = `lsi_${'o'.repeat(22)}`;

export const PDF_PATH = '/fy/fleet/homes/claude-play/skills/pdf-tools/SKILL.md';
export const DEPLOY_PATH = '/work/api/.claude/skills/deploy-notes/SKILL.md';
export const CODEX_PATH = '/fy/fleet/homes/codex-play/skills/lint-fix/SKILL.md';

const entry = (name: string, path: string, harness: 'claude' | 'codex', description: string, scope = 'user') => ({
  name,
  description,
  harness,
  scope,
  path,
  runtimes: [],
});

/** Four skills elsewhere on the machine plus one the session already has (`floop`, by name). */
export const MACHINE: MachineSkillsInventory = MachineSkillsInventorySchema.parse({
  truncated: false,
  homes: [
    {
      runtime: 'claude-play',
      harness: 'claude',
      home: '/fy/fleet/homes/claude-play',
      skills: [
        entry('pdf-tools', PDF_PATH, 'claude', 'Read and fill in PDF forms'),
        entry('floop', '/fy/fleet/homes/claude-play/skills/floop/SKILL.md', 'claude', 'Review → fix loop'),
      ],
    },
    {
      runtime: 'codex-play',
      harness: 'codex',
      home: '/fy/fleet/homes/codex-play',
      skills: [entry('lint-fix', CODEX_PATH, 'codex', 'Fix lint errors in one pass')],
    },
  ],
  projects: [
    {
      name: 'api',
      root: '/work/api',
      skills: [
        entry('deploy-notes', DEPLOY_PATH, 'claude', 'Write release notes from merged PRs', 'project'),
        // Listed twice (an account and a project both hold it): the machine lists it once.
        entry('pdf-tools', PDF_PATH, 'claude', 'Read and fill in PDF forms', 'project'),
      ],
    },
  ],
});

const projectTarget = { scope: 'project', projectRoot: '/work/app', harness: 'claude' } as const;
const runtimeTarget = { scope: 'runtime', runtime: 'rt-work', profile: 'default' } as const;

const provenance = {
  publisher: `fy_daemon_${'0'.repeat(43)}`,
  publisherName: 'This machine',
  catalogId: `cat_${'0'.repeat(22)}`,
  catalogName: 'Skills on this machine',
  itemId: `itm_${'a'.repeat(22)}`,
  kind: 'skill',
  name: 'pdf-tools',
  version: 1,
  digest: `sha256:${'a'.repeat(64)}`,
};

const origin = { kind: 'account', owner: 'claude-play', harness: 'claude', path: PDF_PATH } as const;

export const localPreview = (change: Record<string, unknown> = {}): LocalSkillPreview =>
  LocalSkillPreviewSchema.parse({
    previewId: LOCAL_PREVIEW_ID,
    expiresAt: AT,
    name: 'pdf-tools',
    origin,
    provenance,
    target: projectTarget,
    destination: '/work/app/.claude/skills/pdf-tools/ (2 files)',
    review: [
      { label: 'Skill file SKILL.md', text: '# pdf-tools\nRead and fill in PDF forms.\n', document: true },
      { label: 'Skill file scripts/fill.sh', text: '#!/bin/sh\necho filled\n', document: true },
    ],
    skipped: [],
    warnings: [],
    ...change,
  });

export const WARNED_PREVIEW = {
  warnings: [
    {
      code: 'possible-secret',
      text: 'scripts/fill.sh line 2 holds what looks like a raw key. It may be an example, but it is a credential if it is not.',
    },
    { code: 'carries-scripts', text: 'This skill carries scripts: scripts/fill.sh.' },
  ],
  review: [
    { label: 'Skill file SKILL.md', text: '# pdf-tools\nRead and fill in PDF forms.\n', document: true },
    { label: 'Skill file scripts/fill.sh', text: '#!/bin/sh\nKEY=sk-example‮echo filled\n', document: true },
  ],
} as const;

export const runtimePreview = (change: Record<string, unknown> = {}): LocalSkillPreview =>
  localPreview({
    target: runtimeTarget,
    destination: 'the skill pdf-tools, on claude-work (profile default)',
    ...change,
  });

export const localInstall = (change: Record<string, unknown> = {}): LocalSkillInstall =>
  LocalSkillInstallSchema.parse({
    installId: LOCAL_INSTALL_ID,
    installedAt: AT,
    name: 'pdf-tools',
    origin,
    target: projectTarget,
    destination: '/work/app/.claude/skills/pdf-tools/ (2 files)',
    files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }],
    ...change,
  });

export const localInstalled = (
  install: Record<string, unknown> = {},
  notes: readonly string[] = [],
): LocalSkillInstalled => LocalSkillInstalledSchema.parse({ install: localInstall(install), notes });

/** The daemon's refusal as the client throws it. */
export const refusal = (code: string, message: string, status = 422): FyHttpError =>
  new FyHttpError(message, status, code);

export const CREDENTIAL_SENTENCE =
  'scripts/fill.sh line 2 holds what looks like a password or key. Remove it, then copy the skill.';
