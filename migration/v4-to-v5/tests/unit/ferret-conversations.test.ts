import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEX_ROLLOUTS, CodexRolloutBindingSchema } from '@ferretry/plugin-codex/contract';
import {
  CLAUDE_CODE_CONVERSATION_FILE,
  ClaudeConversationBindingSchema,
  claudeTranscriptPath,
} from '@ferretry/plugin-claude-code/contract';
import { ferretConversationsStep } from '../../src/steps/ferret-conversations.ts';
import { STEPS } from '../../src/steps/index.ts';
import { fixture, RUNTIME } from './ferret-fixture.ts';

/**
 * EACH FERRET'S CONVERSATION, IN ITS OWN AGENT HOME (sessions-carry). v5 proves a Claude ferret's transcript only from
 * `agent-homes/<ferret>/conversation.json` + `agent-homes/<ferret>/projects/<cwd>/<id>.jsonl`, and a Codex ferret's
 * from `state/codex/rollouts/<ferret>.json` + `agent-homes/<ferret>/sessions/…`. Before this step a converted ferret
 * had neither: `fy logs` refused ("no transcript this daemon can prove is its own") and a resume started empty.
 */

const CONV = '6c9af096-abec-4400-a8dd-17849ed8353c';
const CWD = '/work/alpha';
const CLAUDE_HOME = 'state/claude-code/agent-homes';
const BYTES = Buffer.from('{"type":"user","message":"FAKE-TRANSCRIPT"}\n{"type":"assistant"}\n');

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
  await f.put('fleet/ids.json', { version: 1, runtimes: { 'claude-work': { id: RUNTIME, formerNames: [] } } });
});
afterEach(async () => {
  // A test may have shut a folder; open it again so the temp tree can go.
  await chmod(join(f.from, 'tripwire'), 0o700).catch(() => undefined);
  await f.clean();
});

/** A v4 Claude ferret, its transcript in the shared pool and named, as v4 named it, through the runtime home's link. */
const claudeFerret = async (id = 'f1', status = 'completed') => {
  const encoded = claudeTranscriptPath(CWD, CONV);
  const pooled = join(f.from, 'fleet/shared/claude', encoded);
  await mkdir(join(pooled, '..'), { recursive: true, mode: 0o700 });
  await writeFile(pooled, BYTES, { mode: 0o600 });
  const time = new Date('2026-10-01T00:00:00.000Z');
  await utimes(pooled, time, time);
  await mkdir(join(f.from, 'fleet/homes', RUNTIME), { recursive: true, mode: 0o700 });
  await symlink(join(f.from, 'fleet/shared/claude/projects'), join(f.from, 'fleet/homes', RUNTIME, 'projects')).catch(
    () => undefined,
  );
  const home = join(f.from, 'fleet/homes', RUNTIME);
  await f.session(id, {
    harness: 'claude',
    agent: 'claude-work',
    cwd: CWD,
    transcript: {
      v: 1,
      home,
      harnessSessionId: CONV,
      identity: 'minted',
      file: join(home, encoded),
      resolvedAt: '2026-11-01T00:00:00.000Z',
    },
  });
  await f.put(`state/sessions/${id}/state.json`, { id, status, turn: 1 });
  return { pooled, time };
};

const claudeBinding = async (id = 'f1') =>
  ClaudeConversationBindingSchema.parse(
    JSON.parse(await readFile(join(f.to, CLAUDE_HOME, id, CLAUDE_CODE_CONVERSATION_FILE), 'utf8')),
  );

test('RED on the step table before this step: after every step, a Claude ferret has its own bound transcript', async () => {
  await claudeFerret();
  for (const step of STEPS) await step.run(f.ctx());
  const binding = await claudeBinding();
  expect(binding).toEqual({ format: 1, id: CONV, cwd: CWD });
  expect(await readFile(join(f.to, CLAUDE_HOME, 'f1', claudeTranscriptPath(binding.cwd, binding.id)))).toEqual(BYTES);
});

test('Claude: the transcript lands where v5 computes it, bytes, mode and time kept; the binding is the harness schema', async () => {
  const { pooled, time } = await claudeFerret();
  // The conversation's own folder beside it (a sub-agent transcript) comes too.
  await f.put(`fleet/shared/claude/${claudeTranscriptPath(CWD, CONV).replace(/\.jsonl$/u, '')}/subagents/a.jsonl`, {
    sub: 'FAKE-SUB',
  });
  const before = await stat(pooled);
  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'ferret conversations carried into their own agent home', count: 1 });

  const copied = join(f.to, CLAUDE_HOME, 'f1', claudeTranscriptPath(CWD, CONV));
  expect(await readFile(copied)).toEqual(BYTES);
  const facts = await stat(copied);
  expect(facts.mode & 0o777).toBe(0o600);
  expect(facts.mtimeMs).toBe(time.getTime());
  expect(
    await readFile(join(copied.replace(/\.jsonl$/u, ''), 'subagents/a.jsonl'), 'utf8').then(text => text.length),
  ).toBeGreaterThan(0);
  expect(await claudeBinding()).toEqual({ format: 1, id: CONV, cwd: CWD });
  // Owner-only all the way down from the agent homes, as the harness's private-chain check demands.
  for (const folder of [join(f.to, CLAUDE_HOME, 'f1'), join(f.to, CLAUDE_HOME, 'f1/projects')])
    expect((await stat(folder)).mode & 0o077).toBe(0);
  // The v4 file is untouched, and the report names files and sizes, never a byte.
  const after = await stat(pooled);
  expect([after.mtimeMs, after.size, after.ino]).toEqual([before.mtimeMs, before.size, before.ino]);
  expect(JSON.stringify(report)).not.toContain('FAKE-');
  expect(report.sealed.map(item => item.file)).toContain(join(CLAUDE_HOME, 'f1', claudeTranscriptPath(CWD, CONV)));
});

test('Codex: the rollout lands under the ferret home’s sessions/, bound by the Codex rollout schema', async () => {
  const rollout = 'sessions/2026/11/01/rollout-2026-11-01T00-00-00-abc.jsonl';
  await f.put(`fleet/shared/codex/${rollout}`, { type: 'session_meta', payload: { id: CONV, cwd: CWD } });
  const home = join(f.from, 'fleet/homes', RUNTIME);
  await f.session('c1', {
    harness: 'codex',
    agent: 'claude-work',
    cwd: CWD,
    transcript: { v: 1, home, harnessSessionId: CONV, identity: 'correlated', file: join(home, rollout) },
  });
  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const target = join(f.to, 'state/codex/agent-homes/c1', rollout);
  expect(await readFile(target, 'utf8')).toContain(CONV);
  const binding = CodexRolloutBindingSchema.parse(
    JSON.parse(await readFile(join(f.to, 'state/codex', CODEX_ROLLOUTS.path.replace('*', 'c1')), 'utf8')),
  );
  expect(binding).toEqual({ format: 1, home: join(f.to, 'state/codex/agent-homes/c1'), baseline: [], native: CONV });
});

test('a link on the transcript path is never followed: that conversation is named as not carried, nothing else stops', async () => {
  // The pool's project folder is a link to a tripwire shut to everyone: any read through it would fail loudly.
  await mkdir(join(f.from, 'tripwire', 'project'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'tripwire', 'project', `${CONV}.jsonl`), 'FAKE-TRIPWIRE');
  await claudeFerret();
  const dir = join(f.from, 'fleet/shared/claude', claudeTranscriptPath(CWD, CONV), '..');
  await (await import('node:fs/promises')).rm(dir, { recursive: true });
  await symlink(join(f.from, 'tripwire', 'project'), dir);
  await chmod(join(f.from, 'tripwire'), 0o000);

  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.notCarried).toContainEqual({
    what: "ferret f1's conversation",
    why: 'its transcript path in the v4 home goes through a link, which is never followed',
  });
  expect(await lstat(join(f.to, CLAUDE_HOME, 'f1')).catch(() => undefined)).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('a ferret with no recorded conversation, or whose file is gone, is named and never guessed', async () => {
  await f.session('none', { harness: 'claude', agent: 'claude-work', cwd: CWD });
  const home = join(f.from, 'fleet/homes', RUNTIME);
  await f.session('gone', {
    harness: 'claude',
    agent: 'claude-work',
    cwd: CWD,
    transcript: {
      v: 1,
      home,
      harnessSessionId: CONV,
      identity: 'minted',
      file: join(home, claudeTranscriptPath(CWD, CONV)),
    },
  });
  // Another conversation sits in the pool; it is never taken for theirs.
  await f.put(`fleet/shared/claude/${claudeTranscriptPath(CWD, 'someone-else')}`, { other: true });
  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.notCarried).toContainEqual({
    what: "ferret none's conversation",
    why: 'v4 recorded no conversation for it (it never started one)',
  });
  expect(report.notCarried).toContainEqual({
    what: "ferret gone's conversation",
    why: 'the transcript v4 recorded is not on disk',
  });
  expect(await readdir(join(f.to, CLAUDE_HOME)).catch(() => [])).toEqual([]);
});

test('a ferret still running in its v4 pane is carried, and the report says its chat stops at conversion', async () => {
  await claudeFerret('f1', 'running');
  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.note).toBe(
    '1 ferret(s) still running in v4 panes (f1): the chat shows up to conversion until restarted',
  );
  expect((await claudeBinding()).id).toBe(CONV);
});

test('no write through a link on the v5 side: a planted link at the ferret’s agent home refuses', async () => {
  await claudeFerret();
  await mkdir(join(f.to, CLAUDE_HOME), { recursive: true, mode: 0o700 });
  await mkdir(join(f.root, 'elsewhere'), { mode: 0o700 });
  await symlink(join(f.root, 'elsewhere'), join(f.to, CLAUDE_HOME, 'f1'));
  const report = await ferretConversationsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(await readdir(join(f.root, 'elsewhere'))).toEqual([]);
});

test('a dry run writes nothing; the preview binds nothing', async () => {
  await claudeFerret();
  const dry = await ferretConversationsStep.run(f.ctx(true));
  expect(dry.kept).toContainEqual({ what: 'ferret conversations carried into their own agent home', count: 1 });
  expect(await lstat(f.to).catch(() => undefined)).toBeUndefined();
  const preview = await ferretConversationsStep.run({ ...f.ctx(), preview: true });
  expect(preview.kept).toEqual([]);
  expect(await lstat(join(f.to, CLAUDE_HOME, 'f1')).catch(() => undefined)).toBeUndefined();
});
