import { describe, expect, test } from 'bun:test';
import {
  fillPlaceholders,
  isFollowing,
  judgeGh,
  namesRepository,
  withRepository,
} from '../../daemon/features/gh-run/gh-policy.ts';

function each(rows: readonly (readonly string[])[], title: string, run: (argv: string[]) => void): void {
  for (const row of rows) test(title.replace('%s', row.join(' ')), () => run([...row]));
}

const verdict = (...argv: string[]) => judgeGh(argv);
const sentenceOf = (...argv: string[]): string => {
  const v = verdict(...argv);
  if (v.kind !== 'refuse') throw new Error(`expected a refusal for ${argv.join(' ')}, got ${v.kind}`);
  return v.sentence;
};

describe("Ferretry's gh policy: what is allowed", () => {
  each(
    [
      ['pr', 'list'],
      ['pr', 'view', '12', '--json', 'title'],
      ['pr', 'create', '--head', 'feat', '--title', 't', '--body', 'b'],
      ['pr', 'create', '-H', 'feat', '--title', 't'],
      ['pr', 'checks', '12', '--watch'],
      ['issue', 'list'],
      ['issue', 'develop', '4', '--list'],
      ['run', 'watch', '99'],
      ['workflow', 'run', 'ci.yml'],
      ['release', 'list'],
      ['repo', 'view', 'o/r'],
      ['repo', 'fork', 'o/r'],
      ['api', 'repos/{owner}/{repo}/pulls'],
      ['search', 'prs', 'is:open'],
      ['label', 'list'],
      ['secret', 'list'],
      ['variable', 'set', 'X', '--body', 'y'],
      ['cache', 'list'],
      ['ruleset', 'list'],
      ['gist', 'view', 'abc'],
      ['project', 'list'],
      ['org', 'list'],
      ['status'],
      ['browse', '--no-browser'],
    ],
    '%s passes the policy',
    argv => {
      expect(judgeGh(argv).kind).toBe('run');
    },
  );

  test('a command gets its plain two-word name for the audit, never an argument', () => {
    expect(verdict('pr', 'list', '--search', 'secret thing')).toMatchObject({ command: 'pr list' });
    expect(verdict('api', 'repos/o/r/issues')).toMatchObject({ command: 'api' });
    expect(verdict('status')).toMatchObject({ command: 'status' });
  });

  test('repository commands are marked, so the runner names the repository; others are not', () => {
    expect(verdict('pr', 'list')).toMatchObject({ repoCommand: true });
    expect(verdict('search', 'prs', 'x')).toMatchObject({ repoCommand: false });
    expect(verdict('api', 'user')).toMatchObject({ repoCommand: false });
  });

  test('auth status (no token flag) is answered by the daemon, not run', () => {
    expect(verdict('auth', 'status').kind).toBe('auth-status');
    expect(verdict('auth', 'status', '--active').kind).toBe('auth-status');
  });
});

describe("Ferretry's gh policy: every refusal says what to do instead", () => {
  each(
    [
      ['auth', 'token'],
      ['auth', 'status', '-t'],
      ['auth', 'status', '--show-token'],
      ['auth', 'login'],
      ['auth', 'logout'],
      ['auth', 'refresh'],
      ['auth', 'switch'],
      ['auth', 'setup-git'],
      ['auth', 'git-credential', 'get'],
      ['auth'],
    ],
    '%s never shows the token',
    argv => {
      expect(sentenceOf(...argv)).toContain('never shows its token');
    },
  );

  each(
    [
      ['config', 'get', 'oauth_token'],
      ['config', 'list'],
      ['config', 'set', 'editor', 'vim'],
    ],
    '%s: nothing to configure',
    argv => {
      expect(sentenceOf(...argv)).toContain('no config');
    },
  );

  each(
    [
      ['extension', 'install', 'o/gh-evil'],
      ['extensions'],
      ['ext', 'list'],
      ['alias', 'set', 'x', 'y'],
      ['codespace', 'ssh'],
      ['cs', 'list'],
    ],
    '%s runs a program with the token: not available',
    argv => {
      expect(sentenceOf(...argv)).toContain('not available');
    },
  );

  each(
    [
      ['pr', 'checkout', '12'],
      ['pr', 'co', '12'],
      ['repo', 'clone', 'o/r'],
      ['repo', 'sync'],
      ['repo', 'fork', 'o/r', '--clone'],
      ['repo', 'fork', 'o/r', '--clone=true'],
      ['repo', 'create', 'x', '--source', '.'],
      ['repo', 'create', 'x', '--push'],
      ['gist', 'clone', 'abc'],
      ['issue', 'develop', '4', '--checkout'],
      ['run', 'download', '9'],
      ['release', 'download', 'v1'],
    ],
    '%s runs git or writes into your folder: use git',
    argv => {
      expect(sentenceOf(...argv)).toContain('Use git');
    },
  );

  test('the git sentence shows the working replacement for a pull request', () => {
    expect(sentenceOf('pr', 'checkout', '12')).toContain('git fetch origin pull/12/head:pr-12');
  });

  each(
    [
      ['pr', 'list', '--hostname', 'evil.example'],
      ['api', 'user', '--hostname=evil.example'],
      ['pr', 'list', '--hostname', 'github.com'],
    ],
    '%s: github.com only',
    argv => {
      expect(sentenceOf(...argv)).toContain('github.com only');
    },
  );

  each(
    [
      ['pr', 'create', '--head', 'x', '--body-file', 'b.md'],
      ['issue', 'create', '--body-file', '-'],
      ['api', 'x', '--input', 'f.json'],
      ['api', 'x', '-F', 'a=@f'],
      ['release', 'create', 'v1', '--notes-file', 'n.md'],
    ],
    '%s reads a local file: pass the text',
    argv => {
      expect(sentenceOf(...argv)).toContain('does not read local files');
    },
  );

  each(
    [
      ['pr', 'list', '--jq', '.[]'],
      ['api', 'user', '--template', '{{.}}'],
      ['pr', 'list', '-q', 'x'],
    ],
    '%s: jq and templates can read the environment',
    argv => {
      expect(sentenceOf(...argv)).toContain('read the environment');
    },
  );

  test('-t is ambiguous: asks for the long flag', () => {
    expect(sentenceOf('pr', 'create', '--head', 'x', '-t', 'title')).toContain('--title');
  });

  test('pr create needs --head (gh cannot see the branch) and refuses --fill', () => {
    expect(sentenceOf('pr', 'create', '--title', 't')).toContain('--head');
    expect(sentenceOf('pr', 'create', '--head', 'x', '--fill')).toContain('git history');
  });

  each(
    [['extra'], ['frobnicate', 'now'], ['pr', 'frobnicate'], ['pr'], ['repo', 'delete', 'o/r'], ['browse']],
    '%s is not named in the allow-list',
    argv => {
      expect(verdict(...argv).kind).toBe('refuse');
    },
  );

  test('an unknown name is echoed bounded and without control characters', () => {
    const sentence = sentenceOf(`x\u001b[31m${'y'.repeat(200)}`);
    expect(sentence).not.toContain('\u001b');
    expect(sentence.length).toBeLessThan(300);
  });

  test('nothing at all is refused with a sentence', () => {
    expect(judgeGh([]).kind).toBe('refuse');
  });
});

describe('argv helpers', () => {
  test('the repository is named right after the command, once', () => {
    expect(withRepository(['pr', 'list', '--state', 'open'], 'o/r')).toEqual([
      'pr',
      'list',
      '-R',
      'o/r',
      '--state',
      'open',
    ]);
    expect(namesRepository(['pr', 'list', '-R', 'a/b'])).toBe(true);
    expect(namesRepository(['pr', 'list', '--repo=a/b'])).toBe(true);
    expect(namesRepository(['pr', 'list'])).toBe(false);
  });
  test('api placeholders are filled from the record, only in the endpoint, never in a flag value', () => {
    expect(fillPlaceholders(['api', 'repos/{owner}/{repo}/pulls', '-f', 'a={owner}'], 'o/r')).toEqual([
      'api',
      'repos/o/r/pulls',
      '-f',
      'a={owner}',
    ]);
  });
  test('only a followed run gets the long clock', () => {
    expect(isFollowing(['run', 'watch', '1'])).toBe(true);
    expect(isFollowing(['pr', 'checks', '--watch'])).toBe(true);
    expect(isFollowing(['pr', 'checks'])).toBe(false);
  });
});
