import { describe, it } from 'bun:test';
import should from 'should';
import {
  DAEMON_FEATURES,
  daemonFeatureList,
  HealthViewSchema,
  hasFeature,
  LEGACY_MAX_IDEA_CHARS,
  MAX_IDEA_CHARS,
} from '../../src/lib/index.ts';

const HEALTH = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '4.84.0',
  pid: 1,
  sessions: 0,
  running: 0,
  monitors: 0,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: null,
  wardenTimerArmed: false,
  eventLoopLagMs: 0,
  lastSelfCheckAt: null,
  wedgeCount: 0,
  scratchGcEnabled: false,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-10-25T00:00:00Z',
} as const;

describe('daemon features', () => {
  it('should name the tail read of a transcript, so an app that ships first falls back to the forward walk', () => {
    should(DAEMON_FEATURES.messagesTail).equal('messages.tail.1');
    should(daemonFeatureList()).containEql('messages.tail.1');
  });

  it('should name login budgets, so the app offers the editor only on a machine that keeps them', () => {
    should(DAEMON_FEATURES.loginBudget).equal('login.budget.1');
    should(daemonFeatureList()).containEql('login.budget.1');
  });

  it('should name the work search, so the app and the CLI use it only on a machine that serves it', () => {
    should(DAEMON_FEATURES.workSearch).equal('work.search.1');
    should(daemonFeatureList()).containEql('work.search.1');
  });

  it('should report 2FA keys now that the app draws them', () => {
    should(DAEMON_FEATURES.twoFactorKeys).equal('accounts.2fa-keys.1');
    should(daemonFeatureList()).containEql('accounts.2fa-keys.1');
  });

  it('should report task plans now that the app draws the plan card', () => {
    // A plan fill closes an input card with a `plan` actor an older app's strict parse refuses: only a daemon that reports this fills one.
    should(DAEMON_FEATURES.taskPlan).equal('task-plan.1');
    should(daemonFeatureList()).containEql('task-plan.1');
    should(hasFeature({ features: daemonFeatureList() }, DAEMON_FEATURES.taskPlan)).be.true();
  });

  it('should name standing sign-in rules for the app to gate on, but not report them until the app draws the sheet', () => {
    // A rule fill closes an input card with a `sign-in-rule` actor an older app's strict parse refuses: the app ships first.
    should(DAEMON_FEATURES.signInRules).equal('sign-in-rules.1');
    should(daemonFeatureList()).not.containEql('sign-in-rules.1');
    should(hasFeature({ features: daemonFeatureList() }, DAEMON_FEATURES.signInRules)).be.false();
  });

  it('should report approve-on-phone now that the app draws the card', () => {
    should(DAEMON_FEATURES.phoneApproval).equal('input.phone-approval.1');
    should(daemonFeatureList()).containEql('input.phone-approval.1');
  });

  it('should report accounts and sign-ins now that the app draws the Accounts screen', () => {
    should(DAEMON_FEATURES.accountsSignIns).equal('accounts.signins.1');
    should(daemonFeatureList()).containEql('accounts.signins.1');
    should(hasFeature({ features: daemonFeatureList() }, DAEMON_FEATURES.accountsSignIns)).be.true();
  });

  it('should report the ferret session credential now that every route says whether a ferret may call it', () => {
    // A client that sees it switches to the session credential and never falls back: it is reported only
    // by a build whose `caller: 'any'` routes take that credential as the ferret's own.
    should(DAEMON_FEATURES.sessionCredential).equal('session.credential.1');
    should(daemonFeatureList()).containEql('session.credential.1');
  });

  it('should offer a feature only when the daemon listed it', () => {
    // Arrange
    const listed = { features: [DAEMON_FEATURES.packIdea4000] };

    // Act / Assert
    should(hasFeature(listed, DAEMON_FEATURES.packIdea4000)).be.true();
    should(hasFeature({ features: ['something.else'] }, DAEMON_FEATURES.packIdea4000)).be.false();
    should(hasFeature({ features: [] }, DAEMON_FEATURES.packIdea4000)).be.false();
  });

  it('should treat a daemon that reports no list as offering nothing', () => {
    // A daemon from before the list existed is the one the app most needs to be careful with.
    should(hasFeature({}, DAEMON_FEATURES.packIdea4000)).be.false();
  });

  it('should list each feature name once, in a stable order', () => {
    // Arrange / Act
    const list = daemonFeatureList();

    // Assert
    should([...list]).deepEqual([...new Set(list)].sort());
    should(list).containEql('pack.idea.4000');
    // The app offers snooze only where this name is listed (an older daemon refuses it as an unknown action).
    should(list).containEql('agenda.snooze.1');
    should(list).containEql('agenda.clear-agents.1');
    // The app offers files on "Not good" only where this name is listed (an older daemon refuses the field).
    should(list).containEql('board.reopen.attachments.1');
    // The app draws "Done · closes &F12" only where this name is listed (an older daemon refuses `offerClose`).
    should(list).containEql('agenda.offer-close.1');
  });

  it('should keep the older idea limit below the raised one the feature unlocks', () => {
    should(LEGACY_MAX_IDEA_CHARS).equal(500);
    should(LEGACY_MAX_IDEA_CHARS).be.below(MAX_IDEA_CHARS);
  });

  it('should parse a health report from a daemon that predates the list, and one that carries it', () => {
    // Arrange / Act
    const older = HealthViewSchema.parse(HEALTH);
    const newer = HealthViewSchema.parse({ ...HEALTH, features: ['pack.idea.4000', 'one.the.app.never.heard.of'] });

    // Assert — an unknown name rides along rather than failing an older app
    should(older.features).be.undefined();
    should(newer.features).deepEqual(['pack.idea.4000', 'one.the.app.never.heard.of']);
  });
});
