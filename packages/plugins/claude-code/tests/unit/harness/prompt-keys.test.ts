import { describe, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { CLAUDE_CODE_CONFIG, HarnessConfigSchema } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { mergeClaudeJson } from '../../../daemon/lib/harness/claude-json.ts';
import { CLAUDE_QUESTION_HOOKS, fixedLayer } from '../../../daemon/lib/harness/fixed-layer.ts';
import { homeText, launchCommand } from '../../../daemon/lib/harness/launch.ts';

/**
 * O11b (Claude Code 2.1.317 binary strings): the LSP, hints, survey, what's-new and rm-variant screens are answered in
 * the ferret's OWN home and launch environment. One test per key; each fails if its key is reverted.
 */

const FOLDER = '/work/repo';
const VERSION = '2.1.317';
const FRESH = homeText({
  folder: FOLDER,
  permissionMode: 'skip',
  instructions: [],
  parts: [],
  settings: new Map(),
  hooks: new Map(),
}).claudeJson;
/** `version` `null` is a launch that does not know the installed version. */
const seeded = (existing: unknown, version: string | null = VERSION): Record<string, unknown> =>
  JSON.parse(
    mergeClaudeJson(existing === undefined ? undefined : JSON.stringify(existing), FRESH, version ?? undefined) ?? '{}',
  );

const argv = (options: { permissionMode?: 'auto' | 'skip'; dangerousRmWaiver?: boolean } = {}): readonly string[] =>
  launchCommand({
    binary: '/opt/bin/claude',
    home: '/h/f1',
    permissionMode: options.permissionMode ?? 'skip',
    ...(options.dangerousRmWaiver === undefined ? {} : { dangerousRmWaiver: options.dangerousRmWaiver }),
    hasMcp: false,
    questionTool: false,
    conversation: { kind: 'new', id: 'c-1' },
  });
/** The `NAME=value` words `env` is given before the seed shell. */
const assignments = (command: readonly string[]): readonly string[] => command.filter(word => /^[A-Z_]+=/u.test(word));

describe('the .claude.json keys a ferret home asserts (O11b)', () => {
  it('1. should switch the LSP plugin recommendation off in a fresh home and in a carried one', () => {
    should(seeded(undefined).lspRecommendationDisabled).equal(true);
    should(seeded({}).lspRecommendationDisabled).equal(true);
    should(seeded({ lspRecommendationDisabled: null }).lspRecommendationDisabled).equal(true);
  });

  it('1. should keep a lspRecommendationDisabled the owner set to another value', () => {
    should(seeded({ lspRecommendationDisabled: false }).lspRecommendationDisabled).equal(false);
  });

  it('2. should switch the plugin recommendation (claudeCodeHints) off, and keep what is already in that object', () => {
    should(seeded(undefined).claudeCodeHints).eql({ disabled: true });
    should(seeded({ claudeCodeHints: { disabled: false } }).claudeCodeHints).eql({ disabled: false });
    should(seeded({ claudeCodeHints: { shown: ['a'] } }).claudeCodeHints).eql({ shown: ['a'], disabled: true });
    should(seeded({ claudeCodeHints: null }).claudeCodeHints).eql({ disabled: true });
  });

  it('3. should record the installed version as the last release notes seen, on every launch', () => {
    should(seeded(undefined).lastReleaseNotesSeen).equal(VERSION);
    // An upgrade: the older version Claude recorded is replaced, so the what's-new summary does not show.
    should(seeded({ lastReleaseNotesSeen: '2.1.200' }).lastReleaseNotesSeen).equal(VERSION);
  });

  it('3. should assert no release-notes key when the installed version is not known', () => {
    should(seeded(undefined, null)).not.have.property('lastReleaseNotesSeen');
    should(seeded({ lastReleaseNotesSeen: '2.1.200' }, null).lastReleaseNotesSeen).equal('2.1.200');
  });

  it('4. should trust the ferret’s working folder only, in its own project entry (already seeded by O11)', () => {
    const json = seeded(undefined) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    should(Object.keys(json.projects)).eql([FOLDER]);
    should(json.projects[FOLDER]?.hasTrustDialogAccepted).equal(true);
  });

  it('should write every key into the ferret’s own .claude.json document and into no settings file', () => {
    const home = homeText({
      folder: FOLDER,
      permissionMode: 'skip',
      instructions: [],
      parts: [],
      settings: new Map(),
      hooks: new Map(),
    });
    for (const key of ['lspRecommendationDisabled', 'claudeCodeHints', 'lastReleaseNotesSeen']) {
      should(JSON.parse(home.settings)).not.have.property(key);
      should(JSON.parse(home.overlay)).not.have.property(key);
    }
  });
});

describe('the launch environment (O11b)', () => {
  it('5. should disable the feedback survey', () => {
    should(assignments(argv())).containEql('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1');
  });

  it('6. should disable the inline-shell rm prompt (rm inside bash -c / sh -c)', () => {
    should(assignments(argv())).containEql('CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT=1');
  });

  it('7. should disable the mounted-drive rm prompt', () => {
    should(assignments(argv())).containEql('CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT=1');
  });

  it('5-7. should set them in both permission modes', () => {
    for (const permissionMode of ['auto', 'skip'] as const)
      for (const name of [
        'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
        'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT=1',
        'CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT=1',
      ])
        should(assignments(argv({ permissionMode }))).containEql(name);
  });

  it('8. should unset CLAUDE_CODE_CHILD_SESSION for the launched Claude, before any assignment', () => {
    const command = argv();
    should(command.slice(0, 3)).eql(['env', '-u', 'CLAUDE_CODE_CHILD_SESSION']);
    // `env -u` removes it whatever the parent environment holds, and nothing sets it back.
    should(assignments(command).some(word => word.startsWith('CLAUDE_CODE_CHILD_SESSION'))).equal(false);
  });

  it('9. should not set the full rm waiver by default, in either mode', () => {
    const waiver = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1';
    should(assignments(argv({ permissionMode: 'skip' }))).not.containEql(waiver);
    should(assignments(argv({ permissionMode: 'skip', dangerousRmWaiver: false }))).not.containEql(waiver);
    should(assignments(argv({ permissionMode: 'auto', dangerousRmWaiver: false }))).not.containEql(waiver);
  });

  it('9. should set the full rm waiver only with the setting on AND bypass mode', () => {
    const waiver = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1';
    should(assignments(argv({ permissionMode: 'skip', dangerousRmWaiver: true }))).containEql(waiver);
    should(assignments(argv({ permissionMode: 'auto', dangerousRmWaiver: true }))).not.containEql(waiver);
  });

  it('9. should default the setting to false and hold an agent edit that turns it on', () => {
    should(HarnessConfigSchema.parse({}).dangerousRmWaiver).equal(false);
    const off = HarnessConfigSchema.parse({});
    const on = HarnessConfigSchema.parse({ dangerousRmWaiver: true });
    const held = CLAUDE_CODE_CONFIG.loosens;
    should(held(off, on)).have.length(1);
    should(held(undefined, on)).have.length(1);
    // Turning it off, or leaving it as it is, loosens nothing.
    should(held(on, off)).eql([]);
    should(held(on, on)).eql([]);
    should(held(off, off)).eql([]);
  });
});

describe('what the fixed layer never writes (O11b, invariant 10)', () => {
  const bashRule = (rule: unknown): boolean => typeof rule === 'string' && /^Bash(\(|$)/u.test(rule);

  /** Every `permissions.deny` / `permissions.ask` rule and every hook event the generated documents carry. */
  const surveyed = (permissionMode: 'auto' | 'skip') => {
    const layer = fixedLayer(permissionMode, FOLDER);
    const text = homeText({
      folder: FOLDER,
      permissionMode,
      instructions: [],
      parts: [],
      settings: new Map(),
      hooks: new Map(),
    });
    return [layer.settings, layer.overlay, JSON.parse(text.settings), JSON.parse(text.overlay)] as Record<
      string,
      unknown
    >[];
  };

  it('should carry no Bash deny or ask rule, and no deny or ask list at all, in either mode', () => {
    for (const permissionMode of ['auto', 'skip'] as const)
      for (const document of surveyed(permissionMode)) {
        const permissions = (document.permissions ?? {}) as Record<string, unknown>;
        for (const list of ['deny', 'ask'] as const) {
          const rules = (permissions[list] ?? []) as unknown[];
          should(rules.filter(bashRule)).eql([]);
          should(rules).eql([]);
        }
      }
  });

  // A PermissionRequest hook (like a Bash deny/ask rule) silently voids the rm waivers. A PreToolUse hook is allowed:
  // the question hook is one, and the rm guard's own (O14) may add another.
  it('should carry no PermissionRequest hook, in either mode', () => {
    for (const permissionMode of ['auto', 'skip'] as const)
      for (const document of surveyed(permissionMode)) {
        const hooks = (document.hooks ?? {}) as Record<string, unknown[]>;
        should(Object.keys(hooks)).not.containEql('PermissionRequest');
      }
  });

  it('should still carry the question hook as a PreToolUse hook on AskUserQuestion', () => {
    should(Object.keys(CLAUDE_QUESTION_HOOKS)).containEql('PreToolUse');
    should(CLAUDE_QUESTION_HOOKS.PreToolUse.map(group => group.matcher)).containEql('AskUserQuestion');
  });
});

describe('the process Claude is exec’d as (O11b, keys 5-9 end to end)', () => {
  /** A stand-in for `claude` that prints what it was started with, so the argv is proved by running it. */
  const run = async (
    parent: Record<string, string>,
    options: { permissionMode?: 'auto' | 'skip'; dangerousRmWaiver?: boolean },
  ): Promise<Record<string, string>> => {
    const folder = mkdtempSync(join(tmpdir(), 'fy-o11b-'));
    try {
      const binary = join(folder, 'claude');
      writeFileSync(
        binary,
        '#!/bin/sh\nfor n in CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS; do\n  eval "v=\\${$n-unset}"\n  echo "$n=$v"\ndone\n',
        { mode: 0o755 },
      );
      const command = launchCommand({
        binary,
        home: folder,
        permissionMode: options.permissionMode ?? 'skip',
        ...(options.dangerousRmWaiver === undefined ? {} : { dangerousRmWaiver: options.dangerousRmWaiver }),
        hasMcp: false,
        questionTool: false,
        conversation: { kind: 'new', id: 'c-1' },
      });
      const child = Bun.spawn([...command], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...parent },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(child.stdout).text();
      await child.exited;
      return Object.fromEntries(
        out
          .trim()
          .split('\n')
          .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  it('should remove CLAUDE_CODE_CHILD_SESSION even when the parent environment has it, and set 5-7', async () => {
    const seen = await run({ CLAUDE_CODE_CHILD_SESSION: '1' }, {});
    should(seen.CLAUDE_CODE_CHILD_SESSION).equal('unset');
    should(seen.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).equal('1');
    should(seen.CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT).equal('1');
    should(seen.CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT).equal('1');
    should(seen.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).equal('unset');
  });

  it('should give the full waiver only with the setting on and bypass mode', async () => {
    const waiver = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
    should((await run({}, { dangerousRmWaiver: true }))[waiver]).equal('1');
    should((await run({}, { dangerousRmWaiver: true, permissionMode: 'auto' }))[waiver]).equal('unset');
    should((await run({}, { dangerousRmWaiver: false }))[waiver]).equal('unset');
  });
});

describe('the fixed rm instruction (O11b, key 12)', () => {
  it('should be declared by this plugin for Claude ferrets only and say the one sentence', () => {
    const declared = manifest.instructions?.find(entry => entry.id === 'rm-targets');
    should(declared?.when).eql({ role: 'any', harness: 'claude-code' });
    const text = readFileSync(join(import.meta.dir, '../../../', declared?.text ?? 'missing'), 'utf8');
    should(text).containEql(
      'Write rm targets as explicit absolute paths; never "$VAR"/…, a $(cmd)-derived variable, or rm inside bash -c, so the dangerous-rm guard does not stop you.',
    );
  });
});
