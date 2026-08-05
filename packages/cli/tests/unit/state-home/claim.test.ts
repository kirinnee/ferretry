import { describe, it } from 'bun:test';
import should from 'should';
import {
  STATE_HOME_MODE,
  StateHomeClaimRefusedError,
  StateHomeClaimService,
  unexpectedHomeEntries,
} from '../../../src/lib/state-home/claim';
import { directories, FakeStateHomeFiles, files } from './fixtures';

const HOME = '/tmp/fy-home/.ferretry';
const MARKER = `${HOME}/layout-version`;

function service(entries?: readonly { name: string; directory: boolean }[], marker?: string) {
  const store = new FakeStateHomeFiles(entries, marker);
  return { store, claims: new StateHomeClaimService(store, 'fy daemon adopt') };
}

describe('claiming a state home before writing into it', () => {
  it('should create and claim a home that does not exist yet', async () => {
    // Arrange — a machine that has never run this.
    const { store, claims } = service(undefined);

    // Act
    const claim = await claims.claim(HOME);

    // Assert
    should(claim).deepEqual({ kind: 'claimed', home: HOME });
    should(store.created).deepEqual([{ path: HOME, mode: STATE_HOME_MODE }]);
    should(store.writes).deepEqual([{ path: MARKER, contents: '1\n', mode: 0o600 }]);
  });

  it('should claim a home that exists but is empty', async () => {
    // Arrange — an operator ran `mkdir -p "$FY_HOME"` before their first command, which is exactly
    // what the reported reproduction did.
    const { store, claims } = service([]);

    // Act
    const claim = await claims.claim(HOME);

    // Assert
    should(claim.kind).equal('claimed');
    should(store.writes).have.length(1);
  });

  it('should change nothing on a home that already carries our marker', async () => {
    // Arrange
    const { store, claims } = service(files('layout-version'), '1\n');

    // Act
    const claim = await claims.claim(HOME);

    // Assert — idempotent, because every write path calls this unconditionally rather than each one
    // deciding for itself when a claim applies.
    should(claim).deepEqual({ kind: 'already-claimed', home: HOME });
    should(store.writes).be.empty();
  });

  it('should tolerate a marker written with trailing whitespace', async () => {
    // Arrange — the content is `1\n`, but a person repairing a home by hand may not reproduce it
    // byte for byte, and refusing them over an extra newline would be gratuitous.
    const { claims } = service(files('layout-version'), '  1  \n');

    // Act + Assert
    should((await claims.claim(HOME)).kind).equal('already-claimed');
  });

  it('should claim a home holding only an older release s unclaimed log directory', async () => {
    // Arrange — REQUIRED, not a convenience. An older `fy` creates `<state home>/logs` before
    // launching the daemon and claims nothing, so every host upgrading to this release arrives in
    // exactly this state. Refusing them would turn the fix into a fresh breakage for every existing
    // installation — the very failure mode being removed.
    const { store, claims } = service(directories('logs'));

    // Act
    const claim = await claims.claim(HOME);

    // Assert
    should(claim.kind).equal('claimed');
    should(store.writes).have.length(1);
  });

  it('should not silently adopt a provisioned installation the way it adopts a lone log directory', async () => {
    // Arrange — the tolerance above is exactly as wide as the daemon's `preBootstrapShape` and no
    // wider. A `fleet/` says a real installation was provisioned here, and taking one over without
    // anybody looking is the judgement `adopt` exists to put in front of a person.
    const { store, claims } = service(directories('logs', 'fleet'));

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    should(store.writes).be.empty();
  });

  it('should not mistake a FILE named logs for the log directory', async () => {
    // Arrange — a file of that name is not something either writer produces, so it is foreign state.
    const { claims } = service(files('logs'));

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
  });

  it('should refuse a directory Ferretry did not create, and name what it found', async () => {
    // Arrange — the guard the client did NOT apply before this change: `fy fleet init` would happily
    // provision a fleet into somebody's documents folder.
    const { store, claims } = service([...directories('Documents'), ...files('notes.txt')]);

    // Act
    const failure = await claims.claim(HOME).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — refused, having written absolutely nothing.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('Documents');
    should((failure as Error).message).containEql('notes.txt');
    should((failure as Error).message).containEql('fy daemon adopt');
    should(store.writes).be.empty();
    should(store.created).be.empty();
  });

  it('should refuse a home whose layout version this release cannot serve', async () => {
    // Arrange — a newer release's home. Writing our marker over it would silently downgrade it.
    const { store, claims } = service(files('layout-version'), '2\n');

    // Act
    const failure = await claims.claim(HOME).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — and this refusal does NOT offer adoption, because adopting cannot repair it.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('"2"');
    should((failure as Error).message).not.containEql('adopt');
    should(store.writes).be.empty();
  });

  it('should refuse a marker that is not a version at all', async () => {
    // Arrange — a truncated or corrupted marker is damaged state, never empty state.
    const { claims } = service(files('layout-version'), 'not-a-number\n');

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
  });

  it('should list only the first few unexpected entries, then say how many more', async () => {
    // Arrange — a message that scrolled a wrong FY_HOME off the screen would defeat its own purpose.
    const many = Array.from({ length: 12 }, (_, index) => `entry-${String(index).padStart(2, '0')}`);
    const { claims } = service(directories(...many));

    // Act
    const failure = (await claims.claim(HOME).catch((error: unknown) => error)) as Error;

    // Assert
    should(failure.message).containEql('entry-00');
    should(failure.message).containEql('and 4 more');
    should(failure.message).not.containEql('entry-11');
  });

  it('should assert the owner-only mode on a home that already exists', async () => {
    // Arrange — an earlier release or a manual `mkdir` can leave a home with a permissive mode, and
    // the home holds an owner-only credential and the daemon's private identity key.
    const { store, claims } = service([]);

    // Act
    await claims.claim(HOME);

    // Assert
    should(store.created[0]?.mode).equal(0o700);
  });
});

describe('recognising what Ferretry itself writes at the top of a home', () => {
  it('should accept every entry the two writers actually create', () => {
    // Arrange — `api-token` is minted at the TOP of the home rather than under `state/`; omitting it
    // would make the repair command refuse a real owner's home.
    const ours = [
      ...directories('config', 'fleet', 'logs', 'state'),
      ...files('layout-version', 'daemon.lock', 'api-token'),
    ];

    // Act + Assert
    should(unexpectedHomeEntries(ours)).be.empty();
  });

  it('should accept the marker s own scratch file, left by an interrupted claim', () => {
    // Arrange — a crash between write and rename leaves this, and a home that then read as foreign
    // would be unrepairable by the very command meant to repair it.
    const entries = files('layout-version.7f3a9c21-0000-4000-8000-000000000000.tmp');

    // Act + Assert
    should(unexpectedHomeEntries(entries)).be.empty();
  });

  it('should not accept a temporary file that is not the marker s', () => {
    // Act + Assert — the pattern is anchored on purpose; anything else is somebody else's file.
    should(unexpectedHomeEntries(files('layout-version.tmp'))).deepEqual(['layout-version.tmp']);
    should(unexpectedHomeEntries(files('other.abc.tmp'))).deepEqual(['other.abc.tmp']);
    should(unexpectedHomeEntries(files('layout-version.has spaces.tmp'))).deepEqual(['layout-version.has spaces.tmp']);
  });

  it('should report unexpected entries sorted, so a message reads the same every time', () => {
    // Act + Assert
    should(unexpectedHomeEntries([...files('zeta.txt'), ...directories('alpha')])).deepEqual(['alpha', 'zeta.txt']);
  });
});

describe('adopting a home Ferretry created before claims existed', () => {
  it('should adopt a provisioned fleet, which the daemon s silent recovery refuses', async () => {
    // Arrange — the state every owner on the released version is in. The daemon may not adopt this
    // unattended; a person who has been shown the contents may.
    const { store, claims } = service(directories('fleet', 'logs'));

    // Act
    const adoption = await claims.adopt(HOME);

    // Assert
    should(adoption).deepEqual({ kind: 'adopted', home: HOME, entries: ['fleet', 'logs'] });
    should(store.writes).deepEqual([{ path: MARKER, contents: '1\n', mode: 0o600 }]);
  });

  it('should report a home that is already claimed and change nothing', async () => {
    // Arrange
    const { store, claims } = service([...directories('fleet'), ...files('layout-version')], '1\n');

    // Act
    const adoption = await claims.adopt(HOME);

    // Assert — a repair somebody may have run once already must not become a second failure.
    should(adoption.kind).equal('already-claimed');
    should(store.writes).be.empty();
  });

  it('should refuse a home holding anything Ferretry does not write, and name it', async () => {
    // Arrange — broader than the daemon's shape, but still never a stranger's directory.
    const { store, claims } = service([...directories('fleet'), ...files('thesis.tex')]);

    // Act
    const failure = await claims.adopt(HOME).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — and it does NOT tell the person to run the command they are already running: advice
    // just followed reads as a loop and implies a second attempt would work.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('thesis.tex');
    should((failure as Error).message).not.containEql('fleet');
    should((failure as Error).message).not.containEql('fy daemon adopt');
    should(store.writes).be.empty();
  });

  it('should refuse to overwrite a marker whose version it does not understand', async () => {
    // Arrange — claiming over a future version would downgrade a newer release's home silently.
    const { store, claims } = service(files('layout-version'), '99\n');

    // Act + Assert
    await should(claims.adopt(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    should(store.writes).be.empty();
  });

  it('should not create a home that is simply not there', async () => {
    // Arrange — an adopt recognises a home; it does not manufacture one. A typo in FY_HOME must not
    // silently produce an empty installation the person then wonders about.
    const { store, claims } = service(undefined);

    // Act
    const adoption = await claims.adopt(HOME);

    // Assert
    should(adoption).deepEqual({ kind: 'absent', home: HOME });
    should(store.writes).be.empty();
    should(store.created).be.empty();
  });

  it('should adopt an empty home, because an empty directory is one we may take', async () => {
    // Arrange
    const { store, claims } = service([]);

    // Act
    const adoption = await claims.adopt(HOME);

    // Assert
    should(adoption).deepEqual({ kind: 'adopted', home: HOME, entries: [] });
    should(store.writes).have.length(1);
  });

  it('should compose the marker path correctly for a home given with a trailing slash', async () => {
    // Arrange — `FY_HOME=/tmp/home/` is a thing people type.
    const { store, claims } = service([]);

    // Act
    await claims.claim('/tmp/home/');

    // Assert — one separator, never two.
    should(store.writes[0]?.path).equal('/tmp/home/layout-version');
  });
});
