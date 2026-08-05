import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeForeignHistoryFiles } from '../../../src/adapters/imports/index.ts';
import { ForeignHistoryImporter } from '../../../src/lib/imports/index.ts';
import { foreignHistoryRoutes } from '../../../src/lib/runtime/mounts/foreign-history.ts';
import { ClaudeTranscriptParser, CodexTranscriptParser } from '../../../src/lib/transcript/index.ts';
import { request } from '../../unit/api/support.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-foreign-history-'));
  temporaryDirectories.push(directory);
  return directory;
}

function claudeRecord(content: unknown): string {
  return `${JSON.stringify({
    type: 'user',
    sessionId: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-08-05T00:00:00.000Z',
    message: { role: 'user', content },
  })}\n`;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('foreign harness history integration', () => {
  it('should skip damaged fixture transcripts, not follow links, and only disclose aggregate failures', async () => {
    // Arrange: every source is a fixture under a fresh temp directory. No real harness home is read.
    const root = await temporaryDirectory();
    const claudeProjects = join(root, 'fixture-home', '.claude', 'projects');
    const project = join(claudeProjects, 'project');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(project, { recursive: true }), mkdir(outside)]);
    await Promise.all([
      writeFile(join(project, 'good.jsonl'), claudeRecord('This transcript is readable.')),
      writeFile(join(project, 'invalid-one.jsonl'), '{invalid json}\n'),
      writeFile(join(project, 'invalid-two.jsonl'), '{invalid json}\n'),
      writeFile(join(project, 'partial.jsonl'), '{"type":"user"'),
      writeFile(join(project, 'message-less.jsonl'), claudeRecord([])),
      writeFile(join(outside, 'must-not-follow.jsonl'), claudeRecord('This must stay outside discovery.')),
    ]);
    await symlink(outside, join(claudeProjects, 'linked-project'));
    const unreadable = join(project, 'unreadable.jsonl');
    await writeFile(unreadable, claudeRecord('This file cannot be read.'));
    await chmod(unreadable, 0o000);
    const subject = new ForeignHistoryImporter(
      new NodeForeignHistoryFiles(),
      // Codex's root is intentionally absent: a person who has not used one harness has no error.
      { claudeProjects, codexSessions: join(root, 'fixture-home', '.codex', 'sessions') },
      { claude: new ClaudeTranscriptParser(), codex: new CodexTranscriptParser() },
    );

    // Act
    const listing = await subject.list();
    const route = foreignHistoryRoutes({ list: async () => listing, get: async () => undefined })[0];
    if (route === undefined) throw new Error('the foreign history list route must be mounted');
    const response = await route.handle({ request: request(), params: new Map() });
    const body = JSON.parse(response.body) as {
      readonly conversations: readonly Record<string, unknown>[];
      readonly skipped: readonly { readonly harness: string; readonly reason: string; readonly count: number }[];
    };

    // Assert
    should(listing.conversations).have.length(1);
    should(listing.conversations[0]?.title).equal('This transcript is readable.');
    should(listing.skipped.map(item => item.reason).sort()).deepEqual([
      'invalid-json',
      'invalid-json',
      'the transcript contains no renderable messages',
      'the transcript could not be read',
      'truncated-json',
    ]);
    should(listing.conversations.map(item => item.title)).not.containEql('This must stay outside discovery.');
    should(body.conversations).have.length(1);
    should(body.skipped).containDeep([{ harness: 'claude', reason: 'invalid-json', count: 2 }]);
    should(JSON.stringify(body)).not.containEql(root);
    await chmod(unreadable, 0o600);
  });
});
