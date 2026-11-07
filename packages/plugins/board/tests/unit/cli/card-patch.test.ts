import { describe, it } from 'bun:test';
import should from 'should';
import { cardPatchDocument, composeCardPatch, parseCardPatch } from '../../../cli/lib/card-patch.ts';
import { patchYaml } from '../../../cli/lib/patch-document.ts';
import { card } from './fixtures.ts';

const task = card({
  title: 'Patch-edit agenda and cards',
  summary: 'Ferrets send one patch',
  premise: '- Many flags today',
  howToTest: '1. Run it',
  terms: [{ term: 'patch', meaning: 'a document of changes' }],
});

const parsed = (text: string) => {
  const result = parseCardPatch(text, 'f1.yaml');
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result.patch;
};

describe('card show --yaml', () => {
  it('should print the revision (the newest history seq) and every field a patch changes', () => {
    // Act
    const document = cardPatchDocument(task);

    // Assert
    should(document).deepEqual({
      revision: 1,
      title: 'Patch-edit agenda and cards',
      summary: 'Ferrets send one patch',
      premise: '- Many flags today',
      context: '',
      terms: [{ term: 'patch', meaning: 'a document of changes' }],
      brief: '',
      howToTest: '1. Run it',
    });
  });

  it('should round-trip: the printed YAML patched back changes nothing', () => {
    // Act
    const plan = composeCardPatch(task, parsed(patchYaml(cardPatchDocument(task), ['comment'])));

    // Assert
    should(plan).deepEqual({ kind: 'unchanged' });
  });
});

describe('task patch', () => {
  it('should send ONE edit with what differs and the revision; null empties, a list of points becomes bullets', () => {
    // Act
    const plan = composeCardPatch(
      task,
      parsed('revision: 1\nsummary: Ferrets send one patch\ncontext:\n  - one\n  - two\nhowToTest: null\nterms: null'),
    );

    // Assert
    should(plan).deepEqual({
      kind: 'edit',
      request: { action: 'edit', revision: 1, context: '- one\n- two', howToTest: '', terms: [] },
    });
  });

  it('should refuse a patch written against an older revision', () => {
    // Act + Assert
    should(composeCardPatch(task, parsed('revision: 7\nbrief: new plan'))).deepEqual({ kind: 'stale' });
  });

  it('should refuse a document that names no field to change', () => {
    // Act
    const empty = parseCardPatch('revision: 1', 'f1.yaml');

    // Assert
    should(empty.ok).be.false();
    should(!empty.ok && empty.problems).deepEqual(['f1.yaml names no field to change: a patch changes at least one']);
  });

  it('should read a null point list as emptied', () => {
    // Act
    const plan = composeCardPatch(task, parsed('revision: 1\npremise: null'));

    // Assert
    should(plan).deepEqual({ kind: 'edit', request: { action: 'edit', revision: 1, premise: '' } });
  });

  it('should require the revision, refuse unknown or read-only keys, and never empty the title', () => {
    // Act
    const missing = parseCardPatch('brief: new plan', 'f1.yaml');
    const wrong = parseCardPatch('revision: 1\nlaneId: done\nassignee: me\ntitle: null', 'f1.yaml');

    // Assert
    should(!missing.ok && missing.problems[0]).match(/^revision: required — read the whole card first/u);
    const problems = wrong.ok ? '' : wrong.problems.join('\n');
    should(problems).match(/laneId: not a field a patch changes \(it takes: revision, title, summary/u);
    should(problems).match(/assignee: not a field a patch changes/u);
    should(problems).match(/title: /u);
  });
});

describe('card patch: the card progress merges by key', () => {
  const withProgress = card({ progress: { now: 'designing', doneSoFar: '- the schema', next: '1. the CLI' } });

  it('should print the progress whole and send only the parts that changed', () => {
    // Act
    const document = cardPatchDocument(withProgress);
    const plan = composeCardPatch(
      withProgress,
      parsed('revision: 1\nprogress:\n  now: testing\n  doneSoFar: "- the schema"'),
    );

    // Assert
    should(document.progress).deepEqual({ now: 'designing', doneSoFar: '- the schema', next: '1. the CLI' });
    should(plan).deepEqual({ kind: 'edit', request: { action: 'edit', revision: 1, progress: { now: 'testing' } } });
  });

  it('should read a card with no progress as empty parts, and send nothing when the parts already match', () => {
    // Act
    const fresh = composeCardPatch(task, parsed('revision: 1\nprogress:\n  next: "1. ship"\n  now: ""'));
    const same = composeCardPatch(withProgress, parsed('revision: 1\nprogress:\n  now: designing'));

    // Assert
    should(fresh).deepEqual({ kind: 'edit', request: { action: 'edit', revision: 1, progress: { next: '1. ship' } } });
    should(same).deepEqual({ kind: 'unchanged' });
  });

  it('should refuse null on the progress and an unknown part', () => {
    // Act
    const nulled = parseCardPatch('revision: 1\nprogress: null', 'f1.yaml');
    const unknown = parseCardPatch('revision: 1\nprogress:\n  later: x', 'f1.yaml');

    // Assert
    should(nulled.ok).be.false();
    should(!unknown.ok && unknown.problems).deepEqual(['progress.later: not a field a patch changes']);
  });
});
