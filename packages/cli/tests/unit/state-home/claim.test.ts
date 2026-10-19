import { describe, it } from 'bun:test';
import should from 'should';
import {
  STATE_HOME_MODE,
  StateHomeClaimRefusedError,
  StateHomeClaimService,
  unexpectedHomeEntries,
} from '../../../src/lib/state-home/claim';
import type { StateHomeEntry } from '../../../src/lib/state-home/ports';
import { CapturedOutput, directories, FakeStateHomeFiles, files, links } from './fixtures';

const HOME = '/tmp/fy-home/.ferretry';
const MARKER = `${HOME}/layout-version`;

function service(entries?: readonly StateHomeEntry[], marker?: string) {
  const store = new FakeStateHomeFiles(entries, marker);
  const notices = new CapturedOutput();
  return {
    store,
    notices,
    claims: new StateHomeClaimService(store, 'fy daemon adopt', { warn: message => notices.success(message) }),
  };
}

/** A home whose `fleet/` holds a real manifest — a provisioned installation, not a scaffold. */
function provisioned(...names: readonly string[]) {
  const subject = service(directories(...names));
  subject.store.below.set(`${HOME}/fleet`, files('manifest.json'));
  return subject;
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
    should(store.writes).deepEqual([{ path: MARKER, contents: '2\n', mode: 0o600 }]);
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
    const { store, claims } = service(files('layout-version'), '2\n');

    // Act
    const claim = await claims.claim(HOME);

    // Assert — idempotent, because every write path calls this unconditionally rather than each one
    // deciding for itself when a claim applies.
    should(claim).deepEqual({ kind: 'already-claimed', home: HOME });
    should(store.writes).be.empty();
  });

  it('should leave a version-1 home to the daemon to upgrade, never rewriting its marker', async () => {
    // Arrange — an older layout the daemon upgrades in place; the client must not stamp over it.
    const { store, claims } = service(files('layout-version'), '1\n');

    // Act
    const claim = await claims.claim(HOME);

    // Assert
    should(claim).deepEqual({ kind: 'already-claimed', home: HOME });
    should(store.writes).be.empty();
    should(store.marker).equal('1\n');
    should(store.created).deepEqual([{ path: HOME, mode: STATE_HOME_MODE }]);
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
    should(claim).deepEqual({ kind: 'adopted', home: HOME, entries: ['logs'] });
    should(store.writes).have.length(1);
  });

  it('should adopt a home holding only empty Ferretry directories and logs, and say so', async () => {
    // Arrange — the shape the reported defect left: `fy daemon reset`, then something wrote into the
    // home before `fy daemon install` claimed it. Nothing here is an installation — no config, no
    // manifest, no session — so refusing it sent the owner to `adopt` for a home with nothing in it.
    const { store, claims, notices } = service(directories('state', 'fleet', 'logs', 'config'));
    store.below.set(`${HOME}/fleet`, directories('homes'));
    store.below.set(`${HOME}/fleet/homes`, directories('claude-default'));
    store.below.set(`${HOME}/logs`, files('fyd.log'));

    // Act
    const claim = await claims.claim(HOME);

    // Assert — claimed, the whole tree was looked at, and the person is told what was taken over.
    should(claim).deepEqual({ kind: 'adopted', home: HOME, entries: ['config', 'fleet', 'logs', 'state'] });
    should(store.writes).deepEqual([{ path: MARKER, contents: '2\n', mode: 0o600 }]);
    should(store.listed).containEql(`${HOME}/fleet/homes/claude-default`);
    should(notices.text).equal(
      `${HOME} carried no layout-version marker but held only empty Ferretry directories and logs ` +
        '(config, fleet, logs, state) — what an interrupted install or reset leaves — so it was claimed ' +
        "as this release's state home",
    );
  });

  it('should still adopt quietly when nobody handed it a terminal', async () => {
    // Arrange — the notice is a courtesy; the claim is the work.
    const store = new FakeStateHomeFiles(directories('state'));

    // Act
    const claim = await new StateHomeClaimService(store, 'fy daemon adopt').claim(HOME);

    // Assert
    should(claim.kind).equal('adopted');
  });

  it('should not adopt a scaffold holding a file anywhere outside the log directory', async () => {
    // Arrange — one session file deep in `state/` says a daemon really ran here.
    const { store, claims } = service(directories('state'));
    store.below.set(`${HOME}/state`, directories('sessions'));
    store.below.set(`${HOME}/state/sessions`, files('events.jsonl'));

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    should(store.writes).be.empty();
  });

  it('should not adopt a log directory holding anything but log files', async () => {
    // Arrange — a subdirectory, a non-log file, and a link wearing a log's name are none of them ours.
    for (const inside of [directories('archive'), files('notes.txt'), links('fyd.log'), files('.log')]) {
      const { store, claims } = service(directories('logs'));
      store.below.set(`${HOME}/logs`, inside);

      // Act + Assert
      await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    }
  });

  it('should not adopt a scaffold holding a link, or a top-level file, or a directory it does not make', async () => {
    // Arrange — the lock is ours, but a lock says a daemon started here, so it is `adopt`'s call.
    for (const entries of [
      links('fleet'),
      files('daemon.lock'),
      directories('Documents'),
      directories('state', 'cache'),
    ]) {
      const { store, claims } = service(entries);

      // Act + Assert
      await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
      should(store.writes).be.empty();
    }
  });

  it('should give up proving a scaffold empty once it has looked at too many entries', async () => {
    // Arrange — a claim runs on every install, start and restart; an enormous empty tree is not a
    // scaffold anybody's install left, and the decision belongs to `adopt`.
    const { store, claims } = service(directories('state'));
    store.below.set(`${HOME}/state`, directories(...Array.from({ length: 300 }, (_, index) => `d${String(index)}`)));

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    should(store.listed).deepEqual([`${HOME}/state`]);
  });

  it('should treat a directory that vanished while it looked as the empty one it now is', async () => {
    // Arrange
    const { store, claims } = service(directories('fleet'));
    store.listDirectory = (path: string) => {
      store.listed.push(path);
      return Promise.resolve(undefined);
    };

    // Act + Assert
    should((await claims.claim(HOME)).kind).equal('adopted');
  });

  it('should compose child paths correctly for a home given with a trailing slash', async () => {
    // Arrange
    const { store, claims } = service(directories('fleet'));

    // Act
    await claims.claim(`${HOME}/`);

    // Assert
    should(store.listed).deepEqual([`${HOME}/fleet`]);
  });

  it('should not silently adopt a provisioned installation the way it adopts an empty scaffold', async () => {
    // Arrange — a `fleet/` holding a manifest says a real installation was provisioned here, and
    // taking one over without anybody looking is the judgement `adopt` exists to put in front of a person.
    const { store, claims } = provisioned('logs', 'fleet');

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
    should(store.writes).be.empty();
  });

  it('should tell an upgrading owner the truth: everything here is ours, only the marker is missing', async () => {
    // Arrange — THE MOST COMMON REFUSAL, not an edge case: `fleet` and `logs` are both entries we
    // write, so a home left by the unclaimed-provisioning defect has NO unexpected entries. This is
    // the message every owner upgrading from a release before the claim reads first.
    const { claims } = provisioned('fleet', 'logs');

    // Act
    const failure = (await claims.claim(HOME).catch((error: unknown) => error)) as Error;

    // Assert — it must not claim the directory looks suspicious while naming nothing suspicious, and
    // it must not render a gap where a list would have gone.
    should(failure.message).equal(
      `refusing to write into ${HOME}: everything in it is a Ferretry directory, but it carries no ` +
        'layout-version marker, so it was provisioned by a release that did not claim it. ' +
        'Run `fy daemon adopt` to claim it',
    );
    should(failure.message).not.match(/ {2}/u);
    should(failure.message).not.containEql('may not be a Ferretry state home');
  });

  it('should say the opposite when it really did find something that is not ours', async () => {
    // Arrange — the other branch, stated in full so the two sentences cannot drift into each other.
    const { claims } = service([...directories('Documents'), ...files('notes.txt')]);

    // Act
    const failure = (await claims.claim(HOME).catch((error: unknown) => error)) as Error;

    // Assert
    should(failure.message).equal(
      `refusing to write into ${HOME}: it already holds Documents, notes.txt and carries no ` +
        'layout-version marker, so this may not be a Ferretry state home. If it is one, run ' +
        '`fy daemon adopt` to inspect it and claim it; otherwise point FY_HOME somewhere else',
    );
    should(failure.message).not.match(/ {2}/u);
  });

  it('should not mistake a FILE named logs for the log directory', async () => {
    // Arrange — a file of that name is not something either writer produces, so it is foreign state.
    const { claims } = service(files('logs'));

    // Act + Assert
    await should(claims.claim(HOME)).be.rejectedWith(StateHomeClaimRefusedError);
  });

  it('should refuse a directory Ferretry did not create, and name what it found', async () => {
    // Arrange — the guard the client did NOT apply before this change: a fleet verb would happily
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
    const { store, claims } = service(files('layout-version'), '3\n');

    // Act
    const failure = await claims.claim(HOME).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — and this refusal does NOT offer adoption, because adopting cannot repair it.
    should(failure).be.instanceOf(StateHomeClaimRefusedError);
    should((failure as Error).message).containEql('"3"');
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
      ...files('layout-version', 'daemon.lock', 'api-token', 'api-warden-token', 'monitor.json'),
      ...links('tmux.sock'),
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
    should(store.writes).deepEqual([{ path: MARKER, contents: '2\n', mode: 0o600 }]);
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

describe('inspecting a state home without claiming it', () => {
  it('should say absent, claimed or unclaimed and write nothing in any case', async () => {
    // Arrange — a reset asks this before it deletes, so asking must never stamp our marker on a
    // stranger's directory first.
    const absent = service(undefined);
    const claimed = service(files('layout-version'), '2\n');
    const stranger = service(files('taxes.pdf'));

    // Act
    const answers = [
      await absent.claims.inspect(HOME),
      await claimed.claims.inspect(HOME),
      await stranger.claims.inspect(HOME),
    ];

    // Assert
    should(answers).deepEqual(['absent', 'claimed', 'unclaimed']);
    for (const subject of [absent, claimed, stranger]) {
      should(subject.store.writes).be.empty();
      should(subject.store.created).be.empty();
    }
  });
});
