import { describe, it } from 'bun:test';
import should from 'should';
import { LocalSkillRefusalError } from '../../../src/lib/local-skill-installs/ports.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  LocalSkillInstallStateError,
  LocalSkillInstallStateSchema,
} from '../../../src/lib/local-skill-installs/store.ts';

const SHA = 'a'.repeat(64);
const record = {
  installId: `lsi_${'i'.repeat(22)}`,
  installedAt: '2026-11-02T09:00:00.000Z',
  name: 'demo',
  origin: { kind: 'account', owner: 'claude-work', harness: 'claude', path: '/h/skills/demo/SKILL.md' },
  provenance: {
    publisher: `fy_daemon_${'0'.repeat(43)}`,
    publisherName: 'This machine',
    catalogId: `cat_${'0'.repeat(22)}`,
    catalogName: 'Skills on this machine',
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'demo',
    version: 1,
    digest: `sha256:${SHA}`,
  },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
  destination: '/srv/app/.claude/skills/demo/ (1 file)',
  key: 'project:/srv/app/.claude/skills/demo',
  files: [{ path: '.claude/skills/demo/SKILL.md', sha256: SHA }],
  root: '/srv/app',
  folder: '.claude/skills/demo',
};

describe('what the machine remembers about skills copied from itself', () => {
  it('is empty at first, and the empty state parses', () => {
    should(LocalSkillInstallStateSchema.safeParse(EMPTY_LOCAL_SKILL_INSTALL_STATE).success).be.true();
    should(EMPTY_LOCAL_SKILL_INSTALL_STATE.installs).deepEqual([]);
  });

  it('parses a record, with and without the runtime component hash', () => {
    const runtime = {
      ...record,
      target: { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
      componentSha256: SHA,
    };
    for (const one of [record, runtime])
      should(LocalSkillInstallStateSchema.safeParse({ schemaVersion: 1, installs: [one] }).success).be.true();
  });

  it('refuses a record with a field it does not know or a hash that is not one', () => {
    for (const bad of [
      { ...record, extra: 1 },
      { ...record, files: [{ path: 'x', sha256: 'nope' }] },
    ])
      should(LocalSkillInstallStateSchema.safeParse({ schemaVersion: 1, installs: [bad] }).success).be.false();
  });

  it('names a damaged file by its own error', () => {
    const error = new LocalSkillInstallStateError('damaged');

    should(error).be.instanceOf(Error);
    should(error.name).equal('LocalSkillInstallStateError');
    should(error.message).equal('damaged');
  });
});

describe('the errors the local copy service speaks in', () => {
  it('a refusal carries its code from the contract and its sentence', () => {
    const error = new LocalSkillRefusalError('local_skill_conflict', 'in the way');

    should(error).be.instanceOf(Error);
    should(error.code).equal('local_skill_conflict');
    should(error.message).equal('in the way');
    should(error.name).equal('LocalSkillRefusalError');
  });
});
