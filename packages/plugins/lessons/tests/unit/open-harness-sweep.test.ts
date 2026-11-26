import { describe, it } from 'bun:test';
import should from 'should';
import { RunManifestSchema } from '../../contract/index.ts';
import { lessonSessionFacts } from '../../daemon/adapters/ferret-sessions.ts';
import { repoInstructionsFileName } from '../../daemon/lib/apply.ts';
import { drive, HOST, lessonsSubsystem } from './routes-support.ts';
import { FakeLessonsStore, lessonFacts, lessonsWorld, observation, proposal } from './support.ts';

/**
 * U4b part 4b, Lessons: a ferret on a harness the family table has no row for is never read as Claude. `fake-third` is a
 * third harness key; `claude` is a third harness REGISTERED UNDER the family word, which must not borrow Claude's policy
 * either (a plugin KEY is not a harness FAMILY).
 */

const ferret = (harness: string) =>
  ({
    id: 'f1',
    harness,
    folder: '/work/ferretry',
    role: 'lead',
    state: 'idle',
    createdAt: '2026-11-26T00:00:00.000Z',
    name: 'Ada',
  }) as never;

describe('the session facts a lesson reads', () => {
  it('should keep the two shipped harnesses as before: the family word, and a family', () => {
    // Arrange / Act
    const claude = lessonSessionFacts(ferret('claude-code'));
    const codex = lessonSessionFacts(ferret('codex'));

    // Assert
    should([claude.harness, claude.family]).deepEqual(['claude', 'claude']);
    should([codex.harness, codex.family]).deepEqual(['codex', 'codex']);
  });

  it('should name a third harness by its own key and give it no family', () => {
    // Act
    const facts = lessonSessionFacts(ferret('fake-third'));

    // Assert
    should(facts.harness).equal('fake-third');
    should(facts.family).be.undefined();
  });

  it('should give a third harness registered under the word `claude` no family (a key is not a family)', () => {
    // Act
    const facts = lessonSessionFacts(ferret('claude'));

    // Assert
    should(facts.family).be.undefined();
  });
});

describe('the file a new repo lesson creates', () => {
  const none = { agents: false, claude: false };

  it('should be the harness own file for the two shipped families, and an existing file wins', () => {
    should(repoInstructionsFileName(none, 'claude')).equal('CLAUDE.md');
    should(repoInstructionsFileName(none, 'codex')).equal('AGENTS.md');
    should(repoInstructionsFileName({ agents: true, claude: true }, undefined)).equal('AGENTS.md');
    should(repoInstructionsFileName({ agents: false, claude: true }, undefined)).equal('CLAUDE.md');
  });

  it('should name no file for a family it has none for', () => {
    should(repoInstructionsFileName(none, undefined)).be.undefined();
  });
});

describe('the run manifest', () => {
  it('should count a third harness under its own key', () => {
    // Arrange
    const run = {
      runId: 'run-1',
      startedAt: '2026-11-26T00:00:00.000Z',
      ferretsScanned: 0,
      ferretsWithSignal: 0,
      minerFerrets: [],
      observationsProposed: 0,
      observationsVerified: 0,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 0,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { 'claude-code': 1, codex: 0, 'fake-third': 2 },
    };

    // Act
    const parsed = RunManifestSchema.safeParse(run);

    // Assert
    should(parsed.success).be.true();
  });
});

describe('the apply preview route for a lesson a third harness filed', () => {
  const PROJECT = '/work/ferretry';
  const repoLesson: Parameters<typeof proposal>[0] = {
    id: 'repo_a',
    identity: 'repo-lesson',
    state: 'accepted',
    category: 'repo',
    project: PROJECT,
    observationIds: ['obs1'],
  };

  async function previewFiledBy(harness: string, family: 'claude' | 'codex' | undefined) {
    const store = new FakeLessonsStore([proposal(repoLesson)], [observation({ id: 'obs1', ferretId: 'third-sess' })]);
    const world = lessonsWorld(store);
    world.sessions.sessions = [lessonFacts({ ferretId: 'third-sess', harness, family })];
    const answer = await drive(
      lessonsSubsystem(store, world),
      { method: 'GET', path: '/v1/lessons/proposals/repo_a/apply-preview' },
      HOST,
    );
    return { answer, world };
  }

  it('should refuse a third harness by name, as a 400, with nothing written (never a 500)', async () => {
    // Act
    const { answer, world } = await previewFiledBy('fake-third', undefined);

    // Assert
    should(answer.status).equal(400);
    should(String(answer.body.error ?? answer.body.message)).containEql('fake-third');
    should(world.files.writes).be.empty();
  });

  it('should refuse a third harness registered under the word `claude`, not write CLAUDE.md for it', async () => {
    // Act
    const { answer } = await previewFiledBy('claude', undefined);

    // Assert
    should(answer.status).equal(400);
  });

  it('should still preview CLAUDE.md and AGENTS.md for the two shipped harnesses', async () => {
    // Act
    const claude = await previewFiledBy('claude', 'claude');
    const codex = await previewFiledBy('codex', 'codex');

    // Assert
    should([claude.answer.status, claude.answer.body.path]).deepEqual([200, `${PROJECT}/CLAUDE.md`]);
    should([codex.answer.status, codex.answer.body.path]).deepEqual([200, `${PROJECT}/AGENTS.md`]);
  });
});
