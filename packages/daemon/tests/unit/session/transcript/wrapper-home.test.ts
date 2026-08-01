import { describe, it } from 'bun:test';
import should from 'should';
import { harnessHomeFromWrapper } from '../../../../src/lib/session/transcript/index.ts';

const ENVIRONMENT = { HOME: '/home/agent', FY_HOME: '/home/agent/.ferretry' };

describe('harnessHomeFromWrapper', () => {
  it('should read the claude home a wrapper exports', () => {
    // Arrange
    const source = ['#!/usr/bin/env bash', 'export CLAUDE_CONFIG_DIR="$HOME/.claude-loge"', 'exec claude "$@"'].join(
      '\n',
    );

    // Act
    const home = harnessHomeFromWrapper(source, 'claude', ENVIRONMENT);

    // Assert
    should(home).equal('/home/agent/.claude-loge');
  });

  it('should read the codex home from the variable that harness actually uses', () => {
    // Arrange: both variables are present, which is what a wrapper that can drive either looks like.
    const source = 'export CLAUDE_CONFIG_DIR=/home/agent/.claude\nexport CODEX_HOME=/home/agent/.codex-terra\n';

    // Act
    const claude = harnessHomeFromWrapper(source, 'claude', ENVIRONMENT);
    const codex = harnessHomeFromWrapper(source, 'codex', ENVIRONMENT);

    // Assert
    should(claude).equal('/home/agent/.claude');
    should(codex).equal('/home/agent/.codex-terra');
  });

  it('should accept the bare, single-quoted and braced forms a generated wrapper writes', () => {
    // Arrange / Act
    const bare = harnessHomeFromWrapper('CODEX_HOME=/opt/codex', 'codex', ENVIRONMENT);
    const quoted = harnessHomeFromWrapper("export CODEX_HOME='/opt/codex'", 'codex', ENVIRONMENT);
    const braced = harnessHomeFromWrapper('export CODEX_HOME="${FY_HOME}/codex"', 'codex', ENVIRONMENT);
    const tilde = harnessHomeFromWrapper('export CODEX_HOME=~/.codex', 'codex', ENVIRONMENT);

    // Assert
    should(bare).equal('/opt/codex');
    should(quoted).equal('/opt/codex');
    should(braced).equal('/home/agent/.ferretry/codex');
    should(tilde).equal('/home/agent/.codex');
  });

  it('should stop an unquoted value at a trailing comment', () => {
    // Arrange / Act
    const home = harnessHomeFromWrapper('export CODEX_HOME=/opt/codex #the account home', 'codex', ENVIRONMENT);

    // Assert
    should(home).equal('/opt/codex');
  });

  it('should refuse a home it cannot fully expand rather than answer a half-resolved path', () => {
    // Arrange: an absolute-looking `/agents/codex` would be a directory nobody ever writes to.
    const unknownVariable = harnessHomeFromWrapper('export CODEX_HOME=$AGENT_ROOT/agents/codex', 'codex', ENVIRONMENT);
    const noHome = harnessHomeFromWrapper('export CODEX_HOME=~/.codex', 'codex', {});

    // Act / Assert
    should(unknownVariable).be.undefined();
    should(noHome).be.undefined();
  });

  it('should refuse a relative home, an empty assignment, and a wrapper that declares none', () => {
    // Arrange / Act
    const relative = harnessHomeFromWrapper('export CODEX_HOME=.codex', 'codex', ENVIRONMENT);
    const empty = harnessHomeFromWrapper('export CODEX_HOME=""', 'codex', ENVIRONMENT);
    const absent = harnessHomeFromWrapper('exec codex "$@"', 'codex', ENVIRONMENT);

    // Assert
    should(relative).be.undefined();
    should(empty).be.undefined();
    should(absent).be.undefined();
  });

  it('should not read an assignment that is part of another word', () => {
    // Arrange: `OTHER_CODEX_HOME` is a different variable and must not be mistaken for this one.
    const source = 'export OTHER_CODEX_HOME=/wrong\nexport CODEX_HOME=/right\n';

    // Act
    const home = harnessHomeFromWrapper(source, 'codex', ENVIRONMENT);

    // Assert
    should(home).equal('/right');
  });
});
