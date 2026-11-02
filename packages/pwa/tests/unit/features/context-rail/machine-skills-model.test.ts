import { describe, expect, it } from 'bun:test';
import { FyTransportError } from '@ferretry/protocol/client';
import {
  copiedLine,
  filterMachineRows,
  localRefusal,
  machineRows,
  originLine,
  previewRequest,
  rowFromLine,
  skippedLines,
  targetOptions,
} from '../../../../src/features/context-rail/machine-skills-model.ts';
import {
  CODEX_PATH,
  CREDENTIAL_SENTENCE,
  DEPLOY_PATH,
  localPreview,
  MACHINE,
  PDF_PATH,
  refusal,
} from '../../../support/local-skills.ts';
import { SKILLS } from './context-rail-fixtures.ts';

const none = new Set<string>();

describe('which skills the machine group lists', () => {
  it('lists each skill of another account or project once, leaving out what the session has', () => {
    const rows = machineRows(MACHINE, SKILLS, none);
    expect(rows.map(row => row.name)).toEqual(['pdf-tools', 'lint-fix', 'deploy-notes']);
    expect(rows.map(row => row.from)).toEqual(['claude-play account', 'codex-play account', 'project api']);
  });

  it('leaves out a skill the session lists by path, even under another name', () => {
    const session = { ...SKILLS, skills: [{ ...SKILLS.skills[0]!, name: 'renamed', path: PDF_PATH }] };
    expect(machineRows(MACHINE, session, none).map(row => row.name)).not.toContain('pdf-tools');
  });

  it('marks the skills a copy was already made from', () => {
    const rows = machineRows(MACHINE, SKILLS, new Set([PDF_PATH]));
    expect(rows.map(row => [row.name, row.installed])).toEqual([
      ['pdf-tools', true],
      ['lint-fix', false],
      ['deploy-notes', false],
    ]);
  });

  it('shows a hidden character in a name as a marker, not as nothing', () => {
    const hidden = {
      ...MACHINE,
      homes: [],
      projects: [
        {
          ...MACHINE.projects[0]!,
          skills: [{ ...MACHINE.projects[0]!.skills[0]!, name: 'ok‮name', path: '/work/api/x/SKILL.md' }],
        },
      ],
    };
    expect(machineRows(hidden, SKILLS, none)[0]?.name).not.toContain('‮');
  });
});

describe('narrowing by what is typed', () => {
  const rows = machineRows(MACHINE, SKILLS, none);

  it('keeps every row for an empty search', () => {
    expect(filterMachineRows(rows, '   ')).toBe(rows);
  });

  it('keeps the rows whose name, description or place hold every word', () => {
    expect(filterMachineRows(rows, 'pdf').map(row => row.name)).toEqual(['pdf-tools']);
    expect(filterMachineRows(rows, 'release notes').map(row => row.name)).toEqual(['deploy-notes']);
    expect(filterMachineRows(rows, 'project api').map(row => row.name)).toEqual(['deploy-notes']);
    expect(filterMachineRows(rows, 'pdf nothing')).toEqual([]);
  });
});

describe('what a row and a preview say', () => {
  const row = machineRows(MACHINE, SKILLS, none)[1]!;

  it('names where the skill lives and for which agent', () => {
    expect(rowFromLine(row)).toBe('codex-play account · Codex');
    expect(rowFromLine({ from: 'project api', harness: 'claude' })).toBe('project api · Claude');
  });

  it('asks the preview for exactly the listed path and the chosen place', () => {
    const target = { scope: 'project', projectRoot: '/work/app', harness: 'claude' } as const;
    expect(previewRequest(row, target)).toEqual({ source: { path: CODEX_PATH }, target });
  });

  it('offers the known projects and runtimes as places', () => {
    expect(
      targetOptions(
        [{ name: 'app', path: '/work/app' }],
        [{ id: 'rt-work', wrapper: 'claude-work', profile: 'default' }],
      ),
    ).toEqual({
      projects: [{ root: '/work/app', label: 'app' }],
      runtimes: [{ runtime: 'rt-work', profiles: ['default'] }],
    });
  });

  it('says where the preview read the skill from', () => {
    expect(originLine(localPreview().origin)).toBe(`Account claude-play · Claude · ${PDF_PATH}`);
    expect(originLine({ kind: 'project', owner: '/work/api', harness: 'codex', path: DEPLOY_PATH })).toBe(
      `Project /work/api · Codex · ${DEPLOY_PATH}`,
    );
  });

  it('says each file left behind with the reason the machine gave', () => {
    const preview = localPreview({ skipped: [{ subject: 'logo.png', reason: 'not text' }] });
    expect(skippedLines(preview)).toEqual(['logo.png: not text']);
    expect(skippedLines(localPreview())).toEqual([]);
  });

  it('says what landed', () => {
    expect(copiedLine({ name: 'pdf-tools' })).toBe('pdf-tools · copied');
  });
});

describe('what a refusal says', () => {
  it('shows the credential sentence as the machine wrote it', () => {
    expect(localRefusal(refusal('local_skill_source_invalid', CREDENTIAL_SENTENCE))).toEqual({
      sentence: CREDENTIAL_SENTENCE,
      previewAgain: false,
    });
    expect(localRefusal(refusal('local_skill_source_invalid', ' ')).sentence).toBe(
      'This skill cannot be copied. Nothing was installed.',
    );
  });

  it('asks for the passkey again when it was not confirmed', () => {
    expect(localRefusal(refusal('grant_step_up_required', 'step up', 403)).sentence).toContain(
      'the passkey wasn’t confirmed',
    );
  });

  it('says the preview is gone or ran out, and offers to preview again', () => {
    const gone = localRefusal(refusal('local_skill_preview_unknown', 'x', 404));
    expect(gone).toEqual({
      sentence: 'That preview is gone. Nothing was installed. Preview it again.',
      previewAgain: true,
    });
    const expired = localRefusal(refusal('local_skill_preview_expired', 'x', 410));
    expect(expired.sentence).toContain('ran out after 10 minutes');
    expect(expired.previewAgain).toBe(true);
  });

  it('adds the machine’s reason to the general sentence, when it gave one', () => {
    expect(localRefusal(refusal('local_skill_source_unknown', 'No skill at that path.', 404)).sentence).toBe(
      'This machine no longer lists that skill. Nothing was installed. No skill at that path.',
    );
    expect(localRefusal(refusal('local_skill_source_unknown', '', 404)).sentence).toBe(
      'This machine no longer lists that skill. Nothing was installed.',
    );
    expect(localRefusal(refusal('local_skill_target_unknown', 'No project /x.', 404)).sentence).toContain(
      'Pick another place.',
    );
    expect(localRefusal(refusal('local_skill_conflict', 'A folder is there.', 409)).sentence).toContain(
      'Something is already where this would go. Nothing was changed. A folder is there.',
    );
  });

  it('falls back to the app’s general words for anything else', () => {
    expect(localRefusal(refusal('something_else', 'The machine said no.', 500)).sentence).toBe('The machine said no.');
    expect(localRefusal(new FyTransportError('offline', '/v1/skills', false, new Error('down'))).sentence).toContain(
      'couldn’t reach',
    );
    expect(localRefusal(new FyTransportError('offline', '/v1/skills', false, new Error('down'))).previewAgain).toBe(
      false,
    );
  });
});
