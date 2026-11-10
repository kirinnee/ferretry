import { expect, test } from 'bun:test';
import { textLooksLikeCredential } from '../../src/v4/config.ts';

// Every key below is made up here, from a fixed seed: nothing in this file is a real credential.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/';

/** A digit-less, random-looking FAKE key of `length` characters, the same for the same seed. */
function fakeKey(seed: number, length: number): string {
  let state = seed >>> 0;
  let key = '';
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    key += ALPHABET[(state >>> 8) % ALPHABET.length];
  }
  return key;
}

const caught = (length: number, word: string): number =>
  Array.from({ length: 300 }, (_, seed) => textLooksLikeCredential(`${word} ${fakeKey(seed + 1, length)}\n`)).filter(
    Boolean,
  ).length;

test('digit residual: a digit-less 40-character fake key after "token" is caught', () => {
  const key = fakeKey(7, 40);
  expect(key).not.toMatch(/\d/u);
  expect(textLooksLikeCredential(`the token ${key} is old\n`)).toBe(true);
  expect(textLooksLikeCredential(`Bearer ${key}\n`)).toBe(true);
});

test('digit residual: nearly every random digit-less key of 32 to 64 characters is caught', () => {
  for (const length of [32, 40, 44, 64]) expect(caught(length, 'token')).toBeGreaterThanOrEqual(285);
});

test('digit residual: a digit-less key is caught after "Basic" too', () => {
  expect(textLooksLikeCredential(`Basic ${fakeKey(11, 44)}`)).toBe(true);
});

test('digit residual: a digit-less value shorter than 32 characters keeps the digit rule and carries', () => {
  for (let seed = 1; seed <= 50; seed++) expect(textLooksLikeCredential(`token ${fakeKey(seed, 24)}\n`)).toBe(false);
});

test('digit residual: a long camelCase or PascalCase identifier is not a key', () => {
  for (const identifier of [
    'getUserAccountSettingsHandlerFactoryImplementation',
    'GetUserAccountSettingsHandlerFactoryImplementation',
    'createRuntimeEnvironmentForTheSelectedProfileAndLogin',
    'ProfileComponentAssignmentValidationErrorFormatter',
    'normalizeTheWorkspaceRootBeforeComparingTwoPaths',
  ]) {
    expect(identifier.length).toBeGreaterThanOrEqual(32);
    expect(textLooksLikeCredential(`the token ${identifier} is a function\n`)).toBe(false);
  }
});

test('digit residual: a path in prose is not a key', () => {
  expect(textLooksLikeCredential('see the token /home/user/ProjectNotes/reviewSummaryFinalDraft/readmeFirst\n')).toBe(
    false,
  );
  expect(textLooksLikeCredential('Rotate the token ./docs/standards/softwareDesignPhilosophy/index.md\n')).toBe(false);
});

test('digit residual: a version in prose is not a key', () => {
  expect(textLooksLikeCredential('the token v4.291.5-rc.1+build.20261109 is current\n')).toBe(false);
  expect(textLooksLikeCredential('the token 1.2.3-releaseCandidateBuildOfTheWeek is current\n')).toBe(false);
});

test('digit residual: a long all-lower-case or all-upper-case word is not a key', () => {
  expect(textLooksLikeCredential('token internationalizationconfigurationmanager\n')).toBe(false);
  expect(textLooksLikeCredential('token INTERNATIONALIZATIONCONFIGURATIONMANAGER\n')).toBe(false);
});
