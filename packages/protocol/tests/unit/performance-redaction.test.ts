import { describe, it } from 'bun:test';
import should from 'should';
import { commandLabel, pathShape } from '../../src/lib/performance-redaction.ts';

const roots = { home: '/home/kirin' };
const STORE_HASH = 'abcdefghijklmnopqrstuvwxyz012345';
const UUID = '0123abcd-4567-89ab-cdef-0123456789ab';

describe('pathShape', () => {
  it.each([
    ['', '<empty>'],
    ['/home/kirin', '~'],
    ['/home/kirin/', '~'],
    ['/home/kirin/file', '~/file'],
    ['/home/kirin/.bashrc', '~/.bashrc'],
    ['/home/kirin/-secret-project', '~/<project>'],
    ['/home/kirin/work/secret-project/.mcp.json', '~/…/.mcp.json'],
    ['/home/kirin/work/secret-project/9f8e7d6c5b4a3f2e1d0c/rollout-2026-10-21.jsonl', '~/…/rollout-<date>.jsonl'],
    ['/home/kirin/work/mvir1r5g-90731a4e', '~/…/<session>'],
  ])('should write a path under home from ~ keeping only the file name (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;

    // Act
    const actual = subject(input, roots);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    [
      '/home/kirin/.ferretry/state/sessions/mvir1r5g-90731a4e/state.json',
      '~/.ferretry/state/sessions/<session>/state.json',
    ],
    ['/home/kirin/.claude/projects/-home-kirin-secret/abc.jsonl', '~/.claude/projects/<project>/abc.jsonl'],
    [`/home/kirin/.claude/todos/${UUID}.json`, '~/.claude/todos/<uuid>.json'],
    [
      '/home/kirin/.codex/sessions/2026/10/21/rollout-2026-10-21T08-12-44.jsonl',
      '~/.codex/sessions/<n>/<n>/<n>/rollout-<date>.jsonl',
    ],
    ['/home/kirin/.cache/deadbeefcafe1234', '~/.cache/<hex>'],
    ['/home/kirin/.ferretry/people@example.com', '~/.ferretry/<id>'],
    ['/home/kirin/.ferretry/MyProject', '~/.ferretry/<name>'],
  ])('should keep a dot-directory layout and replace identifiers by kind (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;

    // Act
    const actual = subject(input, roots);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    ['/', '/'],
    ['/etc/hosts', '/etc/hosts'],
    ['/proc/1234/stat', '/proc/<n>/stat'],
    ['/lib/libc-2.39.so', '/lib/libc-2.<n>.so'],
    ['/System/Library/CoreServices/Finder.app', '/System/Library/CoreServices/Finder.app'],
    [`/nix/store/${STORE_HASH}-tmux-3.5/bin/tmux`, '/nix/store/<hash>-tmux-3.5/bin/tmux'],
    ['/nix/store', '/nix/store/'],
  ])('should keep the shaped layout of a system path outside home (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;

    // Act
    const actual = subject(input, roots);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    ['/tmp', '/tmp'],
    ['/tmp/people@example.com', '/tmp/<id>'],
    ['/tmp/secret-project/state.json', '/tmp/…/state.json'],
    ['/Volumes/Work/client-x/src/app-2026-10-21.ts', '/Volumes/…/app-<date>.ts'],
    ['/home/other/file', '/home/…/file'],
    ['/home/kirinextra/file', '/home/…/file'],
    ['/-secret', '/<project>'],
  ])(
    'should keep only the first segment and the file name of a non-system path outside home (%s -> %s)',
    (input, expected) => {
      // Arrange
      const subject = pathShape;

      // Act
      const actual = subject(input, roots);

      // Assert
      should(actual).equal(expected);
    },
  );

  it.each([
    ['/data/fy', '<fy-home>'],
    ['/data/fy/', '<fy-home>'],
    ['/data/fy/state/sessions/mvir1r5g-90731a4e/state.json', '<fy-home>/state/sessions/<session>/state.json'],
    ['/data/fy/config/MyProject', '<fy-home>/config/<name>'],
    ['/data/fy/logs/daemon.log', '<fy-home>/logs/daemon.log'],
  ])(
    'should write a path under a state home outside home from <fy-home> keeping its layout (%s -> %s)',
    (input, expected) => {
      // Arrange
      const subject = pathShape;
      const stateRoots = { home: '/home/kirin', stateHome: '/data/fy/' };

      // Act
      const actual = subject(input, stateRoots);

      // Assert
      should(actual).equal(expected);
    },
  );

  it.each([
    ['/home/kirin/.ferretry/state/x.json', '~/.ferretry/state/x.json'],
    ['/data/other/file', '/data/…/file'],
    ['/data/fyx/file', '/data/…/file'],
  ])('should ignore a state home that is under home or does not contain the path (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;
    const stateRoots = { home: '/home/kirin', stateHome: '/home/kirin/.ferretry' };

    // Act
    const actual = subject(input, stateRoots);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    ['foo', '<relative>/foo'],
    ['foo/bar/baz42', '<relative>/baz<n>'],
  ])('should write a relative path by its last segment only (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;

    // Act
    const actual = subject(input, roots);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    ['/home/kirin/file', '/home/…/file'],
    ['/etc/hosts', '/etc/hosts'],
  ])('should treat nothing as home when no home is given (%s -> %s)', (input, expected) => {
    // Arrange
    const subject = pathShape;

    // Act
    const actual = subject(input, { home: '' });

    // Assert
    should(actual).equal(expected);
  });
});

describe('commandLabel', () => {
  it.each([
    [['tmux', '-u', '-S', '/run/user/1000/tmux-1000/default', 'capture-pane', '-p', '-t', '%1'], 'tmux capture-pane'],
    [['git', '-C', '/x', 'status'], 'git status'],
    [['ps', '-Ao', 'pid=,comm='], 'ps'],
    [['sh', '-c', 'text with spaces'], 'sh'],
    [['/usr/bin/tmux', 'list-sessions'], 'tmux list-sessions'],
    [['ls', 'a'], 'ls'],
    [['/'], '<unknown>'],
    [[''], '<unknown>'],
    [[], '<unknown>'],
  ] as [string[], string][])('should keep only the program and subcommand (%j -> %s)', (input, expected) => {
    // Arrange
    const subject = commandLabel;

    // Act
    const actual = subject(input);

    // Assert
    should(actual).equal(expected);
  });
});
