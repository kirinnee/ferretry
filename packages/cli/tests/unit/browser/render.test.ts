import { describe, it } from 'bun:test';
import should from 'should';
import { renderBrowserAction, renderBrowserStatus, screenshotPayload } from '../../../src/lib/browser/render';
import { actionResult, status, statusOnlyResult, stoppedStatus } from './fixtures';

describe('status rendering', () => {
  it('should lead with the session, lifecycle, viewport, and viewer capacity', () => {
    // Act
    const actual = renderBrowserStatus(status());

    // Assert
    should(actual.split('\n')[0]).equal('sess-1  browser running  1280x800  viewers 1/3');
  });

  it('should always state that the profile is persistent and how long idle is tolerated', () => {
    // Act
    const actual = renderBrowserStatus(stoppedStatus());

    // Assert
    should(actual).containEql('profile persistent · idle timeout 300s');
    should(actual).not.containEql('idle deadline');
  });

  it('should print the idle deadline when the daemon reported one', () => {
    // Act
    const actual = renderBrowserStatus(status({ idleDeadline: '2026-01-01T00:00:00.000Z' }));

    // Assert
    should(actual).containEql('idle deadline 2026-01-01T00:00:00.000Z');
  });

  it('should name whoever acted most recently without arbitrating input', () => {
    // Act
    const actual = renderBrowserStatus(
      status({ lastActor: { kind: 'human', at: '2026-01-01T00:00:00.000Z', action: 'click' } }),
    );

    // Assert
    should(actual).containEql('last human: click at 2026-01-01T00:00:00.000Z');
  });

  it('should name the page the agent is driving', () => {
    // Act
    const actual = renderBrowserStatus(
      status({ agentPage: { pageId: 'page-2', kind: 'agent', action: 'read', at: '2026-01-01T00:00:00.000Z' } }),
    );

    // Assert
    should(actual).containEql('agent page page-2: read at 2026-01-01T00:00:00.000Z');
  });

  it('should mark the active tab and label an untitled one', () => {
    // Act
    const actual = renderBrowserStatus(status());

    // Assert
    should(actual).containEql('* page-1  Example A  https://example.com/a');
    should(actual).containEql('  page-2  (untitled)  https://example.com/b');
  });

  it('should report page readiness and history availability', () => {
    // Act
    const actual = renderBrowserStatus(status());

    // Assert
    should(actual).containEql('page ready · back yes · forward no');
  });

  it('should report a page error only in the error page state', () => {
    // Act
    const actual = renderBrowserStatus(status({ pageState: 'error', pageError: 'navigation blocked' }));

    // Assert
    should(actual).containEql('page error: navigation blocked');
  });

  it('should report a lifecycle error', () => {
    // Act
    const actual = renderBrowserStatus(status({ state: 'error', error: 'chrome exited', pages: [] }));

    // Assert
    should(actual).containEql('error: chrome exited');
  });

  it('should omit page detail entirely for a browser that is not running a page', () => {
    // Act
    const actual = renderBrowserStatus(stoppedStatus());

    // Assert
    should(actual).not.containEql('page ');
    should(actual).not.containEql('*');
  });
});

describe('action rendering', () => {
  it('should print only the text a read fetched', () => {
    // Act
    const actual = renderBrowserAction(actionResult({ text: 'hello world' }), true);

    // Assert
    should(actual).equal('hello world');
  });

  it('should print nothing when a read came back without text', () => {
    // Act
    const actual = renderBrowserAction(actionResult(), true);

    // Assert
    should(actual).equal('');
  });

  it('should print the page an action landed on', () => {
    // Act
    const actual = renderBrowserAction(actionResult(), false);

    // Assert
    should(actual).equal('Example A\nhttps://example.com/a');
  });

  it('should print the url alone when the page has no title', () => {
    // Act
    const actual = renderBrowserAction(actionResult({ title: '' }), false);

    // Assert
    should(actual).equal('https://example.com/a');
  });

  it('should fall back to the full status when the daemon returned no page result', () => {
    // Act
    const actual = renderBrowserAction(statusOnlyResult(), false);

    // Assert
    should(actual).containEql('browser stopped');
  });
});

describe('screenshot payload', () => {
  it('should return the base64 the daemon sent', () => {
    // Act
    const actual = screenshotPayload(actionResult({ screenshotBase64: 'aGk=' }));

    // Assert
    should(actual).equal('aGk=');
  });

  it('should refuse a response that carries no screenshot bytes', () => {
    // Act + Assert
    should(() => screenshotPayload(actionResult())).throw(/no screenshot bytes/u);
    should(() => screenshotPayload(statusOnlyResult())).throw(/no screenshot bytes/u);
  });
});
