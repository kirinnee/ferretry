import { readFileSync } from 'node:fs';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  identifyKnownProcesses,
  type ConfiguredServer,
  type Provenance,
} from '../../../src/lib/migrate/harness-provenance.ts';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../../src/lib/migrate/process-table.ts';

const fixture = (name: string): string => readFileSync(`${import.meta.dir}/../../fixtures/ps/${name}`, 'utf8');

const NO_SERVERS: readonly ConfiguredServer[] = [];

function inventory(name: string, rootPid: number, configuredServers: readonly ConfiguredServer[] = NO_SERVERS) {
  const rows = descendantsOf(rootPid, parseProcessTable(fixture(name)));
  const provenance: Provenance = { rootPid, binaryName: 'fy', configuredServers };
  const known = identifyKnownProcesses(rows, provenance);
  return {
    known,
    processes: inventoryProcesses(rows, new Map(), known),
  };
}

const byPid = (processes: ReturnType<typeof inventory>['processes'], pid: number) =>
  processes.find(entry => entry.pid === pid);

describe('the processes a harness starts for itself', () => {
  it('should recognise fy mcp serve under a Claude pane, from a real Linux ps listing', () => {
    // Act
    const { known, processes } = inventory('linux-claude-pane.txt', 66_601);

    // Assert
    should(known.get(66_728)).deepEqual({ kind: 'ferretry-tools', label: 'The Ferretry tools server' });
    should(byPid(processes, 66_728)).match({ verdict: 'safe_to_kill', known: { kind: 'ferretry-tools' } });
  });

  it('should recognise the owner’s exact refusal: a 2-day-old fy mcp serve is the only child', () => {
    // Act
    const { processes } = inventory('linux-owner-case.txt', 3_887_833);

    // Assert
    should(processes).have.length(1);
    should(processes[0]).match({ pid: 3_887_914, argv: 'fy mcp serve', verdict: 'safe_to_kill' });
  });

  it('should recognise a language server and the runtime it spawned by their parent, not their name alone', () => {
    // Act
    const { known } = inventory('linux-claude-pane.txt', 66_601);

    // Assert
    should(known.get(66_734)?.kind).equal('language-server');
    should(known.get(66_740)).deepEqual(known.get(66_734));
  });

  it('should not recognise the same words when the AGENT ran them from its own shell', () => {
    // Act
    const { known, processes } = inventory('linux-claude-pane.txt', 66_601);

    // Assert — a user-started tools server is work the agent did, not the harness’s own child.
    should(known.has(67_012)).be.false();
    should(byPid(processes, 67_012)?.verdict).equal('unknown');
    should(known.has(66_901)).be.false();
    should(byPid(processes, 66_902)?.verdict).equal('safe_to_kill');
  });

  it('should recognise fy, the codex app-server and its helpers under a Codex pane, but not a push', () => {
    // Act
    const { known, processes } = inventory('linux-codex-pane.txt', 678_503);

    // Assert
    should(known.get(678_504)?.kind).equal('harness');
    should(known.get(710_513)?.kind).equal('harness');
    should(known.get(710_664)?.kind).equal('harness');
    should(known.get(710_700)?.kind).equal('ferretry-tools');
    should(known.has(710_800)).be.false();
    should(byPid(processes, 710_800)?.verdict).equal('destructive_to_interrupt');
  });

  it('should read a macOS ps listing: padded columns, a node-wrapped harness, an npx server by its config', () => {
    // Arrange
    const configured: readonly ConfiguredServer[] = [
      { name: 'search', command: 'npx', args: ['-y', '@acme/search-mcp@latest'] },
    ];

    // Act
    const { known, processes } = inventory('macos-claude-pane.txt', 412, configured);

    // Assert
    should(known.get(413)?.kind).equal('harness');
    should(known.get(431)?.kind).equal('ferretry-tools');
    should(known.get(455)).deepEqual({
      kind: 'configured-server',
      label: 'The “search” tool server from the project config',
    });
    should(known.get(460)).deepEqual(known.get(455));
    should(byPid(processes, 612)?.verdict).equal('safe_to_kill');
    should(byPid(processes, 621)).match({ verdict: 'unknown' });
    should(known.has(621)).be.false();
  });

  it('should leave a server unexplained when no configuration declares it', () => {
    // Act
    const { known } = inventory('macos-claude-pane.txt', 412);

    // Assert
    should(known.has(455)).be.false();
    should(known.has(460)).be.false();
  });

  it('should match a configured server that takes no arguments by its program', () => {
    // Arrange
    const rows = parseProcessTable('  10  1  05:00 /usr/local/bin/lsp-lite\n  11  10  05:00 /usr/local/bin/other');
    const provenance: Provenance = {
      rootPid: 1,
      binaryName: 'fy',
      configuredServers: [{ name: 'lite', command: '/opt/bin/lsp-lite', args: [] }],
    };

    // Act
    const known = identifyKnownProcesses(rows, provenance);

    // Assert
    should(known.get(10)?.kind).equal('configured-server');
    should(known.get(11)).equal(known.get(10));
  });

  it('should refuse look-alikes of the tools server', () => {
    // Arrange
    const rows = parseProcessTable(
      [
        '  10  1  05:00 fy mcp servers',
        '  11  1  05:00 fy mcp',
        '  12  1  05:00 fyi mcp serve',
        '  13  1  05:00 a b c fy mcp serve',
        '  14  1  05:00 bun /repo/packages/cli/bin/fy.ts mcp serve',
      ].join('\n'),
    );

    // Act
    const known = identifyKnownProcesses(rows, { rootPid: 1, binaryName: 'fy', configuredServers: NO_SERVERS });

    // Assert
    should([...known.keys()]).deepEqual([14]);
  });
});
