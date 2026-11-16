/**
 * `daemon/worker/adapters/page-lifecycle.ts` sits in an `adapters/` directory, so the integration ledger judges it. It
 * touches no process, file or network: it is logic over page, dialog and timer ports, which the unit suite drives
 * with stand-ins. This file runs that same suite in the integration tier, so the ledger sees the behaviour proved
 * rather than a second copy of it that could drift.
 */
import '../../unit/worker/page-lifecycle.test.ts';
