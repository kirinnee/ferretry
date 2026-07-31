import { describe, it } from 'bun:test';
import should from 'should';
import {
  contextPercent,
  contextWindowFor,
  harnessDisplayName,
  remoteControlArgs,
  resolveParent,
  shellSafeSessionName,
} from '../../../src/lib/core/index.ts';

describe('harnessDisplayName', () => {
  it.each([
    {
      label: 'a callsign and a task',
      config: { teammate: 'hayden', name: 'Fix Login' },
      expected: '[Hayden] Fix Login',
    },
    {
      label: 'a hyphenated callsign',
      config: { teammate: 'mary-jane', name: 'Fix Login' },
      expected: '[Mary-Jane] Fix Login',
    },
    { label: 'a callsign alone', config: { teammate: 'hayden' }, expected: '[Hayden]' },
    { label: 'a task alone', config: { name: 'Fix Login' }, expected: 'Fix Login' },
  ])('should compose a title from $label', ({ config, expected }) => {
    // Arrange / Act / Assert
    should(harnessDisplayName(config)).equal(expected);
  });

  it('should pass an already-bracketed title through rather than double the prefix', () => {
    // Arrange / Act
    const title = harnessDisplayName({ teammate: 'hayden', name: '[Hayden] Fix Login' });

    // Assert
    should(title).equal('[Hayden] Fix Login');
  });

  it('should name nothing at all rather than pass an empty title', () => {
    // Arrange / Act / Assert
    should(harnessDisplayName({ teammate: '  ', name: '  ' })).be.undefined();
    should(harnessDisplayName({})).be.undefined();
  });

  it('should survive a callsign with an empty segment', () => {
    // Arrange / Act / Assert
    should(harnessDisplayName({ teammate: 'a--b' })).equal('[A--B]');
  });
});

describe('resolveParent', () => {
  it('should let an explicit parent win over everything', () => {
    // Arrange / Act
    const parent = resolveParent({ explicit: ' chosen ', environmentSessionId: 'ambient', mode: 'auto' });

    // Assert
    should(parent).equal('chosen');
  });

  it('should let an unattended session inherit the pane it was started from', () => {
    // Arrange / Act
    const parent = resolveParent({ environmentSessionId: 'ambient', mode: 'auto' });

    // Assert
    should(parent).equal('ambient');
  });

  it('should never parent a human’s own terminal under the agent that typed the command', () => {
    // Arrange / Act
    const parent = resolveParent({ environmentSessionId: 'ambient', mode: 'interactive' });

    // Assert
    should(parent).be.undefined();
  });

  it('should treat a blank environment value as no parent', () => {
    // Arrange / Act / Assert
    should(resolveParent({ explicit: '  ', environmentSessionId: '  ', mode: 'auto' })).be.undefined();
    should(resolveParent({ mode: 'auto' })).be.undefined();
  });
});

describe('shellSafeSessionName', () => {
  it('should replace everything a shell or tmux would object to', () => {
    // Arrange / Act
    const name = shellSafeSessionName('fy', 'ab/cd 12:34', 'main');

    // Assert
    should(name).equal('fy-ab-cd-12-34-main');
  });

  it('should keep the suffix when the identity is too long to fit', () => {
    // Arrange
    const id = 'x'.repeat(200);

    // Act
    const name = shellSafeSessionName('fy', id, 'agent');

    // Assert — the source truncated last and could drop the suffix, colliding two windows
    should(name.length).be.belowOrEqual(80);
    should(name).endWith('-agent');
    should(name).startWith('fy-');
  });

  it('should still produce a bounded name when the suffix alone fills the budget', () => {
    // Arrange / Act
    const name = shellSafeSessionName('fy', 'session', 'y'.repeat(120));

    // Assert
    should(name.length).equal(80);
  });
});

describe('remoteControlArgs', () => {
  it('should label the remote surface with the teammate it belongs to', () => {
    // Arrange / Act
    const args = remoteControlArgs({ harness: 'claude', teammate: 'hayden', id: 'session-1' }, 'fy');

    // Assert
    should(args).deepEqual(['--chrome', '--rc', '--remote-control-session-name-prefix', 'fy-hayden']);
  });

  it('should fall back to the session identity when there is no teammate', () => {
    // Arrange / Act
    const args = remoteControlArgs({ harness: 'claude', teammate: '  ', id: 'session-1' }, 'fy');

    // Assert
    should(args[3]).equal('fy-session-1');
  });

  it('should add nothing for a harness with no remote surface', () => {
    // Arrange / Act
    const args = remoteControlArgs({ harness: 'codex', id: 'session-1' }, 'fy');

    // Assert
    should(args).deepEqual([]);
  });
});

describe('contextWindowFor', () => {
  it('should believe a harness that reports its own window', () => {
    // Arrange / Act
    const window = contextWindowFor({ reportedWindow: 272_000, configuredModel: 'model-a[1m]' });

    // Assert
    should(window).equal(272_000);
  });

  it('should ignore a reported window that is not a real size', () => {
    // Arrange / Act / Assert
    should(contextWindowFor({ reportedWindow: 0 })).equal(200_000);
    should(contextWindowFor({ reportedWindow: Number.NaN })).equal(200_000);
  });

  it('should prefer the longest matching override so a specific id beats a family', () => {
    // Arrange
    const overrides = { 'model-a': 128_000, 'model-a-pro': 256_000 };

    // Act
    const window = contextWindowFor({ servedModel: 'model-a-pro', overrides });

    // Assert
    should(window).equal(256_000);
  });

  it('should match an override against the configured model when nothing is served yet', () => {
    // Arrange / Act
    const window = contextWindowFor({ configuredModel: 'model-b', overrides: { 'model-b': 64_000 } });

    // Assert
    should(window).equal(64_000);
  });

  it('should skip an override whose value is not a usable window', () => {
    // Arrange / Act
    const window = contextWindowFor({ servedModel: 'model-c', overrides: { 'model-c': 0, '': 5 } });

    // Assert
    should(window).equal(200_000);
  });

  it('should read the extended marker off the configured id the harness strips', () => {
    // Arrange — the served id never carries the marker, so deciding from it alone inflated context
    const window = contextWindowFor({ configuredModel: 'model-a[1m]', servedModel: 'model-a' });

    // Assert
    should(window).equal(1_000_000);
  });

  it('should read the extended marker off a served id that does carry it', () => {
    // Arrange / Act
    const window = contextWindowFor({ servedModel: 'model-a[1m]' });

    // Assert
    should(window).equal(1_000_000);
  });

  it('should let an override beat the extended marker', () => {
    // Arrange / Act
    const window = contextWindowFor({ configuredModel: 'model-a[1m]', overrides: { 'model-a': 300_000 } });

    // Assert
    should(window).equal(300_000);
  });

  it('should default when nothing at all is known', () => {
    // Arrange / Act / Assert
    should(contextWindowFor({})).equal(200_000);
    should(contextWindowFor({ servedModel: '  ', overrides: {} })).equal(200_000);
  });
});

describe('contextPercent', () => {
  it.each([
    { label: 'a partly used window', used: 50_000, window: 200_000, expected: 25 },
    { label: 'one decimal of precision', used: 1_234, window: 200_000, expected: 0.6 },
    { label: 'an overfull window', used: 400_000, window: 200_000, expected: 100 },
    { label: 'an untouched window', used: 0, window: 200_000, expected: 0 },
    { label: 'a window that is not known', used: 1_000, window: 0, expected: 0 },
    { label: 'a token count that is not a number', used: Number.NaN, window: 200_000, expected: 0 },
  ])('should report $label', ({ used, window, expected }) => {
    // Arrange / Act / Assert
    should(contextPercent(used, window)).equal(expected);
  });
});
