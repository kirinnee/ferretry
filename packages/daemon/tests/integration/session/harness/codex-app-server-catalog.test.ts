import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { CodexAppServerCatalog } from '../../../../src/adapters/index.ts';

/**
 * Probing a real child for a Codex model catalog.
 *
 * The child here is a shell script that speaks the same line-delimited JSON-RPC a Codex app-server
 * does. It is a REAL child on a REAL pipe — the whole point of this tier — because the failures worth
 * catching are the ones a fake stream cannot have: a process that exits mid-exchange, one that never
 * answers, one that writes something that is not JSON at all.
 */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake wrapper that replays `body` and then behaves as `after` says. */
function wrapper(script: string): { readonly binary: string; readonly cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'fy-codex-probe-'));
  roots.push(root);
  const binary = join(root, 'codex-auto-test');
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { binary, cwd: root };
}

const MODEL_PAGE = JSON.stringify({
  id: 2,
  result: {
    data: [
      {
        model: 'gpt-5.6-codex',
        displayName: 'GPT-5.6 Codex',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'medium',
      },
    ],
  },
});

/**
 * Reads whole request lines and answers each with the next scripted reply.
 *
 * A numbered `case` rather than a shell array: the replies are JSON, and JSON in a shell array
 * subscript is a quoting problem waiting to bite. The `initialized` notification is skipped so each
 * reply lines up with the request that logically asks for it.
 */
const responder = (replies: readonly string[]) =>
  [
    'set -euo pipefail',
    'index=0',
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    *initialized*) continue ;;',
    '  esac',
    '  index=$((index + 1))',
    '  case "$index" in',
    ...replies.map((reply, position) => `    ${position + 1}) printf '%s\\n' '${reply}' ;;`),
    '  esac',
    'done',
  ].join('\n');

const subject = (timeoutMs = 5_000) =>
  new CodexAppServerCatalog({
    clientName: 'fyd',
    clientVersion: '0.0.0-test',
    timeoutMs,
    // Never the real environment: the child gets an allowlist, and a test must not decide what is on
    // it by inheriting whatever the runner happened to export.
    environment: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });

describe('the Codex app-server catalog probe', () => {
  it('should read a catalog from a real child over a real pipe', async () => {
    // Arrange
    const { binary, cwd } = wrapper(responder([JSON.stringify({ id: 1, result: {} }), MODEL_PAGE]));

    // Act
    const choices = await subject().models(binary, cwd);

    // Assert
    should(choices).deepEqual([
      {
        value: 'gpt-5.6-codex',
        label: 'GPT-5.6 Codex',
        reasoningEfforts: [{ value: 'medium' }, { value: 'high' }],
        defaultReasoningEffort: 'medium',
      },
    ]);
  });

  it('should follow a cursor across two pages of one child', async () => {
    // Arrange
    const first = JSON.stringify({ id: 2, result: { data: [{ model: 'a' }], nextCursor: 'page-2' } });
    const second = JSON.stringify({ id: 3, result: { data: [{ model: 'b' }] } });
    const { binary, cwd } = wrapper(responder([JSON.stringify({ id: 1, result: {} }), first, second]));

    // Act
    const choices = await subject().models(binary, cwd);

    // Assert
    should(choices.map(choice => choice.value)).deepEqual(['a', 'b']);
  });

  it('should run the account executable in the session directory', async () => {
    // The wrapper carries the harness home and the credentials; the working directory carries the
    // project configuration. Both decide which models Codex offers, so a probe run anywhere else
    // answers a question nobody asked.
    // Arrange — the child reports its own argv and cwd on stderr, and the assertion is that it ran.
    const { binary, cwd } = wrapper(
      [
        `test "$1" = "app-server" || exit 3`,
        `test "$2" = "--stdio" || exit 4`,
        `test "$PWD" = "${''}$(pwd)" || exit 5`,
        responder([JSON.stringify({ id: 1, result: {} }), MODEL_PAGE]),
      ].join('\n'),
    );

    // Act
    const choices = await subject().models(binary, cwd);

    // Assert
    should(choices).have.length(1);
  });

  it('should refuse a wrapper path that is not absolute', async () => {
    // A relative name is looked up on `PATH`, which for a daemon under a service manager is whatever
    // that manager exported — so it can land on a different Codex than the session is running.
    // Act
    const failure = await subject()
      .models('codex-auto-test', '/tmp')
      .catch(error => error);

    // Assert
    should(failure).match({ message: /needs an absolute wrapper path/u });
  });

  it('should refuse a session directory that is not absolute', async () => {
    // Act
    const failure = await subject()
      .models('/fleet/bin/codex-auto', 'work')
      .catch(error => error);

    // Assert
    should(failure).match({ message: /needs an absolute session directory/u });
  });

  it('should restate a refusal the app-server itself returned', async () => {
    // Arrange
    const refusal = JSON.stringify({ id: 2, error: { message: 'this account is not signed in' } });
    const { binary, cwd } = wrapper(responder([JSON.stringify({ id: 1, result: {} }), refusal]));

    // Act
    const failure = await subject()
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /this account is not signed in/u });
  });

  it('should refuse output that is not JSON at all', async () => {
    // Arrange
    const { binary, cwd } = wrapper('printf "not json at all\\n"; cat > /dev/null');

    // Act
    const failure = await subject()
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /wrote a non-JSON model catalog response/u });
  });

  it('should name the child diagnostics when it exits before the catalog is complete', async () => {
    // Arrange
    const { binary, cwd } = wrapper('echo "codex: missing config" >&2; exit 1');

    // Act
    const failure = await subject()
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /ended before the catalog was complete: codex: missing config/u });
  });

  it('should end honestly when a silent child exits with nothing to say', async () => {
    // Arrange
    const { binary, cwd } = wrapper('exit 0');

    // Act
    const failure = await subject()
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /ended before the catalog was complete$/u });
  });

  it('should kill and report a child that never answers', async () => {
    // A probe with no deadline holds a pipe open for as long as the child feels like living.
    // Arrange
    const { binary, cwd } = wrapper('cat > /dev/null; sleep 30');

    // Act
    const failure = await subject(200)
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /timed out after/u });
  });

  it('should refuse a child that answers with no selectable model', async () => {
    // Arrange
    const empty = JSON.stringify({ id: 2, result: { data: [] } });
    const { binary, cwd } = wrapper(responder([JSON.stringify({ id: 1, result: {} }), empty]));

    // Act
    const failure = await subject()
      .models(binary, cwd)
      .catch(error => error);

    // Assert
    should(failure).match({ message: /did not advertise any selectable runtime models/u });
  });

  it('should ignore blank lines and notifications between the replies it needs', async () => {
    // An app-server also emits notifications. Reading one as a catalog page would end the exchange
    // with whatever it happened to contain.
    // Arrange — a blank line and a notification arrive before either reply the probe is waiting on.
    const noise = JSON.stringify({ method: 'thread/event', params: {} });
    const { binary, cwd } = wrapper(
      [
        'set -euo pipefail',
        'printf "\\n"',
        `printf '%s\\n' '${noise}'`,
        `printf '%s\\n' '${JSON.stringify({ id: 1, result: {} })}'`,
        `printf '%s\\n' '${noise}'`,
        `printf '%s\\n' '${MODEL_PAGE}'`,
        'cat > /dev/null',
      ].join('\n'),
    );

    // Act
    const choices = await subject().models(binary, cwd);

    // Assert
    should(choices.map(choice => choice.value)).deepEqual(['gpt-5.6-codex']);
  });
});
