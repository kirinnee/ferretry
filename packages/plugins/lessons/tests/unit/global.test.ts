/**
 * Finding 5: the owner can change or remove an applied Global lesson, as today (today: edit the
 * `<assets>/instructions/lessons.md` file). The document is this plugin's state, so the owner reads it and rewrites it
 * whole through `GET` / `PUT /v1/lessons/global`, against the etag just read, from Settings › Lessons or `fy lesson
 * global`. The preview no longer names a file that does not exist.
 */
import { describe, expect, it } from 'bun:test';
import { cap } from '@ferretry/core-gate/contract';
import {
  GLOBAL_LESSONS_DOCUMENT,
  LESSONS_APPLY_CONFLICT_CODE,
  LessonsGlobalDocumentSchema,
  globalLessonRules,
  withGlobalLessonRule,
} from '../../contract/index.ts';
import { LessonsController } from '../../cli/lib/controller.ts';
import { insertLesson, lessonFileEtag } from '../../daemon/lib/index.ts';
import manifest from '../../manifest.ts';
import { CapturingOutput, RecordingLessonsGateway } from './cli/fixtures.ts';
import { AGENT, HOST, drive, lessonsSubsystem } from './routes-support.ts';
import { FakeLessonsStore, lessonsWorld, proposal } from './support.ts';

const DOCUMENT = insertLesson(insertLesson(undefined, 'Use bun, not Python.'), 'Run commands through direnv exec.');

function subject(text: string | undefined = DOCUMENT) {
  const store = new FakeLessonsStore();
  const world = lessonsWorld(store);
  if (text !== undefined) world.files.texts.set(world.global.path, text);
  const read = (): string | undefined => world.files.texts.get(world.global.path);
  return { read, subsystem: lessonsSubsystem(store, world) };
}

describe('the Global lessons document (finding 5)', () => {
  it('is named, never shown as a path that does not exist on disk', () => {
    expect(GLOBAL_LESSONS_DOCUMENT).toBe('Global lessons document');
    expect(GLOBAL_LESSONS_DOCUMENT).not.toContain('instructions/lessons.md');
  });

  it('GET answers the document and its etag', async () => {
    const { subsystem } = subject();
    const answer = await drive(subsystem, { method: 'GET', path: '/v1/lessons/global' });
    expect(answer.status).toBe(200);
    const document = LessonsGlobalDocumentSchema.parse(answer.body);
    expect(document.text).toBe(DOCUMENT);
    expect(document.etag).toBe(lessonFileEtag(DOCUMENT));
    expect(globalLessonRules(document.text)).toEqual(['Use bun, not Python.', 'Run commands through direnv exec.']);
  });

  it('PUT removes an applied rule when the etag matches, and every later launch reads the new text', async () => {
    const { subsystem, read } = subject();
    const text = withGlobalLessonRule(DOCUMENT, 1, undefined) as string;
    const answer = await drive(subsystem, {
      method: 'PUT',
      path: '/v1/lessons/global',
      body: { text, etag: lessonFileEtag(DOCUMENT) },
    });
    expect(answer.status).toBe(200);
    expect(read()).toBe(text);
    expect(globalLessonRules(read() as string)).toEqual(['Run commands through direnv exec.']);
  });

  it('PUT refuses a stale etag with 409 and changes nothing', async () => {
    const { subsystem, read } = subject();
    const answer = await drive(subsystem, {
      method: 'PUT',
      path: '/v1/lessons/global',
      body: { text: '', etag: lessonFileEtag('something else') },
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: LESSONS_APPLY_CONFLICT_CODE });
    expect(read()).toBe(DOCUMENT);
  });

  it('a ferret can never rewrite it; the route is a person’s act on fleet.configure', async () => {
    const { subsystem, read } = subject();
    const answer = await drive(
      subsystem,
      { method: 'PUT', path: '/v1/lessons/global', body: { text: '', etag: lessonFileEtag(DOCUMENT) } },
      AGENT,
    );
    expect(answer.status).toBe(403);
    expect(read()).toBe(DOCUMENT);
    const route = manifest.actions.routes.find(entry => entry.key === 'PUT /v1/lessons/global');
    expect(route?.caller).toBe('person');
    expect(route?.capability).toEqual(cap('fleet', 'configure'));
  });

  it('an applied Global lesson’s card points at the document, not a file to edit', async () => {
    const store = new FakeLessonsStore([proposal({ id: 'g1', state: 'applied', category: 'global' })]);
    const answer = await drive(
      lessonsSubsystem(store),
      { method: 'POST', path: '/v1/lessons/proposals/g1', body: { action: 'accept' } },
      HOST,
    );
    expect(answer.status).toBe(409);
    expect(String((answer.body as { error: string }).error)).toContain('Global lessons document');
  });
});

describe('fy lesson global (finding 5)', () => {
  const run = () => {
    const gateway = new RecordingLessonsGateway();
    const out = new CapturingOutput();
    return { gateway, out, controller: new LessonsController(gateway, out, 'fy') };
  };

  it('lists the rules numbered', async () => {
    const { controller, out } = run();
    await controller.global({});
    expect(out.text).toContain('1. Use bun, not Python.');
    expect(out.text).toContain('2. Run commands through direnv exec.');
  });

  it('edit rewords one rule against the etag it read', async () => {
    const { controller, gateway } = run();
    await controller.globalRule('2', ['Use', 'direnv.'], {});
    expect(gateway.globalWrites).toEqual([
      { text: '## Lessons\n\n- Use bun, not Python.\n- Use direnv.\n', etag: 'etag-1' },
    ]);
  });

  it('remove drops one rule and keeps every other line', async () => {
    const { controller, gateway } = run();
    await controller.globalRule('1', undefined, {});
    expect(gateway.globalWrites[0]?.text).toBe('## Lessons\n\n- Run commands through direnv exec.\n');
  });

  it('refuses a rule number that is not there, writing nothing', async () => {
    const { controller, gateway } = run();
    await expect(controller.globalRule('9', undefined, {})).rejects.toThrow('there is no Global rule 9');
    expect(gateway.globalWrites).toEqual([]);
  });

  it('is declared: lesson global, lesson global edit, lesson global remove', () => {
    const verbs = manifest.actions.cli.map(entry => entry.verb);
    expect(verbs).toEqual(expect.arrayContaining(['lesson global', 'lesson global edit', 'lesson global remove']));
  });
});
