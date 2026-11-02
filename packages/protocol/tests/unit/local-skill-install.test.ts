import { describe, it } from 'bun:test';
import should from 'should';
import {
  LOCAL_SKILL_INSTALLS_PATH,
  LOCAL_SKILL_PREVIEW_TTL_SECONDS,
  LOCAL_SKILL_REFUSALS,
  LocalSkillInstallIdSchema,
  LocalSkillInstallRequestSchema,
  LocalSkillPreviewIdSchema,
  LocalSkillPreviewRequestSchema,
  LocalSkillRefusalSchema,
  localSkillInstallsPath,
} from '../../src/lib/local-skill-install.ts';

describe('copying a skill from this machine, on the wire', () => {
  it('has a route for each scope and a preview of each', () => {
    should(LOCAL_SKILL_INSTALLS_PATH).equal('/v1/skill-installs/local');
    should(localSkillInstallsPath('project')).equal('/v1/skill-installs/local/project');
    should(localSkillInstallsPath('runtime', true)).equal('/v1/skill-installs/local/runtime/preview');
  });

  it('gives a preview ten minutes, as a catalog install does', () => {
    should(LOCAL_SKILL_PREVIEW_TTL_SECONDS).equal(600);
  });

  it('spells its ids lsp_ and lsi_ with 22 base64url characters', () => {
    should(LocalSkillPreviewIdSchema.safeParse(`lsp_${'a'.repeat(22)}`).success).be.true();
    should(LocalSkillPreviewIdSchema.safeParse(`lsi_${'a'.repeat(22)}`).success).be.false();
    should(LocalSkillInstallIdSchema.safeParse(`lsi_${'a-_'.repeat(7)}a`).success).be.true();
    should(LocalSkillInstallIdSchema.safeParse(`lsi_${'a'.repeat(21)}`).success).be.false();
  });

  it('takes a preview request with a source path and a target, and nothing else', () => {
    const request = {
      source: { path: '/home/me/.claude/skills/demo/SKILL.md' },
      target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
    };

    should(LocalSkillPreviewRequestSchema.safeParse(request).success).be.true();
    should(LocalSkillPreviewRequestSchema.safeParse({ ...request, extra: 1 }).success).be.false();
    should(LocalSkillPreviewRequestSchema.safeParse({ ...request, source: { path: 'relative' } }).success).be.false();
  });

  it('applies by preview id alone', () => {
    should(LocalSkillInstallRequestSchema.safeParse({ previewId: `lsp_${'a'.repeat(22)}` }).success).be.true();
    should(
      LocalSkillInstallRequestSchema.safeParse({ previewId: `lsp_${'a'.repeat(22)}`, secretBindings: {} }).success,
    ).be.false();
  });

  it('names seven refusals', () => {
    should(LOCAL_SKILL_REFUSALS).have.length(7);
    for (const code of LOCAL_SKILL_REFUSALS) should(LocalSkillRefusalSchema.safeParse(code).success).be.true();
    should(LocalSkillRefusalSchema.safeParse('catalog_downgrade').success).be.false();
  });
});
