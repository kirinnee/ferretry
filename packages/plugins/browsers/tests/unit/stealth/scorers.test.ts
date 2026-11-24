import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { CAPTURE_META, CAPTURE_TRUNCATED_ATTRIBUTE, withChallenge } from '../../support/stealth/capture.ts';
import { allowedHost, CHECKS } from '../../support/stealth/checks.ts';
import {
  type Reading,
  scoreCreepJs,
  scoreIncolumitas,
  scoreNavia,
  scoreRebrowser,
  scoreRecaptchaV3,
  scoreSannysoft,
  scoreTurnstile,
} from '../../support/stealth/scorers.ts';

/** Saved captures of the real pages (`capture.ts`), taken from this repo's own stock headless Chrome 154 and scrubbed. */
const FIXTURES = join(import.meta.dir, '../../fixtures/stealth');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

/** Replace `from` once, and fail the test if the fixture no longer holds it (so a variant can never be a no-op). */
function swap(html: string, from: string | RegExp, to: string): string {
  const out = html.replace(from, to);
  should(out).not.equal(html);
  return out;
}

function scoredOf(reading: Reading): Extract<Reading, { kind: 'scored' }> {
  if (reading.kind !== 'scored') throw new Error(`expected a score, got: ${reading.reason}`);
  return reading;
}

function unreadableOf(reading: Reading): string {
  if (reading.kind !== 'unreadable') throw new Error('expected "could not read score", got a score');
  return reading.reason;
}

describe('sannysoft scorer', () => {
  it('should pass a page where every row but the WebGL renderer passed, and name the row that failed', () => {
    // Act
    const reading = scoredOf(scoreSannysoft(fixture('sannysoft')));

    // Assert
    should(reading.pass).be.true();
    should(reading.failed).deepEqual(['WebGL Renderer']);
    should(reading.numbers).deepEqual({ rows: 31, failedRows: 1, ratio: 0.968 });
  });

  it('should fail when a named row (WebDriver) failed, even above 95%', () => {
    // Arrange
    const html = swap(
      fixture('sannysoft'),
      'class="result passed" id="webdriver-result"',
      'class="result failed" id="webdriver-result"',
    );

    // Act
    const reading = scoredOf(scoreSannysoft(html));

    // Assert
    should(reading.pass).be.false();
    should(reading.failed).containEql('WebDriver');
  });

  it('should fail below 95% of the rows', () => {
    // Arrange: two more fpscanner rows fail, so 28 of 31 pass (90%).
    const html = swap(
      swap(fixture('sannysoft'), '<td class="passed">ok', '<td class="failed">ok'),
      '<td class="passed">ok',
      '<td class="failed">ok',
    );

    // Act
    const reading = scoredOf(scoreSannysoft(html));

    // Assert
    should(reading.pass).be.false();
    should(reading.numbers.failedRows).equal(3);
  });

  it('should say it could not read the score when a named row is gone', () => {
    // Act
    const reason = unreadableOf(scoreSannysoft(swap(fixture('sannysoft'), '>Permissions <', '>Permission <')));

    // Assert
    should(reason).match(/could not read score.*Permissions/u);
  });
});

describe('creepjs scorer', () => {
  it('should pass 0% headless and 0% stealth, and keep only 8 characters of the FP ID', () => {
    // Act
    const reading = scoredOf(scoreCreepJs(fixture('creepjs')));

    // Assert
    should(reading.pass).be.true();
    should(reading.numbers).deepEqual({ headless: 0, stealth: 0, likeHeadless: 56, fingerprint: '7562adaa' });
  });

  it('should fail a page that is more than 10% headless', () => {
    // Act
    const reading = scoredOf(scoreCreepJs(swap(fixture('creepjs'), /0% headless:/u, '40% headless:')));

    // Assert
    should(reading.pass).be.false();
    should(reading.failed).deepEqual(['headless']);
  });

  it('should fail a page that is caught patching itself', () => {
    // Act
    const reading = scoredOf(scoreCreepJs(swap(fixture('creepjs'), /0% stealth:/u, '15% stealth:')));

    // Assert
    should(reading.failed).deepEqual(['stealth']);
  });

  it('should say it could not read the score when the ratings are renamed', () => {
    // Act
    const reason = unreadableOf(scoreCreepJs(swap(fixture('creepjs'), 'stealth-rating', 'camouflage-rating')));

    // Assert
    should(reason).match(/could not read score.*ratings/u);
  });

  it('should say it could not read the score while the FP ID is still being drawn', () => {
    // Act
    const reason = unreadableOf(scoreCreepJs(swap(fixture('creepjs'), /<span>5<\/span>/u, '')));

    // Assert
    should(reason).match(/FP ID/u);
  });
});

describe('incolumitas scorer', () => {
  it('should fail the stock browser on the one test it fails, and report that the behavioral score was never produced', () => {
    // Act
    const reading = scoredOf(scoreIncolumitas(fixture('incolumitas')));

    // Assert
    should(reading.pass).be.false();
    should(reading.failed).deepEqual(['old.fpscanner.WEBDRIVER']);
    should(reading.numbers.tests).equal(36);
    should(reading.numbers.behavioral).equal('not scored (no pointer input)');
  });

  it('should pass when every test is OK and no behavioral score exists', () => {
    // Act
    const reading = scoredOf(
      scoreIncolumitas(swap(fixture('incolumitas'), '"WEBDRIVER": "FAIL"', '"WEBDRIVER": "OK"')),
    );

    // Assert
    should(reading.pass).be.true();
  });

  it('should pass a behavioral score of 0.9 and fail one of 0.3', () => {
    // Arrange
    const ok = swap(fixture('incolumitas'), 'id="behavioralScore">...<', 'id="behavioralScore">0.9<').replace(
      '"FAIL"',
      '"OK"',
    );

    // Act
    const good = scoredOf(scoreIncolumitas(ok));
    const bad = scoredOf(scoreIncolumitas(swap(ok, '>0.9<', '>0.3<')));

    // Assert
    should(good.pass).be.true();
    should(good.numbers.behavioral).equal(0.9);
    should(bad.pass).be.false();
    should(bad.failed).deepEqual(['behavioral score']);
  });

  it('should say it could not read the score while the tests have not run, or when they are not JSON', () => {
    // Act
    const empty = unreadableOf(
      scoreIncolumitas(
        swap(fixture('incolumitas'), /<pre id="new-tests">[\s\S]*?<\/pre\s*>/u, '<pre id="new-tests"></pre>'),
      ),
    );
    const broken = unreadableOf(
      scoreIncolumitas(
        swap(fixture('incolumitas'), /<pre id="new-tests">[\s\S]*?<\/pre\s*>/u, '<pre id="new-tests">{ oops</pre>'),
      ),
    );

    // Assert
    should(empty).match(/could not read score.*new-tests/u);
    should(broken).match(/not JSON/u);
  });

  it('should say it could not read the score when too few tests are left', () => {
    // Act
    const reason = unreadableOf(
      scoreIncolumitas(swap(fixture('incolumitas'), /"fpscanner": \{[\s\S]*?\}/u, '"fpscanner": {}')),
    );

    // Assert
    should(reason).match(/only \d+ tests/u);
  });
});

describe('rebrowser scorer', () => {
  it('should fail the stock browser on the Runtime.enable leak, and count what it warned about', () => {
    // Act
    const reading = scoredOf(scoreRebrowser(fixture('rebrowser')));

    // Assert
    should(reading.pass).be.false();
    should(reading.failed).deepEqual(['runtimeEnableLeak']);
    should(reading.numbers).deepEqual({
      passed: 13,
      detected: 1,
      warnings: 2,
      notTriggered: 4,
      warned: 'useragent,headless',
    });
  });

  it('should pass when nothing is detected, warnings notwithstanding', () => {
    // Act
    const reading = scoredOf(
      scoreRebrowser(swap(fixture('rebrowser'), '🔴 runtimeEnableLeak', '🟢 runtimeEnableLeak')),
    );

    // Assert
    should(reading.pass).be.true();
    should(reading.numbers.warnings).equal(2);
  });

  it('should say it could not read the score when the table has too few decided tests', () => {
    // Act
    const reason = unreadableOf(
      scoreRebrowser(swap(fixture('rebrowser'), /🟢 (?:viewport|pwInitScripts|platformMismatch)/gu, '⚪️ x')),
    );

    // Assert
    should(reason).match(/only \d+ decided tests/u);
  });
});

describe('turnstile scorer', () => {
  const token = 'x'.repeat(40);

  it('should fail a page whose widgets issued no token without interaction', () => {
    // Act
    const reading = scoredOf(scoreTurnstile(fixture('turnstile')));

    // Assert
    should(reading.pass).be.false();
    should(reading.numbers).deepEqual({ widgets: 2, tokens: 0 });
  });

  it('should pass when every widget holds a token, and never put the token in the reading', () => {
    // Act
    const reading = scoredOf(scoreTurnstile(swap(fixture('turnstile'), /value=""/gu, `value="${token}"`)));

    // Assert
    should(reading.pass).be.true();
    should(JSON.stringify(reading)).not.containEql(token);
  });

  it('should fail when only one of two widgets got a token', () => {
    // Act
    const reading = scoredOf(scoreTurnstile(swap(fixture('turnstile'), /value=""/u, `value="${token}"`)));

    // Assert
    should(reading.pass).be.false();
    should(reading.numbers).deepEqual({ widgets: 2, tokens: 1 });
  });

  it('should say it could not read the score when no widget rendered', () => {
    // Act
    const reason = unreadableOf(scoreTurnstile(swap(fixture('turnstile'), /<input[^>]*>/gu, '')));

    // Assert
    should(reason).match(/no Turnstile widget/u);
  });
});

describe('recaptcha v3 scorer', () => {
  it('should pass the demo score of 0.9', () => {
    // Act
    const reading = scoredOf(scoreRecaptchaV3(fixture('recaptcha-v3')));

    // Assert
    should(reading.pass).be.true();
    should(reading.numbers).deepEqual({ score: 0.9 });
  });

  it('should fail a score of 0.3', () => {
    // Act
    const reading = scoredOf(scoreRecaptchaV3(swap(fixture('recaptcha-v3'), '"score": 0.9', '"score": 0.3')));

    // Assert
    should(reading.pass).be.false();
    should(reading.failed).deepEqual(['score']);
  });

  it('should say it could not read the score before the backend answers, and when it rejects the token', () => {
    // Act
    const waiting = unreadableOf(
      scoreRecaptchaV3(
        swap(
          fixture('recaptcha-v3'),
          /<pre class="response">[\s\S]*?<\/pre\s*>/u,
          '<pre class="response">{"json": "from-backend"}</pre>',
        ),
      ),
    );
    const rejected = unreadableOf(
      scoreRecaptchaV3(swap(fixture('recaptcha-v3'), '"success": true', '"success": false')),
    );
    const bare = unreadableOf(scoreRecaptchaV3(swap(fixture('recaptcha-v3'), '"score": 0.9,', '')));

    // Assert
    should(waiting).match(/has not answered/u);
    should(rejected).match(/did not accept/u);
    should(bare).match(/no score/u);
  });
});

describe('navia sign-in page scorer', () => {
  it('should pass a page that loaded with a sign-in form and no challenge', () => {
    // Act
    const reading = scoredOf(scoreNavia(fixture('navia')));

    // Assert
    should(reading.pass).be.true();
    should(reading.numbers).deepEqual({ status: 200, challenge: 'none', form: true });
  });

  it('should fail a blocked response, a recognised challenge and a missing form, each by name', () => {
    // Act
    const blocked = scoredOf(
      scoreNavia(
        swap(
          fixture('navia'),
          `name="${CAPTURE_META.status}" content="200"`,
          `name="${CAPTURE_META.status}" content="403"`,
        ),
      ),
    );
    const challenged = scoredOf(scoreNavia(withChallenge(fixture('navia'), 'cloudflare')));
    const blank = scoredOf(scoreNavia(swap(fixture('navia'), /<form[\s\S]*<\/form>/u, '')));

    // Assert
    should(blocked.failed).deepEqual(['status 403']);
    should(challenged.failed).deepEqual(['challenge cloudflare']);
    should(blank.failed).deepEqual(['sign-in form missing']);
    should([blocked, challenged, blank].map(reading => reading.pass)).deepEqual([false, false, false]);
  });

  it('should say it could not read the score when the capture carries no status', () => {
    // Act
    const reason = unreadableOf(
      scoreNavia(swap(fixture('navia'), new RegExp(`<meta name="${CAPTURE_META.status}"[^>]*>`, 'u'), '')),
    );

    // Assert
    should(reason).match(/no response status/u);
  });
});

describe('every scorer, on a page that is not the one it was written for', () => {
  const NOT_THE_PAGE = [
    ['an empty string', ''],
    ['an empty document', '<!doctype html><html><head></head><body></body></html>'],
    ['a block page', '<html><head><title>Access denied</title></head><body><h1>403 Forbidden</h1></body></html>'],
  ] as const;

  for (const check of CHECKS) {
    for (const [what, html] of NOT_THE_PAGE) {
      it(`should say it could not read the ${check.id} score from ${what}, never pass it`, () => {
        // Act
        const reason = unreadableOf(check.score(html));

        // Assert
        should(reason).startWith('could not read score');
      });
    }

    it(`should refuse the ${check.id} page when it was captured on another host`, () => {
      // Arrange
      const host = new URL(check.url).host;
      const html = swap(
        fixture(check.id),
        `name="${CAPTURE_META.host}" content="${host}"`,
        `name="${CAPTURE_META.host}" content="parked.example"`,
      );

      // Act
      const reason = unreadableOf(check.score(html));

      // Assert
      should(reason).match(/parked\.example/u);
    });

    it(`should refuse a ${check.id} capture that was cut short`, () => {
      // Act
      const reason = unreadableOf(
        check.score(swap(fixture(check.id), '<html', `<html ${CAPTURE_TRUNCATED_ATTRIBUTE}="true"`)),
      );

      // Assert
      should(reason).match(/too large to capture/u);
    });

    it(`should read the saved ${check.id} fixture from the host its check loads`, () => {
      // Act
      const reading = check.score(fixture(check.id));

      // Assert
      should(reading.kind).equal('scored');
      should(allowedHost(check.url)).be.true();
    });
  }
});

describe('the host list', () => {
  it('should allow exactly the hosts of the checks and refuse any other', () => {
    // Assert
    should(allowedHost('https://bot.sannysoft.com/')).be.true();
    should(allowedHost('https://app.naviabenefits.com/#/login')).be.true();
    should(allowedHost('https://secure.chase.com/web/auth/')).be.false();
    should(allowedHost('https://www.naviabenefits.com/')).be.false();
  });
});
