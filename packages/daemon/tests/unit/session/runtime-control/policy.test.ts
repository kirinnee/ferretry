import { describe, it } from 'bun:test';
import should from 'should';
import { CODEX_PICKER_QUARANTINE_KIND } from '../../../../src/lib/session/harness/quarantine.ts';
import { IDLE_SEND_STATUSES } from '../../../../src/lib/session/send/types.ts';
import {
  documentRefusal,
  needsLiveCatalog,
  paneRefusal,
  switchRequest,
} from '../../../../src/lib/session/runtime-control/policy.ts';
import { CLAUDE_VIEW, CODEX_VIEW } from './support.ts';

/**
 * The decidable half, stated as an ordered list rather than as `if`s between awaits.
 *
 * The order IS the contract: a document refusal must be reachable without touching tmux, and a pane
 * refusal must be reachable without planning a switch.
 */

describe('what a session document alone refuses', () => {
  it('should let a running session through', () => {
    // Act / Assert
    should(documentRefusal(CLAUDE_VIEW(), 'fy', 'public')).be.undefined();
  });

  it('should refuse terminal statuses from the public running window', () => {
    // Act
    const refusals = (['failed', 'stopped', 'completed'] as const).map(status =>
      documentRefusal(CLAUDE_VIEW({ status }), 'fy', 'public'),
    );

    // Assert
    should(refusals.map(refusal => refusal?.failure)).deepEqual(['refused', 'refused', 'refused']);
    should(refusals[0]).match({ message: /requires a running session/u });
  });

  it('should refuse a session whose stop has already failed before touching its pane', () => {
    const refusal = documentRefusal(CLAUDE_VIEW({ status: 'kill_failed' }), 'fy', 'public');

    should(refusal).match({ failure: 'refused', message: /kill_failed/u });
  });

  it('should admit every durable idle status through the public window', () => {
    // A declared wait is the canonical point to change a model or compact, and each of these is
    // already idle by the send domain's definition. The later pane check still requires a prompt.
    const refusals = [...IDLE_SEND_STATUSES].map(status => documentRefusal(CLAUDE_VIEW({ status }), 'fy', 'public'));

    should(refusals).deepEqual([undefined, undefined, undefined, undefined]);
  });

  it('should admit retrying through the public window', () => {
    // Retry is not one of the send domain's named idle statuses, but its durable state is still
    // nonterminal; the pane check decides whether its harness is ready for this control right now.
    should(documentRefusal(CLAUDE_VIEW({ status: 'retrying' }), 'fy', 'public')).be.undefined();
  });

  it('should refuse a picker quarantine and name the CLI a human actually types', () => {
    // Act
    const refusal = documentRefusal(
      CLAUDE_VIEW({ needsHumanKind: CODEX_PICKER_QUARANTINE_KIND, needsHuman: 'resume it' }),
      'fy',
      'public',
    );

    // Assert
    should(refusal).match({ failure: 'refused', message: /fy/u });
  });

  it('should not read an UNRELATED needs-human as a picker quarantine', () => {
    // Act / Assert
    should(
      documentRefusal(CLAUDE_VIEW({ needsHumanKind: 'question', needsHuman: 'answer it' }), 'fy', 'public'),
    ).be.undefined();
  });

  it('should keep the private startup window exact', () => {
    // Act
    const publicOnStarting = documentRefusal(CLAUDE_VIEW({ status: 'starting' }), 'fy', 'public');
    const startupOnRunning = documentRefusal(CLAUDE_VIEW(), 'fy', 'startup');
    const startupOnWaiting = documentRefusal(CLAUDE_VIEW({ status: 'waiting' }), 'fy', 'startup');
    const startupOnStarting = documentRefusal(CLAUDE_VIEW({ status: 'starting' }), 'fy', 'startup');

    // Assert
    should(publicOnStarting).match({ failure: 'refused', message: /requires a running session/u });
    should(startupOnRunning).match({ failure: 'refused', message: /still starting/u });
    should(startupOnWaiting).match({ failure: 'refused', message: /still starting/u });
    should(startupOnStarting).be.undefined();
  });
});

describe('what a pane refuses', () => {
  it('should let a live, idle pane through', () => {
    // Act / Assert
    should(paneRefusal({ alive: true, dead: false, promptReady: true })).be.undefined();
  });

  it('should refuse a pane that is gone or whose harness exited', () => {
    // Act
    const refusals = [
      paneRefusal({ alive: false, dead: false, promptReady: true }),
      paneRefusal({ alive: true, dead: true, promptReady: true }),
    ];

    // Assert
    should(refusals.map(refusal => refusal?.failure)).deepEqual(['refused', 'refused']);
    should(refusals[0]).match({ message: /requires a live harness pane/u });
  });

  it('should refuse a pane that is not at an idle prompt', () => {
    // Act / Assert
    should(paneRefusal({ alive: true, dead: false, promptReady: false })).match({
      failure: 'refused',
      message: /waiting at an idle prompt/u,
    });
  });
});

describe('translating a control into a switch request', () => {
  it('should carry a model only when one was actually named', () => {
    // A bare `{action:'model'}` opens the picker and claims nothing, so it must not invent a target.
    // Act
    const actual = [
      switchRequest(CODEX_VIEW(), { action: 'model' }),
      switchRequest(CODEX_VIEW(), { action: 'model', model: 'gpt-5.6-codex' }),
    ];

    // Assert
    should(actual[0]).deepEqual({ harness: 'codex' });
    should(actual[1]).deepEqual({ harness: 'codex', model: 'gpt-5.6-codex' });
  });

  it('should carry an effort from either arm that can hold one', () => {
    // Act
    const actual = [
      switchRequest(CLAUDE_VIEW(), { action: 'effort', effort: 'high' }),
      switchRequest(CODEX_VIEW(), { action: 'model', model: 'gpt-5.6-codex', effort: 'max' }),
    ];

    // Assert
    should(actual[0]).deepEqual({ harness: 'claude', effort: 'high' });
    should(actual[1]).deepEqual({ harness: 'codex', model: 'gpt-5.6-codex', effort: 'max' });
  });
});

describe('deciding whether the live catalog is needed', () => {
  it('should need it for a targeted Codex switch and for nothing else', () => {
    // Probing for a bare picker open would break the manual escape hatch exactly when the catalog is
    // the thing that is broken.
    // Act
    const actual = [
      needsLiveCatalog({ harness: 'codex', model: 'gpt-5.6-codex', effort: 'high' }),
      needsLiveCatalog({ harness: 'codex', model: 'gpt-5.6-codex' }),
      needsLiveCatalog({ harness: 'codex', effort: 'high' }),
      needsLiveCatalog({ harness: 'codex' }),
      needsLiveCatalog({ harness: 'claude', model: 'opus', effort: 'high' }),
    ];

    // Assert
    should(actual).deepEqual([true, false, false, false, false]);
  });
});
