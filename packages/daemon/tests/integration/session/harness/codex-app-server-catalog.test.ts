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

/**
 * A wall-clock bound around a probe that is SUPPOSED to give up on its own.
 *
 * Without it, the regression these cases exist to catch — a deadline that bounds nothing — presents
 * as a hung tier rather than a failed assertion, and the tier's own budget is a `--timeout` flag
 * this file cannot rely on. Generous against the 200ms deadlines below: the point is to fail, not to
 * measure.
 */
const bounded = async <Value>(work: Promise<Value>): Promise<Value> =>
  await Promise.race([
    work,
    Bun.sleep(4_000).then(() => {
      throw new Error('the probe never settled — its deadline is not bounding the read');
    }),
  ]);

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

  it('should time out on a child that ignores SIGTERM, rather than waiting for it to relent', async () => {
    // THE COOPERATIVE CHILD ABOVE PROVES ALMOST NOTHING. `sleep 30` dies on SIGTERM, so its pipe
    // EOFs and a probe that only kills the process still appears to honour its deadline. This child
    // does not die, and the previous implementation never settled at all against it.
    // Arrange — a bounded sleep, so a regression cannot leave a process behind after the suite.
    const { binary, cwd } = wrapper('trap "" TERM; cat > /dev/null; sleep 5');

    // Act — raced, so a regression FAILS here instead of hanging the tier. The per-test timeout is a
    // CLI flag on this tier, not something a file can rely on.
    const failure = await bounded(
      subject(200)
        .models(binary, cwd)
        .catch(error => error),
    );

    // Assert
    should(failure).match({ message: /timed out after 200ms/u });
  });

  it('should time out when a descendant inherited stdout and the child itself has exited', async () => {
    // The other shape, and the likelier one for a real app-server: the process the daemon spawned is
    // long gone, but a grandchild still holds the write end of the pipe open, so the read never
    // returns and killing the child changes nothing.
    // Arrange
    const { binary, cwd } = wrapper('sleep 5 & cat > /dev/null; exec sleep 0.2');

    // Act
    const failure = await bounded(
      subject(200)
        .models(binary, cwd)
        .catch(error => error),
    );

    // Assert
    should(failure).match({ message: /timed out after 200ms/u });
  });

  it('should keep the timeout and the early ending two different sentences', async () => {
    // They call for opposite reactions — wait and retry, versus read the child's own complaint — so
    // a refactor that collapsed them into one message would be a real loss.
    // Arrange
    const stubborn = wrapper('trap "" TERM; cat > /dev/null; sleep 5');
    const quiet = wrapper('exit 3');

    // Act
    const expired = await bounded(
      subject(200)
        .models(stubborn.binary, stubborn.cwd)
        .catch(error => error),
    );
    const ended = await subject()
      .models(quiet.binary, quiet.cwd)
      .catch(error => error);

    // Assert
    should(expired).match({ message: /timed out after/u });
    should(expired.message).not.match(/ended before the catalog was complete/u);
    should(ended).match({ message: /ended before the catalog was complete/u });
    should(ended.message).not.match(/timed out after/u);
  });

  it('should name the child diagnostics on a timeout too, not only on an early ending', async () => {
    // Arrange — it complains, then refuses to die.
    const { binary, cwd } = wrapper('trap "" TERM; echo "no provider configured" >&2; cat > /dev/null; sleep 5');

    // Act
    const failure = await bounded(
      subject(200)
        .models(binary, cwd)
        .catch(error => error),
    );

    // Assert
    should(failure).match({ message: /timed out after 200ms: no provider configured/u });
  });

  it('should settle and still quote stderr when a descendant holds BOTH pipes open', async () => {
    // The nastiest shape, and the one that decides whether the daemon keeps a background read alive
    // for ever: the child complains, leaves a descendant holding stdout AND stderr, and exits. Neither
    // stream will ever reach EOF, so a probe that waits for stderr to end never answers, and a drain
    // nobody cancels outlives the probe holding a descriptor.
    // Arrange
    const { binary, cwd } = wrapper('echo "no provider configured" >&2; sleep 5 & cat > /dev/null; exec sleep 0.2');

    // Act
    const failure = await bounded(
      subject(200)
        .models(binary, cwd)
        .catch(error => error),
    );

    // Assert: bounded AND still carrying the partial diagnostic the child managed to write.
    should(failure).match({ message: /timed out after 200ms: no provider configured/u });
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
