import { describe, it } from 'bun:test';
import should from 'should';
import manifest from '../../../manifest.ts';
import { verbTable } from '../../../cli/lib/verbs/index.ts';

const FILES = { script: 's', unit: 'u', verifyUnit: 'v', timer: 't' };
const declared = manifest.actions.cli.map(verb => verb.verb).sort();

describe('the browser verb table', () => {
  it('should cover every verb the manifest declares, and only those', () => {
    // Arrange / Act
    const held = Object.keys(verbTable(FILES)).sort();

    // Assert — a verb added to one and not the other is caught here, and by the table's own type.
    should(held).deepEqual(declared);
  });

  it('should declare all 56 verbs of the v4 browser surface, and the three spellings v4 also took', () => {
    should(declared).have.length(59);
    for (const alias of ['browser close', 'browser goto', 'browser login close']) should(declared).containEql(alias);
  });

  it('should let every verb that talks to a daemon name a ferret three ways and print JSON', () => {
    // Arrange
    const table = verbTable(FILES);

    // Act / Assert
    for (const [line, spec] of Object.entries(table)) {
      if (spec.scope === 'page' || spec.scope === 'whole' || spec.scope === 'person')
        should(spec.shape.flags.ferret?.names).deepEqual(['ferret', 'session', 's']);
      else should(spec.shape.flags.ferret).be.undefined();
      should(line.startsWith('browser ')).be.true();
    }
  });

  it('should keep the sign-in window, the proxy test and the firewall free of a ferret', () => {
    // Arrange
    const table = verbTable(FILES);

    // Assert
    for (const line of declared.filter(verb => /^browser (login|proxy|firewall)/u.test(verb)))
      should([
        line,
        table[line as keyof typeof table].scope === 'machine' || table[line as keyof typeof table].scope === 'local',
      ]).deepEqual([line, true]);
  });

  it('should list in each verb’s --help exactly the options its table row reads, so help cannot drift from the parser', () => {
    // Arrange
    const table = verbTable(FILES);
    const namesIn = (flag: string): string[] =>
      [...flag.matchAll(/(?:^|[ ,])-{1,2}([a-z][a-z0-9-]*)/gu)].map(match => match[1] as string);

    // Act / Assert
    for (const decl of manifest.actions.cli) {
      const spec = table[decl.verb as keyof typeof table];
      const read = Object.values(spec.shape.flags).flatMap(flag => flag.names);
      if (spec.scope !== 'local') read.push('json');
      const listed = (decl.options ?? []).flatMap(option => namesIn(option.flag));
      should([decl.verb, [...listed].sort()]).deepEqual([decl.verb, [...read].sort()]);
    }
  });
});
