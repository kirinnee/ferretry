/**
 * c58-sec3: the fleet capability limit is real on every ferret write. The ruling (owner, on !A538, choice (a)):
 *
 *   fleet.use       send, stop, resume, rename, signal, pin (the pin board and the sidebar pin)
 *   fleet.configure fork, move, handover (+ cancel, ask-to-stop-jobs), conversion-preview, POST /v1/ferrets,
 *                   revoke-credential, POST and DELETE /v1/restarts, POST /v1/ferrets/:id/runtime, and every OTHER door
 *                   that starts a ferret (board card start, lessons run and scan, pack routing clean-up; r1)
 *
 * Three halves, both read from the SHIPPED manifests (every plugin's, loaded as Gate's audited-route test loads them), so a
 * descriptor that loses its demand fails here:
 *
 *  1. every write the ruling names declares exactly its capability and axis;
 *  2. EVERY ferret write route (any non-GET under `/v1/ferrets`, `/v1/restarts` and `/v1/worktrees`, and any write a
 *     Ferrets manifest owns) declares SOME capability or is on the allowlist below with a reason. A write added without a
 *     capability fails the second half; a capability dropped from a route the ruling names fails the first.
 *
 *  3. every ferret write OUTSIDE `/v1/ferrets` (a plugin route whose handler reaches `ferrets.start`, `fork`, `move`,
 *     `handover`, `send` or `stop`) is on `OUTSIDE_FERRETS` with its capability, and a source scan fails any daemon file that
 *     calls `ferrets.start|fork|move|handover` that `STARTERS` does not name — so a new alias of a start, with or without a
 *     capability, fails RED until someone decides.
 *
 * Admission itself (a remote device refused, a default and a `--limited` device served, a loopback caller never refused, a
 * relayed one remote) is `core/gate/tests/unit/daemon/ferret-writes-fleet-limit.test.ts`, which cannot live here because
 * Ferrets does not import Gate's daemon.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifests, loadWorkspace } from '../../../../../scripts/gen/lib/workspace.ts';

const ROOT = resolve(import.meta.dir, '../../../../..');

/** What the owner's ruling names, by `METHOD path`: the axis each asks of `fleet`. */
const RULING: Readonly<Record<string, 'use' | 'configure'>> = {
  // fleet.use — the send path (a send, an interrupt, the ledger and the queue are one path; shared drafts follow sends)
  'POST /v1/ferrets/:ferretId/send': 'use',
  'POST /v1/ferrets/:ferretId/interrupt': 'use',
  'POST /v1/ferrets/:ferretId/sends/:sendId/retry': 'use',
  'POST /v1/ferrets/:ferretId/sends/:sendId/cancel': 'use',
  'POST /v1/ferrets/:ferretId/sends/:sendId/enter': 'use',
  'PATCH /v1/ferrets/:ferretId/queue/:messageId': 'use',
  'DELETE /v1/ferrets/:ferretId/queue/:messageId': 'use',
  'GET /v1/ferrets/:ferretId/shared-draft': 'use',
  'POST /v1/ferrets/:ferretId/shared-draft': 'use',
  'GET /v1/ferrets/:ferretId/shared-draft/stream': 'use',
  'POST /v1/ferrets/:ferretId/stop': 'use',
  'POST /v1/ferrets/:ferretId/resume': 'use',
  'POST /v1/ferrets/:ferretId/rename': 'use',
  'POST /v1/ferrets/:ferretId/signal': 'use',
  'POST /v1/ferrets/:ferretId/pin': 'use',
  'POST /v1/ferrets/:ferretId/unpin': 'use',
  'POST /v1/ferrets/:ferretId/pins': 'use',
  // fleet.configure — what changes how the host behaves
  'POST /v1/ferrets': 'configure',
  'POST /v1/ferrets/:ferretId/fork': 'configure',
  'POST /v1/ferrets/:ferretId/move': 'configure',
  'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs': 'configure',
  'POST /v1/ferrets/:ferretId/handover': 'configure',
  'POST /v1/ferrets/:ferretId/handover/cancel': 'configure',
  'POST /v1/ferrets/:ferretId/conversion-preview': 'configure',
  'POST /v1/ferrets/:ferretId/revoke-credential': 'configure',
  'POST /v1/restarts': 'configure',
  'DELETE /v1/restarts': 'configure',
  // the runtime switch relaunches the ferret on another model or effort, as a move does
  'POST /v1/ferrets/:id/runtime': 'configure',
};

/**
 * c58-sec3 r1, FERRET WRITES OUTSIDE /v1/ferrets: every route whose handler reaches `ferrets.start` / `fork` / `move` /
 * `handover` / `send` / `stop`, by `METHOD path`, with the capability and axis it must declare. A route that loses its
 * capability fails the first test below; a new route that reaches a ferret write is found by the `STARTERS` source scan.
 */
const OUTSIDE_FERRETS: Readonly<Record<string, { readonly capability: string; readonly axis: 'use' | 'configure' }>> = {
  // starts a ferret (the card text is its prompt)
  'POST /v1/board/cards/:cardId/start': { capability: 'fleet', axis: 'configure' },
  // start a miner ferret (one per batch for a scan)
  'POST /v1/lessons/run': { capability: 'fleet', axis: 'configure' },
  'POST /v1/lessons/scan': { capability: 'fleet', axis: 'configure' },
  // starts the ferret that rewrites the routing prompt
  'POST /v1/pack/routing/clean-up': { capability: 'fleet', axis: 'configure' },
  // the runtime switch (also on RULING; listed so this list is the whole outside picture)
  'POST /v1/ferrets/:id/runtime': { capability: 'fleet', axis: 'configure' },
  // send: a card act and a skip message a ferret
  'POST /v1/board/cards/:cardId': { capability: 'fleet', axis: 'use' },
  'POST /v1/board/skip': { capability: 'fleet', axis: 'use' },
  // the Warden starts an investigator and moves or stops ferrets: its own capability, which a --limited device never holds
  'POST /v1/warden/run': { capability: 'warden', axis: 'use' },
  'POST /v1/warden/investigate': { capability: 'warden', axis: 'use' },
};

/**
 * Daemon files that call `ferrets.start|fork|move|handover`, and the routes that reach each. The scan below fails a file this
 * table does not name (a new door) and an entry whose file no longer calls one (so the table cannot rot).
 */
const STARTERS: Readonly<Record<string, readonly string[]>> = {
  'packages/plugins/board/daemon/wiring.ts': ['POST /v1/board/cards/:cardId/start'],
  'packages/plugins/lessons/daemon/adapters/miner.ts': ['POST /v1/lessons/run', 'POST /v1/lessons/scan'],
  'packages/plugins/packs/daemon/adapters/ferrets.ts': ['POST /v1/pack/routing/clean-up'],
  'packages/plugins/warden/daemon/remedies.ts': ['POST /v1/warden/run'],
  'packages/plugins/warden/daemon/spawner.ts': ['POST /v1/warden/investigate'],
  'packages/plugins/warden/daemon/subsystem.ts': ['POST /v1/warden/run'],
};

const AGENDA = 'agenda actions are gated by who acts (the human or a ferret), never by a capability (docs/grants.md)';
const GAP = (proposed: string) => `GAP for the owner: not named by the ruling; proposed ${proposed}`;

/**
 * A ferret write that declares no capability, and why. An entry is a decision, not an exemption: the second test below
 * fails when a listed route gains a capability (delete the entry) or disappears (delete the entry), so the list cannot rot.
 */
const UNGOVERNED: Readonly<Record<string, string>> = {
  'PATCH /v1/ferrets/:ferretId/agenda-mode': AGENDA,
  'POST /v1/ferrets/:ferretId/agenda': AGENDA,
  'POST /v1/ferrets/:ferretId/agenda/replies': AGENDA,
  'PUT /v1/ferrets/:ferretId/agenda/:id/seen': AGENDA,
  'PATCH /v1/ferrets/:ferretId/compact-at': GAP('fleet.use'),
  'PATCH /v1/ferrets/:ferretId/hypermedia': GAP('fleet.use'),
  'POST /v1/ferrets/:ferretId/attachments': GAP('fleet.use (an attachment is part of a send)'),
  'POST /v1/ferrets/:ferretId/attachments/:attachmentId/unlock': GAP('fleet.use'),
  'DELETE /v1/ferrets/:ferretId/attachments/:attachmentId/unlock': GAP('fleet.use'),
  'PATCH /v1/ferrets/:ferretId/lessons': GAP('fleet.use'),
  'PATCH /v1/ferrets/:ferretId/pack': GAP('fleet.use'),
};

interface Declared {
  readonly plugin: string;
  readonly key: string;
  readonly capability?: { readonly capability: string; readonly axis: string };
}

const { loaded, failures } = await loadManifests(loadWorkspace(ROOT));
if (failures.length > 0) throw new Error(`a manifest failed to load: ${failures.join('; ')}`);

const DECLARED: readonly Declared[] = loaded.flatMap(({ manifest }) =>
  [...(manifest.actions?.routes ?? []), ...(manifest.actions?.sockets ?? [])].map(declared => {
    const route = declared as unknown as {
      readonly method: string;
      readonly path: string;
      readonly capability?: Declared['capability'];
    };
    return { plugin: manifest.id, key: `${route.method} ${route.path}`, capability: route.capability };
  }),
);

const FERRET_WRITE_PATH = /^\/v1\/(ferrets|restarts|worktrees)(\/|$)/u;
const isFerretWrite = (d: Declared): boolean => {
  const [method = '', path = ''] = d.key.split(' ');
  return (method !== 'GET' && FERRET_WRITE_PATH.test(path)) || (method !== 'GET' && d.plugin === 'ferrets');
};
const WRITES = DECLARED.filter(isFerretWrite);
const byKey = new Map(DECLARED.map(d => [d.key, d] as const));

describe('c58-sec3 the ruling: each named write asks its fleet axis', () => {
  for (const [key, axis] of Object.entries(RULING)) {
    test(`${key} declares fleet.${axis}`, () => {
      const declared = byKey.get(key);
      if (declared === undefined) throw new Error(`no manifest declares ${key}`);
      expect(declared.capability).toMatchObject({ capability: 'fleet', axis });
    });
  }
});

describe('c58-sec3 r1 ferret writes outside /v1/ferrets: each declares its capability', () => {
  for (const [key, want] of Object.entries(OUTSIDE_FERRETS)) {
    test(`${key} declares ${want.capability}.${want.axis}`, () => {
      const declared = byKey.get(key);
      if (declared === undefined) throw new Error(`no manifest declares ${key}`);
      expect(declared.capability).toMatchObject(want);
    });
  }

  test('every route a STARTERS file reaches is on the list above', () => {
    for (const [file, routes] of Object.entries(STARTERS))
      for (const key of routes) expect(OUTSIDE_FERRETS[key], `${file} reaches ${key}`).toBeDefined();
  });

  test('a daemon file that calls ferrets.start, fork, move or handover is named by STARTERS, and each entry still does', () => {
    const CALL = /\bferrets\??\.(start|fork|move|handover)\(/u;
    const found: string[] = [];
    for (const file of new Bun.Glob('packages/plugins/*/daemon/**/*.ts').scanSync({ cwd: ROOT })) {
      if (file.includes('/node_modules/') || file.includes('/tests/') || file.includes('/generated/')) continue;
      if (CALL.test(readFileSync(resolve(ROOT, file), 'utf8'))) found.push(file);
    }
    expect(found.toSorted()).toEqual(Object.keys(STARTERS).toSorted());
  });
});

describe('c58-sec3 the route table: every ferret write is governed or listed', () => {
  test('the scan finds the writes it is meant to cover', () => {
    expect(WRITES.length).toBeGreaterThan(40);
    for (const key of [
      'POST /v1/ferrets',
      'POST /v1/restarts',
      'DELETE /v1/restarts',
      'POST /v1/ferrets/:ferretId/send',
    ])
      expect(WRITES.map(w => w.key)).toContain(key);
  });

  test('every ferret write declares a capability or is on the commented allowlist', () => {
    const ungoverned = WRITES.filter(w => w.capability === undefined && UNGOVERNED[w.key] === undefined);
    expect(ungoverned.map(w => `${w.plugin}: ${w.key}`)).toEqual([]);
  });

  test('the allowlist holds only routes that exist and still declare nothing', () => {
    for (const key of Object.keys(UNGOVERNED)) {
      const declared = byKey.get(key);
      if (declared === undefined) throw new Error(`the allowlist names ${key}, which no manifest declares`);
      expect(declared.capability).toBeUndefined();
    }
  });

  test('no route is both named by the ruling and on the allowlist', () => {
    expect(Object.keys(RULING).filter(key => key in UNGOVERNED)).toEqual([]);
  });
});
