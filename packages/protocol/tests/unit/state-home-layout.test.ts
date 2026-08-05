import { describe, it } from 'bun:test';
import should from 'should';
import {
  CURRENT_LAYOUT_VERSION,
  decideLayout,
  LAYOUT_VERSION_FILENAME,
  LAYOUT_VERSION_MODE,
  layoutVersionContent,
} from '../../src/lib/state-home-layout.ts';

describe('the layout claim both writers must agree on', () => {
  it('should publish one filename, content and mode, so neither side spells them twice', () => {
    // Assert — a daemon looking for one name while its client writes another is a daemon that
    // refuses the very home the client just claimed, and neither end explains why.
    should(LAYOUT_VERSION_FILENAME).equal('layout-version');
    should(layoutVersionContent()).equal('1\n');
    should(LAYOUT_VERSION_MODE).equal(0o600);
  });

  it('should render the content for whichever version it is given', () => {
    // Act + Assert — the default is the current version; the parameter exists so a test of a future
    // or legacy home composes its bytes the same way production would.
    should(layoutVersionContent(CURRENT_LAYOUT_VERSION)).equal(layoutVersionContent());
    should(layoutVersionContent(7)).equal('7\n');
  });
});

describe('deciding whether a directory may be used as a state home', () => {
  it('should initialize an empty directory', () => {
    // Act + Assert
    should(decideLayout(undefined, [])).deepEqual({ kind: 'initialize', version: CURRENT_LAYOUT_VERSION });
  });

  it('should refuse a non-empty directory carrying no marker', () => {
    // The rule the whole module exists to keep: never adopt a directory Ferretry did not create.
    // This arm is also exactly what the client used to manufacture by provisioning without claiming.
    should(decideLayout(undefined, ['Documents', 'notes.txt'])).deepEqual({
      kind: 'refuse',
      reason: 'missing-marker',
      found: undefined,
      expected: CURRENT_LAYOUT_VERSION,
    });
  });

  it('should initialize a non-empty directory the caller recognised as our own partial work', () => {
    // Recognising a partial bootstrap means walking a filesystem, so it is an INPUT rather than a
    // decision made here — which is what keeps this function pure and callable from both packages.
    should(decideLayout(undefined, ['logs'], true)).deepEqual({
      kind: 'initialize',
      version: CURRENT_LAYOUT_VERSION,
    });
  });

  it('should proceed on a home carrying the version this release serves', () => {
    // Act + Assert
    should(decideLayout('1\n', ['layout-version', 'fleet'])).deepEqual({
      kind: 'proceed',
      version: CURRENT_LAYOUT_VERSION,
    });
  });

  it('should tolerate surrounding whitespace in a marker', () => {
    // A person repairing a home by hand will not reproduce the bytes exactly, and refusing them over
    // a stray newline would be a refusal with no safety value.
    should(decideLayout('  1  \n', ['layout-version']).kind).equal('proceed');
  });

  it('should refuse a version this release cannot serve, reporting what it found', () => {
    // Act + Assert
    should(decideLayout('2', ['layout-version'])).deepEqual({
      kind: 'refuse',
      reason: 'unsupported-version',
      found: '2',
      expected: CURRENT_LAYOUT_VERSION,
    });
  });

  it('should refuse a marker that is not a version at all', () => {
    // Damaged state is never empty state: a truncated or scribbled marker must refuse rather than
    // read as an unclaimed home and get overwritten.
    for (const damaged of ['', 'one', '0', '-1', '1.5', '01']) {
      should(decideLayout(damaged, ['layout-version']).kind).equal('refuse');
    }
    const damaged = decideLayout('nonsense', []);
    should(damaged.kind === 'refuse' && damaged.reason).equal('invalid-version');
  });

  it('should refuse a damaged marker even in an otherwise empty directory', () => {
    // Emptiness does not launder a marker we cannot read — the marker is the stronger evidence.
    should(decideLayout('bogus', []).kind).equal('refuse');
  });
});
