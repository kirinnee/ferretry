import { describe, it } from 'bun:test';
import type { SkillEntry } from '../../contract/index.ts';
import should from 'should';
import { LocalSkillRefusalError, SkillFolderRefused } from '../../daemon/lib/installs/ports.ts';
import {
  ACCOUNT_SKILL,
  CALLER,
  copy,
  FLEET_DIRECTORY,
  PROJECT_SKILL,
  projectTarget,
  rig,
  ROOT,
  runtimeTarget,
  SKILL_MD,
} from './installs-support.ts';

const refusedWith = async (work: Promise<unknown>, code: string): Promise<LocalSkillRefusalError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(LocalSkillRefusalError);
  should((error as LocalSkillRefusalError).code).equal(code);
  return error as LocalSkillRefusalError;
};

describe('previewing a skill from this machine', () => {
  it('answers the review of every file in full and writes nothing', async () => {
    const r = rig();

    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    should(preview.name).equal('demo');
    should(preview.origin).deepEqual({
      kind: 'account',
      owner: 'claude-work',
      harness: 'claude-code',
      path: ACCOUNT_SKILL,
    });
    should(preview.provenance.publisherName).equal('This machine');
    should(preview.destination).equal(`${ROOT}/.claude/skills/demo/ (2 files)`);
    should(preview.review.length).be.above(0);
    should(JSON.stringify(preview.review)).containEql('notes');
    should(preview.skipped.map(problem => problem.subject)).deepEqual(['link']);
    should(preview.replaces).be.undefined();
    should(r.folders.folders.size).equal(0);
    should(r.store.writes).equal(0);
    should(r.previews.size).equal(1);
  });

  it('names a project skill by its project, and says "file" for one file', async () => {
    const r = rig();

    const preview = await r.service.preview(
      'project',
      { source: { path: PROJECT_SKILL }, target: projectTarget('codex', `${ROOT}/`) },
      CALLER,
    );

    should(preview.origin).deepEqual({
      kind: 'project',
      owner: '/work/other',
      harness: 'claude-code',
      path: PROJECT_SKILL,
    });
    should(preview.destination).equal(`${ROOT}/.agents/skills/tool/ (1 file)`);
    should(preview.target).deepEqual({ scope: 'project', projectRoot: ROOT, harness: 'codex' });
  });

  it('says "this machine" for an account that no runtime launches into', async () => {
    const r = rig();
    r.skills = [{ ...(r.skills[0] as SkillEntry), runtimes: [] }];

    const preview = await r.service.preview(
      'runtime',
      { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() },
      CALLER,
    );

    should(preview.origin.owner).equal('this machine');
  });

  it('spells a runtime by its name even when asked by its id', async () => {
    const r = rig();

    const preview = await r.service.preview(
      'runtime',
      { source: { path: ACCOUNT_SKILL }, target: runtimeTarget('rt-claude') },
      CALLER,
    );

    should(preview.target).deepEqual(runtimeTarget('claude-work'));
    should(preview.destination).equal(
      'the skill demo in profile work (every runtime on that profile gets it, not only claude-work, and it replaces an earlier copy)',
    );
  });

  it('refuses a scope that is not the target’s', async () => {
    const r = rig();

    await refusedWith(
      r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_target_unknown',
    );
  });

  it('refuses a path the inventory does not list', async () => {
    const r = rig();

    await refusedWith(
      r.service.preview('project', { source: { path: '/etc/passwd' }, target: projectTarget() }, CALLER),
      'local_skill_source_unknown',
    );
  });

  it('refuses a skill whose folder name is not a catalog name', async () => {
    const r = rig();
    const path = '/home/me/.claude/skills/my skill/SKILL.md';
    r.skills = [{ ...(r.skills[0] as SkillEntry), path }];

    await refusedWith(
      r.service.preview('project', { source: { path }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );
  });

  it('refuses a folder that has gone since the inventory listed it', async () => {
    const r = rig();
    r.tree.folders.delete(ACCOUNT_SKILL);

    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );
  });

  it('reads an account skill under the fleet directory and a project skill under its project root', async () => {
    const r = rig();

    await r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER);
    await r.service.preview('project', { source: { path: PROJECT_SKILL }, target: projectTarget() }, CALLER);

    const boundaryOf = (manifest: string) =>
      new Set(r.tree.boundaries.filter(call => call.manifest === manifest).map(call => call.confinedTo));
    should([...boundaryOf(ACCOUNT_SKILL)]).deepEqual([FLEET_DIRECTORY]);
    should([...boundaryOf(PROJECT_SKILL)]).deepEqual(['/work/other']);
  });

  it('refuses a folder that now resolves outside the boundary it was listed under', async () => {
    const r = rig();
    r.tree.resolveTo(PROJECT_SKILL, '/etc/elsewhere');

    const refusal = await refusedWith(
      r.service.preview('project', { source: { path: PROJECT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );

    should(refusal.message).match(/cannot be read any more/u);
    should(r.previews.size).equal(0);
  });

  it('still copies a folder that resolves inside its boundary', async () => {
    const r = rig();
    r.tree.resolveTo(ACCOUNT_SKILL, `${FLEET_DIRECTORY}/assets/skills/demo`);

    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    should(preview.name).equal('demo');
  });

  it('refuses a folder whose files cannot make a skill', async () => {
    const r = rig();
    r.tree.set(ACCOUNT_SKILL, { 'notes.txt': 'no entry file' });

    const refusal = await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );

    should(refusal.message).match(/cannot be carried/u);
  });

  it('refuses a folder the reader hands back without a SKILL.md even when it states no refusal', async () => {
    const r = rig();
    r.tree.read = async () => ({ files: [{ path: 'notes.txt', content: 'no entry file' }], problems: [] });

    const refusal = await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );

    should(refusal.message).equal('demo cannot be copied: it has no SKILL.md among the files it can carry.');
  });

  it('refuses to copy a file that holds a password, naming it and never showing it', async () => {
    const r = rig();
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'setup.sh': 'curl https://me:hunter2hunter2@example.com/x' });

    const refusal = await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );

    should(refusal.message).equal(
      'setup.sh line 1 holds what looks like a password or key. Remove it, then copy the skill.',
    );
    should(refusal.message).not.match(/hunter2/u);
  });

  it('refuses a long value assigned to a secret-looking name', async () => {
    const r = rig();
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'run.sh': 'export API_KEY="abcdef0123456789abcdef"' });

    await refusedWith(
      r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER),
      'local_skill_source_invalid',
    );
  });

  it('names the line of the password, even when a line break split it, and never the value', async () => {
    const r = rig();
    const preview = () =>
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER);
    r.tree.set(ACCOUNT_SKILL, {
      'SKILL.md': SKILL_MD,
      'a/run.sh': '# setup\r\n\r\napi_key = "sk-abcdef0123456789abcdef"\n',
    });
    const spaced = await refusedWith(preview(), 'local_skill_source_invalid');
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'conf.yaml': 'name: demo\ntoken:\n  abcdef0123456789abcdef\n' });
    const split = await refusedWith(preview(), 'local_skill_source_invalid');

    should(spaced.message).equal(
      'a/run.sh line 3 holds what looks like a password or key. Remove it, then copy the skill.',
    );
    should(split.message).equal(
      'conf.yaml line 2 holds what looks like a password or key. Remove it, then copy the skill.',
    );
    should(spaced.message + split.message).not.match(/abcdef/u);
  });

  it('refuses a skill with more files than a destination holds, and copes with exactly that many', async () => {
    const r = rig();
    const files = (count: number) =>
      Object.fromEntries([['SKILL.md', SKILL_MD], ...Array.from({ length: count - 1 }, (_, n) => [`f${n}.txt`, 'x'])]);
    r.tree.set(ACCOUNT_SKILL, files(65));

    const refusal = await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_source_invalid',
    );
    r.tree.set(ACCOUNT_SKILL, files(64));
    const fits = await r.service.preview(
      'runtime',
      { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() },
      CALLER,
    );

    should(refusal.message).equal(
      'demo has 65 files and a skill folder here holds at most 64, so a copy could never be removed or updated. Take some files out, then copy the skill.',
    );
    should(fits.review.length).be.above(0);
  });

  it('warns, per file, where a file mentions keys, tokens or passwords, and still shows it whole', async () => {
    const r = rig();
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'notes.md': 'Set your token in the settings first.' });

    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    const warning = preview.warnings.find(item => item.text.startsWith('notes.md '));
    should(warning?.code).equal('possible-secret');
    should(warning?.text).equal(
      `notes.md mentions keys, tokens or passwords. Check it holds no secret value before you copy it to ${preview.destination}.`,
    );
    should(preview.warnings.some(item => item.text.startsWith('SKILL.md '))).be.false();
    should(preview.review.some(entry => entry.text.includes('Set your token in the settings first.'))).be.true();
  });

  it('refuses a project this machine does not know', async () => {
    const r = rig();

    for (const projectRoot of ['/elsewhere', '/work']) {
      await refusedWith(
        r.service.preview(
          'project',
          { source: { path: ACCOUNT_SKILL }, target: projectTarget('claude-code', projectRoot) },
          CALLER,
        ),
        'local_skill_target_unknown',
      );
    }
  });

  it('refuses a runtime or profile it does not know, or that do not go together', async () => {
    const r = rig();

    for (const target of [
      runtimeTarget('nope'),
      runtimeTarget('claude-work', 'nope'),
      runtimeTarget('claude-work', 'play'),
    ])
      await refusedWith(
        r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target }, CALLER),
        'local_skill_target_unknown',
      );
  });

  it('refuses files at the destination that no copy of ours wrote', async () => {
    const r = rig();
    r.folders.folders.set(`${ROOT}/.claude/skills/demo`, new Map([['SKILL.md', 'mine']]));

    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('refuses a folder it cannot read as a conflict, and lets another error through', async () => {
    const r = rig();
    r.folders.refuse = 'a link is in the way';
    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_conflict',
    );

    r.folders.refuse = undefined;
    r.folders.fail = new TypeError('disk');
    await r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER).then(
      () => should.fail('', '', 'should refuse'),
      (error: unknown) => should(error).be.instanceOf(TypeError),
    );
  });
});

describe('copying into a project', () => {
  it('writes exactly the previewed files, records each hash, and spends the preview', async () => {
    const r = rig();

    const { preview, installed } = await copy(r, projectTarget());

    should([...(r.folders.folders.get(`${ROOT}/.claude/skills/demo`) ?? new Map()).keys()].sort()).deepEqual([
      'SKILL.md',
      'notes.txt',
    ]);
    should(installed.install.files.map(file => file.path)).deepEqual([
      '.claude/skills/demo/SKILL.md',
      '.claude/skills/demo/notes.txt',
    ]);
    should(installed.install.files[0]?.sha256).match(/^[0-9a-f]{64}$/u);
    should(installed.install.destination).equal(preview.destination);
    should(installed.notes).deepEqual([]);
    should((await r.service.list()).installs.map(install => install.installId)).deepEqual([
      installed.install.installId,
    ]);
    await refusedWith(r.service.apply('project', preview.previewId, CALLER), 'local_skill_preview_unknown');
  });

  it('writes what was reviewed even when the source changed after the preview', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': `${SKILL_MD}changed\n` });

    await r.service.apply('project', preview.previewId, CALLER);

    should(r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.get('SKILL.md')).equal(SKILL_MD);
    should(r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.has('notes.txt')).be.true();
  });

  it('does not let another caller apply a preview', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    await refusedWith(r.service.apply('project', preview.previewId, { id: 'host' }), 'local_skill_preview_unknown');
  });

  it('refuses a preview that ran out of time', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );
    r.clock.now += 601_000;

    await refusedWith(r.service.apply('project', preview.previewId, CALLER), 'local_skill_preview_expired');
  });

  it('refuses a preview for the other scope', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    await refusedWith(r.service.apply('runtime', preview.previewId, CALLER), 'local_skill_preview_unknown');
  });

  it('judges the destination again at apply: something that appeared since the preview is a conflict', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );
    r.folders.folders.set(`${ROOT}/.claude/skills/demo`, new Map([['SKILL.md', 'mine']]));

    await refusedWith(r.service.apply('project', preview.previewId, CALLER), 'local_skill_conflict');
    should(r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.get('SKILL.md')).equal('mine');
  });

  it('refuses when the folder changes under the write', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );
    r.folders.racing = true;

    await refusedWith(r.service.apply('project', preview.previewId, CALLER), 'local_skill_conflict');
  });

  it('replaces its own copy, prunes the files the new one lacks, and keeps one record', async () => {
    const r = rig();
    const first = await copy(r, projectTarget());
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'other.txt': 'second' });

    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );
    const second = await r.service.apply('project', preview.previewId, CALLER);

    should(preview.replaces).deepEqual({ installId: first.installed.install.installId });
    should([...(r.folders.folders.get(`${ROOT}/.claude/skills/demo`) ?? new Map()).keys()].sort()).deepEqual([
      'SKILL.md',
      'other.txt',
    ]);
    should((await r.service.list()).installs.map(install => install.installId)).deepEqual([second.install.installId]);
  });

  it('refuses to replace a file of its own that was edited since', async () => {
    const r = rig();
    await copy(r, projectTarget());
    r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.set('notes.txt', 'edited');

    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('refuses to replace over a file that no copy of ours wrote', async () => {
    const r = rig();
    await copy(r, projectTarget());
    r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.set('mine.txt', 'mine');

    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('keeps a copy in each project and each harness apart', async () => {
    const r = rig();
    r.roots.push('/work/second');

    await copy(r, projectTarget('claude-code'));
    await copy(r, projectTarget('codex'));
    await copy(r, projectTarget('claude-code', '/work/second'));

    should((await r.service.list()).installs).have.length(3);
  });
});

describe('copying into a runtime', () => {
  it('hands the fleet one install with the synthetic provenance, and records the stored component', async () => {
    const r = rig();

    const { installed } = await copy(r, runtimeTarget());

    const change = r.fleet.proposed[0] as unknown as {
      kind: string;
      name: string;
      profile: string;
      replace: boolean;
      installedFrom: { publisherName: string; catalogName: string };
      files: { path: string }[];
    };
    should(change.kind).equal('catalog.install');
    should(change.name).equal('demo');
    should(change.profile).equal('work');
    should(change.replace).be.false();
    should(change.installedFrom.publisherName).equal('This machine');
    should(change.installedFrom.catalogName).equal('Skills on this machine');
    should(change.files.map(file => file.path).sort()).deepEqual(['SKILL.md', 'notes.txt']);
    should(installed.install.files.map(file => file.path)).deepEqual(['skills/demo/SKILL.md', 'skills/demo/notes.txt']);
    should(installed.notes[0]).match(/next time it starts/u);
    should(r.store.state.installs[0]?.componentSha256).match(/^[0-9a-f]{64}$/u);
  });

  it('gives the same item id to every copy of one skill, and a new digest to a changed one', async () => {
    const r = rig();
    const first = (
      await r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER)
    ).provenance;
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': `${SKILL_MD}more\n` });
    const second = (
      await r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER)
    ).provenance;

    should(second.itemId).equal(first.itemId);
    should(second.digest).not.equal(first.digest);
  });

  it('refuses a skill the machine already has that no copy of ours made', async () => {
    const r = rig();
    r.fleet.components.set('skills', [{ name: 'demo' }]);

    await refusedWith(
      r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('refuses files in the runtime store that no copy of ours wrote', async () => {
    const r = rig();
    r.folders.folders.set('runtime/demo', new Map([['SKILL.md', 'mine']]));

    await refusedWith(
      r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('replaces its own copy, and takes away the files the new one lacks', async () => {
    const r = rig();
    await copy(r, runtimeTarget());
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD });

    const { preview, installed } = await copy(r, runtimeTarget());

    should(preview.replaces).not.be.undefined();
    should((r.fleet.proposed[1] as unknown as { replace: boolean }).replace).be.true();
    should([...(r.folders.folders.get('runtime/demo') ?? new Map()).keys()]).deepEqual(['SKILL.md']);
    should(installed.notes).have.length(1);
  });

  it('still records the copy when a file of the earlier one cannot be taken away, and says so', async () => {
    const r = rig();
    await copy(r, runtimeTarget());
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD });
    r.runtimeSkills.failRemove = new Error('busy');

    const { installed } = await copy(r, runtimeTarget());

    should(installed.notes[0]).match(/A file from the earlier copy could not be removed/u);
    should(installed.notes[0]).match(/notes\.txt/u);
    should((await r.service.list()).installs).have.length(1);
  });

  it('says "files" when several cannot be taken away', async () => {
    const r = rig();
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'a.txt': 'a', 'b.txt': 'b' });
    await copy(r, runtimeTarget());
    r.tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD });
    r.runtimeSkills.failRemove = new Error('busy');

    const { installed } = await copy(r, runtimeTarget());

    should(installed.notes[0]).match(/Files from the earlier copy .* are still there/u);
  });

  it('refuses to replace a component that was edited since the copy', async () => {
    const r = rig();
    await copy(r, runtimeTarget());
    r.fleet.components.set('skills', [{ name: 'demo', detail: 'edited' }]);

    await refusedWith(
      r.service.preview('runtime', { source: { path: ACCOUNT_SKILL }, target: runtimeTarget() }, CALLER),
      'local_skill_conflict',
    );
  });

  it('passes the fleet’s own refusal on untouched', async () => {
    const r = rig();
    r.fleet.failApply = new Error('fleet said no');

    await copy(r, runtimeTarget()).then(
      () => should.fail('', '', 'should refuse'),
      (error: unknown) => should((error as Error).message).equal('fleet said no'),
    );
    should(r.store.state.installs).deepEqual([]);
  });
});

describe('a record that names another place', () => {
  const tampered = async (change: Record<string, unknown>) => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    const record = r.store.state.installs[0] as (typeof r.store.state.installs)[number];
    r.store.state = { ...r.store.state, installs: [{ ...record, ...change } as typeof record] };
    return { r, installed };
  };

  it.each([
    ['a root no project of ours has', { root: '/etc' }],
    ['a root that is missing', { root: undefined }],
    ['another folder', { folder: '.ssh' }],
    ['the folder of another skill', { folder: '.claude/skills/other' }],
    ['a folder that is missing', { folder: undefined }],
    ['a known root other than the one copied to', { root: '/work/other' }],
  ])('refuses to remove a copy whose record names %s, and removes nothing', async (_, change) => {
    const { r, installed } = await tampered(change);
    r.roots = [ROOT, '/work/other'];
    const before = structuredClone(r.folders.folders);

    await refusedWith(r.service.remove('project', installed.install.installId), 'local_skill_target_unknown');

    should(r.folders.folders).deepEqual(before);
    should((await r.service.list()).installs).have.length(1);
  });

  it('refuses to replace over a copy whose record names another place', async () => {
    const { r } = await tampered({ root: '/work/other' });
    r.roots = [ROOT, '/work/other'];

    await refusedWith(
      r.service.preview('project', { source: { path: ACCOUNT_SKILL }, target: projectTarget() }, CALLER),
      'local_skill_target_unknown',
    );
  });
});

describe('removing a copy', () => {
  it('takes away a project copy’s recorded files and its record', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());

    const removed = await r.service.remove('project', installed.install.installId);

    should(removed).deepEqual({
      installId: installed.install.installId,
      name: 'demo',
      destination: installed.install.destination,
    });
    should(r.folders.folders.size).equal(0);
    should((await r.service.list()).installs).deepEqual([]);
  });

  it('forgives a recorded file that is already gone', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.delete('notes.txt');

    await r.service.remove('project', installed.install.installId);

    should(r.folders.folders.size).equal(0);
  });

  it('refuses an id it does not have, or one of the other scope', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());

    await refusedWith(r.service.remove('project', `lsi_${'z'.repeat(22)}`), 'local_skill_install_unknown');
    await refusedWith(r.service.remove('runtime', installed.install.installId), 'local_skill_install_unknown');
  });

  it('refuses when a recorded file was edited, and removes nothing', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.set('notes.txt', 'edited');

    await refusedWith(r.service.remove('project', installed.install.installId), 'local_skill_conflict');
    should(r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.size).equal(2);
    should((await r.service.list()).installs).have.length(1);
  });

  it('leaves the folder alone when it holds a file no copy of ours wrote', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.set('mine.txt', 'mine');

    await refusedWith(r.service.remove('project', installed.install.installId), 'local_skill_conflict');
    should(r.folders.folders.get(`${ROOT}/.claude/skills/demo`)?.size).equal(3);
  });

  it('refuses when the folder changes under the removal', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    r.folders.racing = true;

    await refusedWith(r.service.remove('project', installed.install.installId), 'local_skill_conflict');
  });

  it('refuses a folder it cannot read', async () => {
    const r = rig();
    const { installed } = await copy(r, projectTarget());
    r.folders.fail = new SkillFolderRefused('a link is in the way');
    r.folders.refuse = 'a link is in the way';

    await refusedWith(r.service.remove('project', installed.install.installId), 'local_skill_conflict');
  });

  it('takes a runtime copy away through the fleet, component and files', async () => {
    const r = rig();
    const { installed } = await copy(r, runtimeTarget());

    await r.service.remove('runtime', installed.install.installId);

    should(r.fleet.proposed[1]).match({ kind: 'component.remove', componentKind: 'skills', name: 'demo' });
    should(r.fleet.components.get('skills')).deepEqual([]);
    should(r.folders.folders.size).equal(0);
    should((await r.service.list()).installs).deepEqual([]);
  });

  it('refuses to remove a component that was edited since the copy', async () => {
    const r = rig();
    const { installed } = await copy(r, runtimeTarget());
    r.fleet.components.set('skills', [{ name: 'demo', detail: 'edited' }]);

    await refusedWith(r.service.remove('runtime', installed.install.installId), 'local_skill_conflict');
    should(r.fleet.proposed).have.length(1);
  });

  it('forgets a runtime copy whose component and files are already gone', async () => {
    const r = rig();
    const { installed } = await copy(r, runtimeTarget());
    r.fleet.components.set('skills', []);
    r.folders.folders.clear();

    await r.service.remove('runtime', installed.install.installId);

    should(r.fleet.proposed).have.length(1);
    should((await r.service.list()).installs).deepEqual([]);
  });
});

describe('taking turns', () => {
  it('lets a later apply run after an earlier one failed', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      { source: { path: ACCOUNT_SKILL }, target: projectTarget() },
      CALLER,
    );

    const [first, second] = await Promise.allSettled([
      r.service.apply('project', `lsp_${'q'.repeat(22)}`, CALLER),
      r.service.apply('project', preview.previewId, CALLER),
    ]);

    should(first.status).equal('rejected');
    should(second.status).equal('fulfilled');
  });
});
