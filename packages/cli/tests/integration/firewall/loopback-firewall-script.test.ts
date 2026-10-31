import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';

const SCRIPT = resolve(import.meta.dir, '../../../../../scripts/host/ferretry-loopback-firewall');
const FIXTURES = resolve(import.meta.dir, '../../../../../scripts/host/per-user-ports.fixtures.json');

interface PortFixture {
  readonly uid: number;
  readonly base: number;
  readonly ports: { readonly cdp: number; readonly relay: number; readonly vnc: number };
  readonly refused?: boolean;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * A temp conf dir, run dir, fake `/proc/net`, and fake `nft` and `runuser` on PATH. The fake nft records each
 * transaction and keeps the applied table in a state file that `list table` prints back; the fake runuser
 * answers a probe from FAKE_CONNECTABLE and never opens a socket.
 */
class Rig {
  readonly confDir: string;
  readonly conf: string;
  readonly runDir: string;
  readonly marker: string;
  readonly bin: string;
  readonly calls: string;
  readonly proc: string;
  readonly state: string;
  readonly probes: string;

  constructor(readonly root: string) {
    this.confDir = join(root, 'etc');
    this.conf = join(this.confDir, 'loopback-firewall.conf');
    this.runDir = join(root, 'run', 'ferretry');
    this.marker = join(this.runDir, 'loopback-firewall.json');
    this.bin = join(root, 'bin');
    this.calls = join(root, 'nft-calls');
    this.proc = join(root, 'proc-net');
    this.state = join(root, 'nft-state');
    this.probes = join(root, 'probes');
  }

  static async create(): Promise<Rig> {
    const rig = new Rig(await mkdtemp(join(tmpdir(), 'fy-firewall-')));
    await mkdir(rig.confDir, { mode: 0o755 });
    await mkdir(rig.bin);
    await mkdir(rig.calls);
    await mkdir(rig.proc);
    const nft = join(rig.bin, 'nft');
    await writeFile(
      nft,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        'if [ "${1:-}" = list ]; then',
        '  [ -f "${FAKE_NFT_STATE}" ] || { echo "Error: No such file or directory" >&2; exit 1; }',
        '  cat "${FAKE_NFT_STATE}"',
        '  exit 0',
        'fi',
        'n="$(find "${FAKE_NFT_CALLS}" -name "*.stdin" | wc -l)"',
        'cat >"${FAKE_NFT_CALLS}/${n}.stdin"',
        'echo "$*" >"${FAKE_NFT_CALLS}/${n}.args"',
        '[ -z "${FAKE_NFT_FAIL:-}" ] || { echo "Error: rejected by the fake nft" >&2; exit 1; }',
        'if grep -q "^table inet ferretry {" "${FAKE_NFT_CALLS}/${n}.stdin"; then',
        '  tail -n +3 "${FAKE_NFT_CALLS}/${n}.stdin" | { grep -v "skuid != ${FAKE_NFT_DROP_UID:-none} " || true; } >"${FAKE_NFT_STATE}"',
        'else',
        '  rm -f "${FAKE_NFT_STATE}"',
        'fi',
        '',
      ].join('\n'),
    );
    await chmod(nft, 0o755);
    const runuser = join(rig.bin, 'runuser');
    await writeFile(
      runuser,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        'user="$2"',
        'shift 3',
        'if [ "$1" = timeout ]; then',
        '  port="${@: -1}"',
        '  echo "${user} ${port}" >>"${FAKE_PROBES}"',
        '  case " ${FAKE_CONNECTABLE:-} " in *" ${port} "*) exit 0 ;; esac',
        '  exit 1',
        'fi',
        '[ -z "${FAKE_RUNUSER_FAIL:-}" ] || exit 1',
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(runuser, 0o755);
    return rig;
  }

  async writeConf(text: string, mode = 0o644): Promise<void> {
    await writeFile(this.conf, text);
    await chmod(this.conf, mode);
  }

  run(args: readonly string[] = [], extraEnv: Record<string, string | undefined> = {}): Run {
    const env: Record<string, string | undefined> = {
      PATH: `${this.bin}:${process.env.PATH ?? ''}`,
      FAKE_NFT_CALLS: this.calls,
      FAKE_NFT_STATE: this.state,
      FAKE_PROBES: this.probes,
      FERRETRY_RUNUSER: join(this.bin, 'runuser'),
      FERRETRY_PROC_NET: this.proc,
      FERRETRY_FIREWALL_CONF: this.conf,
      FERRETRY_FIREWALL_RUN_DIR: this.runDir,
      ...extraEnv,
    };
    const defined = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<
      string,
      string
    >;
    const result = Bun.spawnSync(['bash', SCRIPT, ...args], { env: defined, stdout: 'pipe', stderr: 'pipe' });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }

  async nftInputs(): Promise<readonly string[]> {
    const names = (await readdir(this.calls)).filter(name => name.endsWith('.stdin')).sort();
    return Promise.all(names.map(name => readFile(join(this.calls, name), 'utf8')));
  }

  async listen(...ports: readonly number[]): Promise<void> {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
    const line = (port: number, index: number, state: string): string =>
      `   ${index}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 1`;
    const lines = ports.map((port, index) => line(port, index, '0A'));
    // an established socket on a port nobody listens on must not count as a listener
    lines.push(line(40000, ports.length, '01'));
    await writeFile(join(this.proc, 'tcp'), [header, ...lines, ''].join('\n'));
    await writeFile(join(this.proc, 'tcp6'), `${header}\n`);
  }

  async probed(): Promise<readonly string[]> {
    const text = await Bun.file(this.probes)
      .text()
      .catch(() => '');
    return text.split('\n').filter(Boolean);
  }

  async markerJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(this.marker, 'utf8')) as Record<string, unknown>;
  }

  async marked(): Promise<boolean> {
    return Bun.file(this.marker).exists();
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

const ruleset = (...rules: readonly string[]): string =>
  [
    'add table inet ferretry',
    'delete table inet ferretry',
    'table inet ferretry {',
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    ...rules.map(rule => `    ${rule}`),
    '  }',
    '}',
    '',
  ].join('\n');

const rule = (ports: string, uid: number): string =>
  `oif "lo" tcp dport { ${ports} } meta skuid != ${uid} reject with tcp reset`;

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.create();
});

afterEach(async () => {
  await rig.cleanup();
});

describe('the ruleset it applies', () => {
  it('should replace only table inet ferretry in one nft transaction, one rule line per user', async () => {
    // Arrange
    await rig.writeConf(
      ['# curated by the host admin', '', 'user 1001', 'user 1002 30000 30001 30002  # explicit', ''].join('\n'),
    );

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([
      ruleset(rule('20004, 20005, 20006', 1001), rule('30000, 30001, 30002', 1002)),
    ]);
    should(await readFile(join(rig.calls, '0.args'), 'utf8')).equal('-f -\n');
  });

  it('should move every derived user with the base, wherever the base line sits', async () => {
    // Arrange
    await rig.writeConf('user 1001\nbase 30000\n');

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([ruleset(rule('30004, 30005, 30006', 1001))]);
    should(JSON.parse(await readFile(rig.marker, 'utf8')).base).equal(30000);
  });

  it('should accept tabs and blank lines, and apply an empty table when no user is listed', async () => {
    // Arrange
    await rig.writeConf('\n\t# nobody yet\n\n');

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([ruleset()]);
    should(JSON.parse(await readFile(rig.marker, 'utf8')).entries).deepEqual([]);
  });

  it('should find nft through PATH when FERRETRY_NFT is not set', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    const result = rig.run([], { FERRETRY_NFT: undefined });

    // Assert
    should(result.code).equal(0);
    should((await rig.nftInputs()).length).equal(1);
  });

  it('should honour FERRETRY_NFT over PATH', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    const other = join(rig.root, 'other-nft');
    await writeFile(other, '#!/usr/bin/env bash\ncat >"${FAKE_NFT_CALLS}/other.stdin"\n');
    await chmod(other, 0o755);

    // Act
    const result = rig.run([], { FERRETRY_NFT: other });

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([ruleset(rule('20004, 20005, 20006', 1001))]);
  });
});

describe('port derivation, pinned to the shared fixtures', () => {
  it('should derive the same ports as perUserBrowserPorts for every fixture, and refuse where it refuses', async () => {
    // Arrange
    const { cases } = (await Bun.file(FIXTURES).json()) as { cases: readonly PortFixture[] };
    should(cases.length).be.greaterThan(5);

    for (const fixture of cases) {
      // Act
      await rig.writeConf(`base ${fixture.base}\nuser ${fixture.uid}\n`);
      await rm(rig.calls, { recursive: true, force: true });
      await mkdir(rig.calls);
      await rm(rig.runDir, { recursive: true, force: true });
      const result = rig.run();

      // Assert
      const label = `uid ${fixture.uid} base ${fixture.base}`;
      if (fixture.refused) {
        should({ label, code: result.code }).deepEqual({ label, code: 1 });
        should(await rig.nftInputs()).deepEqual([]);
      } else {
        const { cdp, relay, vnc } = fixture.ports;
        should({ label, code: result.code }).deepEqual({ label, code: 0 });
        should(await rig.nftInputs()).deepEqual([ruleset(rule(`${cdp}, ${relay}, ${vnc}`, fixture.uid))]);
        should(JSON.parse(await readFile(rig.marker, 'utf8')).entries).deepEqual([
          { uid: fixture.uid, ports: [cdp, relay, vnc] },
        ]);
      }
    }
  });
});

describe('refusing the conf', () => {
  const refusals: readonly (readonly [string, string, string])[] = [
    ['an unknown directive', 'allow 1001\n', 'line 1'],
    ['a user line with no uid', 'user\n', 'line 1'],
    ['a user line with three numbers', 'user 1001 20000 20001\n', 'line 1'],
    ['a user line with a trailing word', 'user 1001 20000 20001 20002 extra\n', 'line 1'],
    ['a base line with no number', 'base\n', 'line 1'],
    ['a non-numeric uid', 'user alice\n', "'alice' is not a whole number"],
    ['a negative uid', 'user -5\n', "'-5' is not a whole number"],
    ['an octal-looking uid', 'user 01001\n', "'01001' is not a whole number"],
    ['a carriage return', 'user 1001\r\n', 'line 1'],
    ['a uid below 1000', 'user 999\n', 'uid 999 is below 1000'],
    ['root', 'user 0\n', 'uid 0 is below 1000'],
    ['a duplicate uid', 'user 1001\nuser 1001 30000 30001 30002\n', 'uid 1001 is listed twice'],
    ['base given twice', 'base 20000\nbase 21000\n', 'base is given twice'],
    ['a base below 1024', 'base 80\n', 'base must be at least 1024'],
    ['an explicit port below 1024', 'user 1001 80 20001 20002\n', 'port 80 is outside 1024-65535'],
    ['an explicit port above 65535', 'user 1001 20000 20001 70000\n', 'port 70000 is outside 1024-65535'],
    [
      'a port claimed twice by one user',
      'user 1001 20000 20000 20002\n',
      'port 20000 is claimed by both uid 1001 and uid 1001',
    ],
    [
      'a port claimed by two explicit users',
      'user 1001 30000 30001 30002\nuser 1002 30002 30003 30004\n',
      'port 30002 is claimed by both uid 1001 and uid 1002',
    ],
    [
      'an explicit port that collides with a derived one',
      'user 1001\nuser 1002 20005 30001 30002\n',
      'port 20005 is claimed by both uid 1001 and uid 1002',
    ],
    ['a derived port above 32767', 'user 4192\n', 'uid 4192 gets ports outside 1024-32767 from base 20000'],
    [
      'a derived port above 32767 from a raised base',
      'base 32000\nuser 1001\nuser 1200\n',
      'uid 1200 gets ports outside 1024-32767 from base 32000',
    ],
  ];

  for (const [name, conf, reason] of refusals) {
    it(`should refuse ${name}, applying and writing nothing`, async () => {
      // Arrange
      await rig.writeConf(conf);

      // Act
      const result = rig.run();

      // Assert
      should(result.code).not.equal(0);
      should(result.err.trim().split('\n')).have.length(1);
      should(result.err).startWith('❌ ');
      should(result.err).containEql(reason);
      should(result.err).containEql('nothing was applied');
      should(await rig.nftInputs()).deepEqual([]);
      should(await rig.marked()).be.false();
    });
  }

  it('should not apply an earlier valid line when a later line is bad', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002\nnonsense\n');

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('line 3');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should refuse a conf writable by its group', async () => {
    // Arrange
    await rig.writeConf('user 1001\n', 0o664);

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('writable by its group or by others');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should refuse a conf writable by others', async () => {
    // Arrange
    await rig.writeConf('user 1001\n', 0o646);

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('writable by its group or by others');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should accept a conf that is read-only to everyone but its owner', async () => {
    // Arrange
    await rig.writeConf('user 1001\n', 0o600);

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
  });

  it('should refuse a conf in a directory others can write', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    await chmod(rig.confDir, 0o777);

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('closed to group and others');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should refuse a symlink, even to a well-formed conf', async () => {
    // Arrange
    const real = join(rig.confDir, 'real.conf');
    await writeFile(real, 'user 1001\n');
    await chmod(real, 0o644);
    await symlink(real, rig.conf);

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('not a regular file');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should refuse a conf that does not exist', async () => {
    // Arrange: no conf written

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('not a regular file');
    should(await rig.nftInputs()).deepEqual([]);
  });

  // The owner is compared with the invoking uid, so a root-owned file stands in for "someone else's"
  // whenever the suite is not itself root.
  it.skipIf(process.getuid?.() === 0)('should refuse a conf owned by another user', async () => {
    // Arrange: /etc/hosts is root-owned and not writable by anyone else
    await stat('/etc/hosts');

    // Act
    const result = rig.run([], { FERRETRY_FIREWALL_CONF: '/etc/hosts' });

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('not owned by root');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'should refuse to run as a non-root user without FERRETRY_FIREWALL_RUN_DIR',
    async () => {
      // Arrange
      await rig.writeConf('user 1001\n');

      // Act
      const result = rig.run([], { FERRETRY_FIREWALL_RUN_DIR: undefined });

      // Assert
      should(result.code).equal(1);
      should(result.err).containEql('must run as root');
      should(await rig.nftInputs()).deepEqual([]);
    },
  );

  it('should refuse an unknown mode', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    const result = rig.run(['reload']);

    // Assert
    should(result.code).equal(2);
    should(result.err).containEql('usage');
    should(await rig.nftInputs()).deepEqual([]);
  });
});

// FERRETRY_FIREWALL_TEST_UID stands in for root, and the script honours it only when the real uid is not
// root, so a suite that is itself root cannot stand in for it and these cases skip there.
describe.skipIf(process.getuid?.() === 0)('running as root', () => {
  const FIXED_NFT = ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft'];
  const root = { FERRETRY_FIREWALL_TEST_UID: '0' };

  const OVERRIDES = [
    'FERRETRY_FIREWALL_CONF',
    'FERRETRY_FIREWALL_RUN_DIR',
    'FERRETRY_NFT',
    'FERRETRY_RUNUSER',
    'FERRETRY_PROC_NET',
  ];
  const cleared = Object.fromEntries(OVERRIDES.map(name => [name, undefined]));

  for (const override of OVERRIDES) {
    it(`should refuse ${override}, applying and writing nothing`, async () => {
      // Arrange
      await rig.writeConf('user 1001\n');
      const env = { ...root, ...cleared, [override]: rig.conf };

      // Act
      const result = rig.run(['--verify'], env);

      // Assert
      should(result.code).equal(1);
      should(result.err.trim().split('\n')).have.length(1);
      should(result.err).containEql(`${override} is for the tests only`);
      should(await rig.nftInputs()).deepEqual([]);
      should(await rig.marked()).be.false();
    });
  }

  it('should refuse the overrides in stop mode too', async () => {
    // Act
    const result = rig.run(['stop'], root);

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('for the tests only');
    should(await rig.nftInputs()).deepEqual([]);
  });

  it('should never take nft from PATH', async () => {
    // Arrange: the fake nft heads PATH, and no override is set
    const env = { ...root, ...cleared };
    const fixed = await Promise.all(FIXED_NFT.map(path => Bun.file(path).exists()));

    // Act
    const result = rig.run([], env);

    // Assert: with no nft in the fixed list the script says so; with one it goes on to the real conf, which
    // this user does not own, and either way the fake on PATH is never run
    should(result.code).equal(1);
    if (fixed.some(Boolean)) should(result.err).not.containEql('no nft found');
    else should(result.err).containEql('no nft found in /usr/sbin /sbin /usr/bin');
    should(await rig.nftInputs()).deepEqual([]);
    should(await rig.marked()).be.false();
  });
});

describe('the marker', () => {
  it('should hold the spec shape, world-readable, in a 0755 directory, with no temp file left', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002 30000 30001 30002\n');

    // Act
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
    const marker = JSON.parse(await readFile(rig.marker, 'utf8'));
    should(Object.keys(marker)).deepEqual(['version', 'appliedAt', 'base', 'entries']);
    should(marker.version).equal(1);
    should(marker.base).equal(20000);
    should(marker.appliedAt).match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    should(Math.abs(Date.parse(marker.appliedAt) - Date.now())).be.lessThan(60_000);
    should(marker.entries).deepEqual([
      { uid: 1001, ports: [20004, 20005, 20006] },
      { uid: 1002, ports: [30000, 30001, 30002] },
    ]);
    should((await stat(rig.marker)).mode & 0o777).equal(0o644);
    should((await stat(rig.runDir)).mode & 0o777).equal(0o755);
    should(await readdir(rig.runDir)).deepEqual(['loopback-firewall.json']);
  });

  it('should carry no secret: the marker names uids and ports and nothing else', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    rig.run();

    // Assert
    should(await readFile(rig.marker, 'utf8')).not.match(/token|secret|password/i);
  });

  it('should not touch the marker when nft rejects the transaction', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    should(rig.run().code).equal(0);
    const before = await readFile(rig.marker, 'utf8');
    await rig.writeConf('user 1001\nuser 1002\n');

    // Act
    const result = rig.run([], { FAKE_NFT_FAIL: '1' });

    // Assert
    should(result.code).not.equal(0);
    should(await readFile(rig.marker, 'utf8')).equal(before);
    should(await readdir(rig.runDir)).deepEqual(['loopback-firewall.json']);
  });

  it('should write no marker when the very first apply is rejected by nft', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    const result = rig.run([], { FAKE_NFT_FAIL: '1' });

    // Assert
    should(result.code).not.equal(0);
    should(await rig.marked()).be.false();
  });
});

describe('re-applying', () => {
  it('should send the same transaction and leave one identical marker shape each time', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002\n');

    // Act
    const first = rig.run();
    const second = rig.run();

    // Assert
    should([first.code, second.code]).deepEqual([0, 0]);
    const inputs = await rig.nftInputs();
    should(inputs).have.length(2);
    should(inputs[0]).equal(inputs[1] as string);
    should(inputs[0]).startWith('add table inet ferretry\ndelete table inet ferretry\n');
    should(JSON.parse(await readFile(rig.marker, 'utf8')).entries).have.length(2);
    should(await readdir(rig.runDir)).deepEqual(['loopback-firewall.json']);
  });

  it('should replace the marker when the conf changes, dropping users who were removed', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002\n');
    rig.run();

    // Act
    await rig.writeConf('user 1002\n');
    const result = rig.run();

    // Assert
    should(result.code).equal(0);
    should(JSON.parse(await readFile(rig.marker, 'utf8')).entries).deepEqual([
      { uid: 1002, ports: [20008, 20009, 20010] },
    ]);
    should((await rig.nftInputs())[1]).equal(ruleset(rule('20008, 20009, 20010', 1002)));
  });
});

describe('stopping', () => {
  it('should delete table inet ferretry and the marker', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    rig.run();
    should(await rig.marked()).be.true();

    // Act
    const result = rig.run(['stop']);

    // Assert
    should(result.code).equal(0);
    should(await rig.marked()).be.false();
    const inputs = await rig.nftInputs();
    should(inputs[1]).equal('add table inet ferretry\ndelete table inet ferretry\n');
  });

  it('should succeed when neither the table nor the marker exists, and need no conf', async () => {
    // Arrange: nothing applied, no conf

    // Act
    const result = rig.run(['stop']);

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual(['add table inet ferretry\ndelete table inet ferretry\n']);
  });

  it('should leave the marker in place when nft fails to delete the table', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    rig.run();

    // Act
    const result = rig.run(['stop'], { FAKE_NFT_FAIL: '1' });

    // Assert
    should(result.code).not.equal(0);
    should(await rig.marked()).be.true();
  });
});

describe('verifying', () => {
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

  it('should re-apply when the table is gone, then record every listed user as ok', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002 30000 30001 30002\n');

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([
      ruleset(rule('20004, 20005, 20006', 1001), rule('30000, 30001, 30002', 1002)),
    ]);
    const marker = await rig.markerJson();
    should(marker.perUser).deepEqual({ '1001': 'ok', '1002': 'ok' });
    should(marker.verifiedAt).match(ISO);
    should(marker.appliedAt).match(ISO);
    should(marker.version).equal(1);
    should(marker.base).equal(20000);
    should(marker.entries).deepEqual([
      { uid: 1001, ports: [20004, 20005, 20006] },
      { uid: 1002, ports: [30000, 30001, 30002] },
    ]);
  });

  it('should not re-apply when every rule is already listed, and keep appliedAt', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    should(rig.run().code).equal(0);
    const before = (await rig.markerJson()).appliedAt;
    await Bun.sleep(1100);

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).have.length(1);
    const marker = await rig.markerJson();
    should(marker.appliedAt).equal(before);
    should(marker.perUser).deepEqual({ '1001': 'ok' });
    should(Date.parse(marker.verifiedAt as string)).be.greaterThan(Date.parse(before as string));
  });

  it('should read a rule that nft lists with its consecutive ports as a range', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    await writeFile(
      rig.state,
      'table inet ferretry {\n  chain output {\n    oif "lo" tcp dport 20004-20006 meta skuid != 1001 reject with tcp reset\n  }\n}\n',
    );

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).deepEqual([]);
    should((await rig.markerJson()).perUser).deepEqual({ '1001': 'ok' });
  });

  it('should mark a user missing when the rule is still not listed after a re-apply', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002\n');
    await rig.listen(20004, 20008);

    // Act
    const result = rig.run(['--verify'], { FAKE_NFT_DROP_UID: '1002' });

    // Assert
    should(result.code).equal(0);
    should(await rig.nftInputs()).have.length(1);
    should((await rig.markerJson()).perUser).deepEqual({ '1001': 'ok', '1002': 'missing' });
    should(result.err).containEql('uid 1002: missing');
    should(await rig.probed()).deepEqual(['nobody 20004']);
  });

  it('should mark a user failed when an unprivileged probe connects to a port that has a listener', async () => {
    // Arrange
    await rig.writeConf('user 1001\nuser 1002\n');
    await rig.listen(20005, 20009);

    // Act
    const result = rig.run(['--verify'], { FAKE_CONNECTABLE: '20005' });

    // Assert
    should(result.code).equal(0);
    should((await rig.markerJson()).perUser).deepEqual({ '1001': 'failed', '1002': 'ok' });
    should(result.err).containEql('uid 1001: failed');
  });

  it('should probe only ports with a LISTEN socket, as nobody, and not fail a port nobody listens on', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    await rig.listen(20004, 20006);

    // Act
    const result = rig.run(['--verify'], { FAKE_CONNECTABLE: '20005' });

    // Assert: 20005 would connect, but nothing listens there, so it is never probed
    should(result.code).equal(0);
    should(await rig.probed()).deepEqual(['nobody 20004', 'nobody 20006']);
    should((await rig.markerJson()).perUser).deepEqual({ '1001': 'ok' });
  });

  it('should treat a user as ok when none of their ports has a listener', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    await rig.listen();

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(0);
    should(await rig.probed()).deepEqual([]);
    should((await rig.markerJson()).perUser).deepEqual({ '1001': 'ok' });
  });

  it('should record an empty perUser for an empty conf', async () => {
    // Arrange
    await rig.writeConf('# nobody yet\n');

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(0);
    should((await rig.markerJson()).perUser).deepEqual({});
  });

  it('should leave a marker that is valid JSON, world-readable, with no temp file left', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    rig.run(['--verify']);

    // Assert
    should(Object.keys(await rig.markerJson())).deepEqual([
      'version',
      'appliedAt',
      'base',
      'verifiedAt',
      'perUser',
      'entries',
    ]);
    should((await stat(rig.marker)).mode & 0o777).equal(0o644);
    should(await readdir(rig.runDir)).deepEqual(['loopback-firewall.json']);
  });

  it('should refuse, writing nothing, when the probe account is a uid the conf lists', async () => {
    // Arrange
    const nobody = Bun.spawnSync(['id', '-u', 'nobody']).stdout.toString().trim();
    await rig.writeConf(`user ${nobody} 30000 30001 30002\n`);

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('which');
    should(result.err).containEql('lists, so nothing was verified');
    should(await rig.nftInputs()).deepEqual([]);
    should(await rig.marked()).be.false();
  });

  it('should refuse, writing nothing, when it cannot run a command as the probe account', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');

    // Act
    const result = rig.run(['--verify'], { FAKE_RUNUSER_FAIL: '1' });

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('cannot run a probe as nobody');
    should(await rig.nftInputs()).deepEqual([]);
    should(await rig.marked()).be.false();
  });

  it('should refuse a bad conf exactly as apply does, touching nothing', async () => {
    // Arrange
    await rig.writeConf('user 999\n');

    // Act
    const result = rig.run(['--verify']);

    // Assert
    should(result.code).equal(1);
    should(result.err).containEql('uid 999 is below 1000');
    should(await rig.nftInputs()).deepEqual([]);
    should(await rig.marked()).be.false();
  });

  it('should keep the old marker when the re-apply is rejected by nft', async () => {
    // Arrange
    await rig.writeConf('user 1001\n');
    should(rig.run().code).equal(0);
    await rm(rig.state);
    const before = await readFile(rig.marker, 'utf8');

    // Act
    const result = rig.run(['--verify'], { FAKE_NFT_FAIL: '1' });

    // Assert
    should(result.code).not.equal(0);
    should(await readFile(rig.marker, 'utf8')).equal(before);
  });

  it.skipIf(process.getuid?.() === 0)(
    'should as root take nft, runuser, timeout and bash only from fixed directories, never PATH',
    async () => {
      // Arrange: fake nft and runuser head PATH; no override is set
      await rig.writeConf('user 1001\n');
      const env = {
        FERRETRY_FIREWALL_TEST_UID: '0',
        FERRETRY_FIREWALL_CONF: undefined,
        FERRETRY_FIREWALL_RUN_DIR: undefined,
        FERRETRY_NFT: undefined,
        FERRETRY_RUNUSER: undefined,
        FERRETRY_PROC_NET: undefined,
      };

      // Act
      const result = rig.run(['--verify'], env);

      // Assert: whichever fixed tool or conf check stops it, the fakes on PATH were never run
      should(result.code).equal(1);
      should(result.err).match(/no (nft|runuser|timeout|bash) found in|not a regular file|not owned by root/);
      should(await rig.nftInputs()).deepEqual([]);
      should(await rig.probed()).deepEqual([]);
      should(await rig.marked()).be.false();
    },
  );
});
