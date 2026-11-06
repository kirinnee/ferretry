import { describe, it } from 'bun:test';
import should from 'should';
import {
  RETIRED_DAEMON_KEYS,
  retiredDaemonKeysIn,
  retiredDaemonKeysSentence,
} from '../../../src/lib/config-files/retired-daemon-keys.ts';

describe('retiredDaemonKeysIn', () => {
  it('should name every retired key a document holds, whatever its value', () => {
    // Arrange
    const document = {
      attention: null,
      accountModel: { enabled: true },
      fleet: {},
      sessionWorkers: { enabled: false },
    };

    // Act
    const actual = retiredDaemonKeysIn(document).map(retired => retired.key);

    // Assert
    should(actual).deepEqual(['attention', 'accountModel', 'fleet', 'sessionWorkers.enabled']);
  });

  it('should find nothing in a document with only live keys', () => {
    // Assert
    should(retiredDaemonKeysIn({ agenda: {}, sessionWorkers: { max: 2 }, port: 1234 })).deepEqual([]);
  });

  it('should not mistake sessionWorkers itself, or a non-object one, for the retired key inside it', () => {
    // Assert
    should(retiredDaemonKeysIn({ sessionWorkers: {} })).deepEqual([]);
    should(retiredDaemonKeysIn({ sessionWorkers: 3 })).deepEqual([]);
  });

  it('should hold nothing for a document that is not an object', () => {
    // Assert
    should(retiredDaemonKeysIn(null)).deepEqual([]);
    should(retiredDaemonKeysIn([{ attention: {} }])).deepEqual([]);
    should(retiredDaemonKeysIn('attention')).deepEqual([]);
  });

  it('should give every retired key a remedy that names it and says what to do', () => {
    for (const retired of RETIRED_DAEMON_KEYS) {
      should(retired.remedy).containEql(`\`${retired.path.at(-1)}\``);
      should(retired.remedy).match(/^(rename|remove) /u);
    }
  });
});

describe('retiredDaemonKeysSentence', () => {
  it('should be undefined for a clean document', () => {
    // Assert
    should(retiredDaemonKeysSentence({})).be.undefined();
  });

  it('should name the key and its remedy, and never a value', () => {
    // Act
    const actual = retiredDaemonKeysSentence({ attention: { replySettleSeconds: 777 } });

    // Assert
    should(actual).containEql('"attention"');
    should(actual).containEql('rename `attention` to `agenda` in config/daemon.json');
    should(actual).not.containEql('777');
  });
});
