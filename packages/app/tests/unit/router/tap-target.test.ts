import { describe, expect, test } from 'bun:test';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { notificationTapTarget } from '../../../src/router/tap-target.ts';

const ORIGIN = 'https://ferretry.example.test';
const chat: ScreenRef = { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' };
const routes = routeTable([chat]);
const tap = (allowed: string): string => notificationTapTarget(allowed, ORIGIN, routes);

describe('notificationTapTarget', () => {
  test('a good address: the ferret’s chat AT the ask opens exactly as named, query and all', () => {
    expect(tap(`${ORIGIN}/d/laptop/ferrets/f1/chat?ask=A3`)).toBe(`${ORIGIN}/d/laptop/ferrets/f1/chat?ask=A3`);
    expect(routes.parse('/d/laptop/ferrets/f1/chat')).toMatchObject({
      kind: 'screen',
      daemon: 'laptop',
      screen: chat,
      params: { ferret: 'f1' },
    });
  });

  test('the shell’s own pages open as named', () => {
    expect(tap(`${ORIGIN}/d/laptop`)).toBe(`${ORIGIN}/d/laptop`);
    expect(tap(`${ORIGIN}/app/`)).toBe(`${ORIGIN}/app/`);
  });

  test('a page the router does not draw opens its machine’s home — the old /session/ path included', () => {
    expect(tap(`${ORIGIN}/d/laptop/session/f1?ask=A3`)).toBe(`${ORIGIN}/d/laptop`);
    expect(tap(`${ORIGIN}/d/laptop/nowhere`)).toBe(`${ORIGIN}/d/laptop`);
    expect(tap(`${ORIGIN}/d/a%20b/ferrets`)).toBe(`${ORIGIN}/d/a%20b`);
  });

  test('a foreign origin never opens: the app’s home instead', () => {
    for (const foreign of [
      'https://evil.test/d/laptop/ferrets/f1/chat?ask=A3',
      '//evil.test/x',
      'javascript:alert(1)',
    ]) {
      expect(tap(foreign)).toBe(`${ORIGIN}/app/`);
    }
  });

  test('junk never throws and never leaves the origin', () => {
    for (const junk of ['', 'not a url', '%', 'http://', '/d/%E0%A4%A/ferrets/f1/chat', '/d//x', '/unknown/page']) {
      let target = '';
      expect(() => {
        target = tap(junk);
      }).not.toThrow();
      expect(new URL(target).origin).toBe(ORIGIN);
    }
    expect(tap('/d/%E0%A4%A/ferrets/f1/chat')).toBe(`${ORIGIN}/app/`);
    expect(tap('/unknown/page')).toBe(`${ORIGIN}/app/`);
  });

  test('a route table that throws still opens the app’s home', () => {
    const broken = {
      parse: (): never => {
        throw new Error('boom');
      },
    };
    expect(notificationTapTarget(`${ORIGIN}/d/laptop`, ORIGIN, broken)).toBe(`${ORIGIN}/app/`);
  });
});
