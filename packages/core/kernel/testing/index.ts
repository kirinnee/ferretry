/**
 * `@ferretry/kernel/testing` — the test host (§3.9, §7.8), the carrier and tool conformance suites, and the descriptor
 * parity harness. Imported only by tests and `contract/testing` (`context-imports`).
 *
 *   const host = await testHost({ plugins: [board], fakes: { asks: fakeAsks() }, clock: fixedClock('2026-11-06T09:00:00Z') });
 *   await host.request('POST', '/v1/board/cards/F12/move', { body: { lane: 'try-it' }, as: ferret('F12-holder') });
 *   host.crashAfterNextWrite();
 */
export { type ActRecord, TestMintedIds, testActRunner } from './act.ts';
export {
  type StandInStanding,
  type TestCaller,
  anonymous,
  device,
  ferret,
  member,
  owner,
  standInAdmission,
  testArrival,
  testPrincipal,
  warden,
} from './admission.ts';
export {
  type CarrierHarness,
  type CarrierPeer,
  RecordingLink,
  RecordingSessionLayer,
  carrierConformance,
  type CarrierSuiteOptions,
  SUITE_SESSION_ID,
  suiteFrame,
} from './carrier-suite.ts';
export { type DrivenClock, fixedClock } from './clock.ts';
export { type TestIdentity, testIdentity } from './identity.ts';
export {
  type OpenSocket,
  type RequestInit2 as TestRequestInit,
  type TestHost,
  type TestHostOptions,
  type TestResponse,
  testHost,
} from './host.ts';
export { testPluginClient } from './plugin-client.ts';
export { testReadText } from './read-text.ts';
export { COMPARED, type DescriptorRow, type ParityResult, type Table, parity, rowsOf } from './parity.ts';
export { RouteTable, compareRouteSpecificity, orderRoutesBySpecificity } from './router.ts';
export { MemoryStateFolder, SimulatedCrash, parseDocument } from './state.ts';
export { type ToolCase, toolConformance } from './tool-suite.ts';
