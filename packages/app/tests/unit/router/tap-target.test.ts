import { describe, expect, test } from 'bun:test';
import { routeTable } from '../../../src/router/routes.ts';
import { notificationTapTarget, PUSH_TAP_SCREENS } from '../../../src/router/tap-target.ts';

const ORIGIN = 'https://ferretry.example.test';
const routes = routeTable([
  ...PUSH_TAP_SCREENS,
  { plugin: 'access', id: 'join', path: '/join', label: 'Join' },
  { plugin: 'board', id: 'card', path: 'board/:card', label: 'Board' },
]);
const PAIRED = new Set(['laptop', 'a b']);
const tap = (allowed: string): string => notificationTapTarget(allowed, ORIGIN, routes, daemon => PAIRED.has(daemon));

describe('notificationTapTarget', () => {
  test('a good address under a paired machine: the ferret’s chat AT the ask opens exactly as named, query and all', () => {
    expect(tap(`${ORIGIN}/d/laptop/ferrets/f1/chat?ask=A3`)).toBe(`${ORIGIN}/d/laptop/ferrets/f1/chat?ask=A3`);
    expect(routes.parse('/d/laptop/ferrets/f1/chat')).toMatchObject({
      kind: 'screen',
      daemon: 'laptop',
      params: { ferret: 'f1' },
    });
  });

  test('the shell’s own pages open as named', () => {
    expect(tap(`${ORIGIN}/d/laptop`)).toBe(`${ORIGIN}/d/laptop`);
    expect(tap(`${ORIGIN}/app/`)).toBe(`${ORIGIN}/app/`);
    expect(tap(`${ORIGIN}/settings`)).toBe(`${ORIGIN}/settings`);
  });

  test('N1: the landing page, a daemon-less screen and an unpaired machine are not passed through from a push', () => {
    expect(tap(`${ORIGIN}/`)).toBe(`${ORIGIN}/app/`);
    expect(tap(`${ORIGIN}/join#c=123`)).toBe(`${ORIGIN}/app/`);
    expect(tap('/join#c=123')).toBe(`${ORIGIN}/app/`);
    expect(tap(`${ORIGIN}/d/nobody`)).toBe(`${ORIGIN}/app/`);
    expect(tap(`${ORIGIN}/d/nobody/ferrets/f1/chat?ask=A3`)).toBe(`${ORIGIN}/app/`);
    expect(tap(`${ORIGIN}/d/nobody/zzz`)).toBe(`${ORIGIN}/app/`);
  });

  test('a page the router does not draw opens its paired machine’s home — the old /session/ path included', () => {
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
    expect(notificationTapTarget(`${ORIGIN}/d/laptop`, ORIGIN, broken, () => true)).toBe(`${ORIGIN}/app/`);
  });
});
