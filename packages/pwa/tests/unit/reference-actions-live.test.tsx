/**
 * The round trip: a token an action inserted must be LIVE where it is read.
 *
 * Add to chat and Use in chat are only finished if what they write into the
 * draft resolves in the transcript that reads it back. A button that inserts
 * `&F12` beside a reference surface which cannot prove `&F12` ships a control
 * whose entire result is grey prose — and every focused test of either half
 * passes while that is true, because neither half is wrong on its own.
 *
 * So this takes the two halves as the workspace assembles them: the token comes
 * out of the real delivery path (registry composer, canonical formatter), and the
 * reader is a real `Markdown` built by `sessionReferenceSurface` from the SAME
 * session's task snapshot and skill names. Nothing is transcribed between them.
 */

import { describe, test } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import should from 'should';

import { Markdown } from '../../src/components/markdown.tsx';
import { sessionReferenceSurface } from '../../src/components/reference-surface.tsx';
import { skillInsertText } from '../../src/features/skills/skills-catalog.ts';
import { addSkillInvocationToComposer } from '../../src/features/skills/skills-composer.ts';
import { addReferenceToComposer } from '../../src/lib/composer-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../src/lib/quote.ts';
import { render, run } from '../support/react.ts';

const connection = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const scope = daemonSessionScope(connection, 'session-a');

/** The board rows and catalog names the workspace already holds for this session. */
const BOARD = [{ id: 'F12' }, { id: 'F13' }] as const;
const CATALOG_NAMES = ['floop', 'summary'] as const;

const anchorsOf = (root: ReactTestInstance): ReactTestInstance[] => root.findAllByType('a');
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child as ReactTestInstance))).join('');

/** Runs an action against a real registered composer and returns the draft. */
const draftAfter = (action: () => unknown, initial = ''): string => {
  const state = { draft: initial };
  const dispose = registerComposerQuoteTarget({
    ...scope,
    draft: () => state.draft,
    replaceDraft: next => {
      state.draft = next;
    },
  });
  try {
    action();
  } finally {
    dispose();
  }
  return state.draft;
};

describe('an inserted reference is live in the surface that reads it back', () => {
  test('should resolve the task token Add to chat wrote, and only for a task this session holds', () => {
    // Arrange — the draft is produced by the real delivery path, not typed here.
    const draft = draftAfter(() => addReferenceToComposer({ kind: 'task', id: 'F12' }, scope), 'please finish');
    should(draft).equal('please finish &F12 ');
    const surface = sessionReferenceSurface({ connection, scope, tasks: BOARD });

    // Act — the transcript reads that exact draft back.
    const tree = render(<Markdown {...surface} text={`${draft}and not &F99`} />);

    // Assert
    try {
      should(anchorsOf(tree.root).map(anchor => textOf(anchor))).deepEqual(['&F12']);
    } finally {
      run(() => tree.unmount());
    }
  });

  test('should resolve both harness spellings of the skill Use in chat wrote', () => {
    // Arrange
    const claude = draftAfter(() => addSkillInvocationToComposer(skillInsertText('claude', 'floop'), scope));
    const codex = draftAfter(() => addSkillInvocationToComposer(skillInsertText('codex', 'floop'), scope));
    should([claude, codex]).deepEqual(['/floop ', '$floop ']);
    const surface = sessionReferenceSurface({ connection, scope, skills: [...CATALOG_NAMES] });

    // Act
    const tree = render(<Markdown {...surface} text={`${claude}${codex}but not /absent`} />);

    // Assert — `$floop` is an authored alias of the same skill, so both are live
    // and neither is rewritten into the other.
    try {
      should(anchorsOf(tree.root).map(anchor => textOf(anchor))).deepEqual(['/floop', '$floop']);
    } finally {
      run(() => tree.unmount());
    }
  });

  test('should leave an inserted token as prose while the session has proved nothing yet', () => {
    // Arrange — an unread board and an unread catalog are NOT empty ones, and
    // this is the state the workspace is in before either read answers.
    const surface = sessionReferenceSurface({ connection, scope });

    // Act
    const tree = render(<Markdown {...surface} text="&F12 and /floop" />);

    // Assert — honest: no link is offered for a fact this session cannot yet
    // prove, rather than a link that would go nowhere.
    try {
      should(anchorsOf(tree.root)).be.empty();
    } finally {
      run(() => tree.unmount());
    }
  });
});
