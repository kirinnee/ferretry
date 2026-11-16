/**
 * CFG-LEAK (ii) fix 3 (I): ONE rule for an MCP server's `command` in every view that shows it (the detail, the Resolved
 * line, the warning): withheld when the write rule refuses it (as a string or as its words), or when the word cutter,
 * run on the command as ONE string, cuts a part that is a VALUE; a part that is a pointer (`$X`, `${X}`,
 * `${secret:X}`) is not one, so `env API_KEY=$API_KEY srv` is shown as written. A header pair across the blanks of a
 * command (`Authorization: Bearer v`, one word to the write rule's boundary) was shown in full by the Resolved line
 * once it split the command at its blanks. Fake values only.
 *
 * How it grows at 256 KiB is tests/perf/daemon/net-command-value.test.ts.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { commandWithheld } from '../../../daemon/lib/service/command-line.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};
const WITHHELD = 'withheld';

/** What the Resolved line and the detail show of a server started by `command` and `args`. */
function views(command: string, args: readonly string[] = []) {
  const parsed = parseAccountModel({
    version: 1,
    components: { mcp: { srv: { command, args: [...args] } } },
    profiles: { p: { layers: ['mcp/srv'] } },
  });
  const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
  if (!result.ok) throw new Error('expected a resolution');
  const resolved = resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
  const detail = componentCatalog(parsed, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === 'mcp/srv')?.detail;
  return { resolved, detail: JSON.stringify(detail), held: detail?.kind === 'mcp' && detail.commandWithheld === true };
}

/** The four header-pair shapes the regression showed, each in its layouts: quoted, unquoted, two blanks, a tab. */
const PAIRS: Readonly<Record<string, readonly string[]>> = {
  'curl with a quoted Authorization header': [
    `curl -H "Authorization: Bearer ${V}" https://h`,
    `curl -H 'Authorization: Bearer ${V}' https://h`,
    `curl  -H  "Authorization:  Bearer  ${V}"  https://h`,
    `curl\t-H\t"Authorization:\tBearer\t${V}"\thttps://h`,
  ],
  'npx with --header Authorization': [
    `npx srv --header Authorization: Bearer ${V}`,
    `npx srv --header "Authorization: Bearer ${V}"`,
    `npx  srv  --header  Authorization:  Bearer  ${V}`,
    `npx\tsrv\t--header\tAuthorization:\tBearer\t${V}`,
  ],
  'npx with -H X-Api-Key': [
    `npx srv -H X-Api-Key: ${V}`,
    `npx srv -H "X-Api-Key: ${V}"`,
    `npx  srv  -H  X-Api-Key:  ${V}`,
    `npx\tsrv\t-H\tX-Api-Key:\t${V}`,
  ],
  'srv with -H Cookie': [
    `srv -H Cookie: session=${V}`,
    `srv -H "Cookie: session=${V}"`,
    `srv  -H  Cookie:  session=${V}`,
    `srv\t-H\tCookie:\tsession=${V}`,
  ],
};

describe('(I) a command is withheld in every view when the cutter cuts a value in it', () => {
  for (const [name, commands] of Object.entries(PAIRS)) {
    for (const [at, command] of commands.entries()) {
      it(`should show no value of ${name} in the Resolved line or the detail (${String(at + 1)})`, () => {
        // Act
        const seen = views(command);

        // Assert
        should(commandWithheld(command)).be.true();
        should(seen.resolved).not.containEql(V);
        should(seen.detail).not.containEql(V);
        should(seen.held).be.true();
      });
    }
  }

  it('should withhold the whole Resolved line, with the plain sentence, never a part of it', () => {
    // Act
    const seen = views(`curl -H "Authorization: Bearer ${V}" https://h`);

    // Assert
    should(seen.resolved).not.containEql('curl');
    should(seen.resolved).not.containEql('‹hidden›');
  });

  for (const command of [
    'env API_KEY=$API_KEY srv',
    'env API_KEY=${API_KEY} srv',
    'env API_KEY=${secret:API} srv',
    'srv --token ${secret:X}',
    'env API_KEY="$API_KEY" srv',
  ]) {
    it(`should show the pointer control as written in both views: ${command}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.false();
      should(seen.resolved).equal(command.split(/\s+/u).join(' '));
      should(seen.held).be.false();
      should(seen.detail).containEql(JSON.stringify(command).slice(1, -1));
    });
  }

  for (const command of [`env API_KEY=${V} srv`, `srv --token ${V}`, `env API_KEY=$API_KEY,${V} srv`]) {
    it(`should still withhold a command that holds a value: ${command.slice(0, 24)}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.true();
      should(seen.resolved).not.containEql(V);
      should(seen.held).be.true();
    });
  }

  it('should still catch a flag at the end of the command and its value as the first argument', () => {
    // Act
    const seen = views('srv --token', [V]);

    // Assert
    should(seen.resolved).not.containEql(V);
    should(JSON.stringify(seen.detail)).not.containEql(V);
  });

  it('should show a plain command and its arguments as before', () => {
    // Act
    const seen = views('npx', ['-y', '@scope/pkg']);

    // Assert
    should(seen.resolved).equal('npx -y @scope/pkg');
    should(WITHHELD).equal('withheld');
  });
});
