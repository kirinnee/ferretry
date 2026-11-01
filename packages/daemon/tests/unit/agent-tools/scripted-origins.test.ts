import { describe, it } from 'bun:test';
import should from 'should';
import { agent, agentToolWorld, person } from './support.ts';

/**
 * THE MACHINE-WIDE SCRIPT TAINT (R3c-4, §7.3, invariant 25): every `browser.eval`, from ANY caller, tells the standing
 * rules the host it is about to run on (read inside the page's queue, right before the script) and the host it left
 * the page on. A host that can't be read is `undefined`: every page rule is tainted. A call refused before the script
 * could run taints nothing.
 */

function world() {
  const tainted: (string | undefined)[] = [];
  const order: string[] = [];
  const w = agentToolWorld({
    scriptedOrigins: {
      scriptedOn: host => {
        tainted.push(host);
        order.push(`taint ${String(host)}`);
      },
    },
  });
  return { ...w, tainted, order };
}

const EVAL = { tool: 'browser.eval', name: 'app', function: '() => 1' } as const;

describe('browser.eval taints the hosts it ran on, for the standing rules', () => {
  it('should taint the host before the script runs, then the host it left the page on', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://github.com/login' });
    w.browser.actedUrl = 'https://evil.example/after';
    const before = w.browser.acts.length;
    w.browser.beforeGuard.push(() => void w.order.push('queued'));

    await w.service.call(agent, EVAL);

    should(w.tainted).deepEqual(['github.com', 'evil.example']);
    // Inside the page's queue, before the act ran: the first taint lands before the eval is recorded.
    should(w.order).deepEqual(['queued', 'taint github.com', 'taint evil.example']);
    should(w.browser.acts.slice(before)).deepEqual([w.browser.acts.at(-1)]);
  });

  it('should taint EVERY rule when the host it runs on, or the one it ended on, cannot be read', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'about:blank' });
    w.browser.host = undefined;
    w.browser.actedUrl = 'about:blank';
    await w.service.call(agent, EVAL);
    should(w.tainted).deepEqual([undefined, undefined]);
  });

  it('should taint every rule when the script ran and then failed, so where it left the page is unknown', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://github.com/login' });
    w.browser.scriptOnPage = async (_session, _key, _script, guard) => {
      await guard?.({ document: async () => 'loader-1', host: async () => 'github.com' });
      throw new Error('the page crashed');
    };
    await w.service.call(agent, EVAL).catch(() => undefined);
    should(w.tainted).deepEqual(['github.com', undefined]);
  });

  it('should taint nothing when the call is refused before the script could run', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://github.com/login' });
    w.policy.off.add('scripts');
    await w.service.call(agent, EVAL).catch(() => undefined);
    w.policy.off.delete('scripts');
    w.browser.failure = new Error('the browser is not running');
    await w.service.call(agent, EVAL).catch(() => undefined);
    await w.service.call(agent, { ...EVAL, name: 'nowhere' }).catch(() => undefined);
    should(w.tainted).deepEqual([]);
  });

  it('should taint for a paired device’s script too: a rule fills for every caller in the one shared profile', async () => {
    const w = world();
    await w.service.call(person, { tool: 'browser.open', name: 'app', url: 'https://github.com/login' });
    await w.service.call(person, EVAL);
    should(w.tainted[0]).equal('github.com');
  });

  it('should taint nothing for the page tools that run no script', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://github.com/login' });
    await w.service.call(agent, { tool: 'browser.read', name: 'app' });
    await w.service.call(agent, { tool: 'browser.navigate', name: 'app', url: 'https://github.com/x' });
    should(w.tainted).deepEqual([]);
  });
});
