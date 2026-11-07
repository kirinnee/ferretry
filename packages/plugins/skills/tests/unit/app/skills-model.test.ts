import { describe, expect, it } from 'bun:test';
import {
  activeSkillsLine,
  appendSkillInvocation,
  copiedLine,
  initialDraft,
  installLine,
  filterMachineRows,
  loadedSkillCount,
  localRefusal,
  machineRows,
  previewRequest,
  referenceScope,
  skillChips,
  skillHarnessLabel,
  skillInsertText,
  skillNameOf,
  skillOverride,
  sortedSkills,
  splitFrontMatter,
  targetOptions,
  targetProblem,
  toTarget,
  visibleSkills,
} from '../../../app/lib/skills-model.ts';
import { ferretInventory, machineInventory, refusal, skill } from './skills-support.ts';

describe('the insertion contract', () => {
  it('inserts /name for Claude and $name for Codex, and says which', () => {
    expect(skillInsertText('claude-code', 'summary')).toBe('/summary');
    expect(skillInsertText('codex', 'summary')).toBe('$summary');
    expect(skillHarnessLabel('codex')).toBe('Codex · inserts $name');
    expect(skillHarnessLabel('claude-code')).toBe('Claude · inserts /name');
  });

  it('appends one invocation as a new token and keeps real content', () => {
    expect(appendSkillInvocation('', '/review')).toBe('/review ');
    expect(appendSkillInvocation('  ', '/review')).toBe('/review ');
    expect(appendSkillInvocation('look at this', '/review')).toBe('look at this /review ');
    expect(appendSkillInvocation('look at this ', '/review')).toBe('look at this /review ');
  });
});

describe('a ferret’s skills list', () => {
  const skills = [
    skill('zeta', { scope: 'user' }),
    skill('alpha', { scope: 'ferretry' }),
    skill('mid', { scope: 'project' }),
    skill('beta', { scope: 'user', shadowedBy: 'project' }),
  ];

  it('lists the winners first — Project, then account, then Ferretry — then by name', () => {
    expect(sortedSkills(skills).map(entry => entry.name)).toEqual(['mid', 'zeta', 'alpha', 'beta']);
  });

  it('says why a shadowed skill is not active, and counts only the ones that load', () => {
    expect(skillOverride(skills[3] as never)).toBe('Not active: the skill of the same name in This project wins');
    expect(skillOverride(skills[0] as never)).toBeUndefined();
    expect(loadedSkillCount(skills)).toBe(3);
  });

  it('offers a scope chip only when the ferret has a skill from it, counted under the search', () => {
    expect(skillChips(skills, '').map(chip => [chip.key, chip.count])).toEqual([
      ['all', 4],
      ['project', 1],
      ['user', 2],
      ['ferretry', 1],
    ]);
    expect(skillChips([skill('only')], '').map(chip => chip.key)).toEqual(['all', 'user']);
    expect(skillChips(skills, 'zeta').find(chip => chip.key === 'user')?.count).toBe(1);
  });

  it('narrows by chip and by every word of name, description or scope', () => {
    expect(visibleSkills(skills, '', 'user').map(entry => entry.name)).toEqual(['zeta', 'beta']);
    expect(visibleSkills(skills, 'THIS PROJECT', 'all').map(entry => entry.name)).toEqual(['mid']);
    expect(visibleSkills(skills, 'does one thing', 'ferretry').map(entry => entry.name)).toEqual(['alpha']);
  });

  it('answers “are these in my system?” in words, with the account and a cut-short list', () => {
    expect(activeSkillsLine(ferretInventory(skills))).toBe(
      '3 active in this ferret · Claude · inserts /name · account claude-default',
    );
    expect(activeSkillsLine(ferretInventory([], { harness: 'codex', truncated: true, runtime: undefined }))).toBe(
      '0 active in this ferret · Codex · inserts $name · the list was cut short',
    );
  });

  it('splits a SKILL.md into its front matter and its document', () => {
    expect(splitFrontMatter('---\nname: a\n---\n# Hi')).toEqual({ frontMatter: 'name: a', body: '# Hi' });
    expect(splitFrontMatter('# Hi')).toEqual({ frontMatter: null, body: '# Hi' });
  });
});

describe('adding a skill from this machine', () => {
  const machine = machineInventory();

  it('G175 lists only inventory skills, by the SKILL.md path the copy route will be told to read', () => {
    const rows = machineRows(machine, ferretInventory([]), new Set());
    expect(rows.map(row => row.path)).toEqual([
      '/home/me/.claude-work/skills/review/SKILL.md',
      '/work/dojo/.claude/skills/deploy/SKILL.md',
    ]);
    expect(previewRequest(rows[0] as never, { scope: 'project', projectRoot: '/work/dojo', harness: 'codex' })).toEqual(
      {
        source: { path: '/home/me/.claude-work/skills/review/SKILL.md' },
        target: { scope: 'project', projectRoot: '/work/dojo', harness: 'codex' },
      },
    );
  });

  it('leaves out what the ferret already sees, by path or by name, and marks a copy already made', () => {
    const sees = ferretInventory([skill('deploy', { path: '/elsewhere/deploy/SKILL.md' })]);
    const rows = machineRows(machine, sees, new Set(['/home/me/.claude-work/skills/review/SKILL.md']));
    expect(rows.map(row => [row.name, row.installed])).toEqual([['review', true]]);
    expect(rows[0]?.from).toBe('claude-work account');
  });

  it('filters by every word typed over name, description and place', () => {
    const rows = machineRows(machine, ferretInventory([]), new Set());
    expect(filterMachineRows(rows, '').length).toBe(2);
    expect(filterMachineRows(rows, 'project dojo').map(row => row.name)).toEqual(['deploy']);
    expect(filterMachineRows(rows, 'review nothing')).toEqual([]);
  });

  it('offers the machine’s registered projects and asks for the missing choice in words', () => {
    const options = targetOptions(machine);
    expect(options.projects).toEqual([{ root: '/work/dojo', label: 'dojo' }]);
    expect(targetProblem({}, options)).toBe('Pick a project.');
    expect(targetProblem({ projectRoot: '/work/dojo' }, options)).toBe('Pick Claude or Codex for this project.');
    expect(targetProblem({ projectRoot: '/nowhere', harness: 'codex' }, options)).toBe('Pick a project.');
    expect(targetProblem({ projectRoot: '/work/dojo', harness: 'codex' }, options)).toBeNull();
    expect(toTarget({ projectRoot: '/work/dojo' })).toBeNull();
    expect(toTarget({ projectRoot: '/work/dojo', harness: 'codex' })).toEqual({
      scope: 'project',
      projectRoot: '/work/dojo',
      harness: 'codex',
    });
  });
});

describe('Trojan Source in a machine skill’s text', () => {
  const hidden = machineInventory({
    homes: [
      {
        runtime: 'claude\u200Bwork',
        harness: 'claude-code',
        home: '/home/me/.claude-work',
        skills: [
          skill('ok\u202Ename', { description: 'does\u2066 it', path: '/home/me/.claude-work/skills/x/SKILL.md' }),
        ],
      },
    ],
    projects: [],
  });

  it('G175 shows a hidden character in a name, a description or a place as a marker, not as nothing', () => {
    const [row] = machineRows(hidden, ferretInventory([]), new Set());
    expect(row?.name).toBe('ok⟨U+202E⟩name');
    expect(row?.description).toBe('does⟨U+2066⟩ it');
    expect(row?.from).toBe('claude⟨U+200B⟩work account');
  });

  it('G175 marks the name in the line a landed copy and an installed copy print', () => {
    expect(copiedLine({ name: 'ok\u202Ename' })).toBe('ok⟨U+202E⟩name · copied');
    expect(installLine({ name: 'ok\u202Ename', destination: '/p/.claude/skills/ok\u202Ename' })).toBe(
      'ok⟨U+202E⟩name · /p/.claude/skills/ok⟨U+202E⟩name',
    );
  });
});

describe('where Install starts for a ferret', () => {
  const options = {
    projects: [
      { root: '/work', label: 'work' },
      { root: '/work/dojo', label: 'dojo' },
      { root: '/other', label: 'other' },
    ],
  };

  it('is the project holding the ferret’s folder, the longest root winning, and the ferret’s own agent', () => {
    expect(initialDraft({ folder: '/work/dojo/api', harness: 'codex' }, options)).toEqual({
      projectRoot: '/work/dojo',
      harness: 'codex',
    });
    expect(initialDraft({ folder: '/work/dojo/', harness: 'claude-code' }, options)).toEqual({
      projectRoot: '/work/dojo',
      harness: 'claude-code',
    });
    expect(initialDraft({ folder: '/work/other-thing', harness: 'claude-code' }, options)).toEqual({
      projectRoot: '/work',
      harness: 'claude-code',
    });
  });

  it('names no project when the folder is in none, and still the ferret’s agent', () => {
    expect(initialDraft({ folder: '/elsewhere', harness: 'codex' }, options)).toEqual({ harness: 'codex' });
  });
});

describe('what a refused copy says', () => {
  it('G174 a passkey that was not confirmed says nothing was installed and to confirm again', () => {
    const said = localRefusal(refusal(403, 'grant_step_up_required', 'step up'));
    expect(said.sentence).toContain('Nothing was installed');
    expect(said.sentence).toContain('Each install needs its own passkey');
    expect(said.previewAgain).toBe(false);
  });

  it('offers Preview again only when the preview is gone or ran out', () => {
    expect(localRefusal(refusal(404, 'local_skill_preview_unknown', 'x')).previewAgain).toBe(true);
    expect(localRefusal(refusal(410, 'local_skill_preview_expired', 'x')).sentence).toContain('10 minutes');
    expect(localRefusal(refusal(404, 'local_skill_preview_expired', 'x')).previewAgain).toBe(true);
    expect(localRefusal(refusal(409, 'local_skill_conflict', 'already there')).previewAgain).toBe(false);
  });

  it('shows the machine’s own sentence for a source it will not copy, and a plain one when it gave none', () => {
    expect(localRefusal(refusal(400, 'local_skill_source_invalid', 'a.sh line 3 looks like a password')).sentence).toBe(
      'a.sh line 3 looks like a password',
    );
    expect(localRefusal(refusal(400, 'local_skill_source_invalid', '')).sentence).toBe(
      'This skill cannot be copied. Nothing was installed.',
    );
    expect(localRefusal(refusal(409, 'local_skill_conflict', 'folder exists')).sentence).toBe(
      'Something is already where this would go. Nothing was changed. folder exists',
    );
    expect(localRefusal(new Error('socket closed')).sentence).toBe('socket closed');
    expect(localRefusal(undefined).sentence).toBe('This machine didn’t answer.');
  });
});

describe('a /name or $name written anywhere', () => {
  it('reads a skill name by the grammar’s own rule: lowercase only, either sigil', () => {
    expect(skillNameOf('/summary')).toBe('summary');
    expect(skillNameOf('$summary')).toBe('summary');
    expect(skillNameOf('summary')).toBeUndefined();
    expect(skillNameOf('/summary.')).toBeUndefined();
    expect(skillNameOf({ name: '/review-2' })).toBe('review-2');
    expect(skillNameOf('$HOME')).toBeUndefined();
    expect(skillNameOf('/Summary')).toBeUndefined();
    expect(skillNameOf('/apps/web:deploy')).toBeUndefined();
    expect(skillNameOf(undefined)).toBeUndefined();
  });

  it('takes the ferret and daemon it was written in from the value, and no more', () => {
    expect(referenceScope('/summary')).toEqual({});
    expect(referenceScope({ name: 'x', ferretId: 'f1', daemon: 'studio', extra: 1 })).toEqual({
      ferretId: 'f1',
      daemon: 'studio',
    });
    expect(referenceScope({ ferretId: '' })).toEqual({});
  });
});
