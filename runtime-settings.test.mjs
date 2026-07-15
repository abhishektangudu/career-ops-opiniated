/**
 * runtime-settings.test.mjs — unit tests for the shared runtime-settings loader.
 *
 * Covers: precedence (env > file > unset), tolerance (missing/broken JSON → {}),
 * maskKey never leaks the full key, model default only when both unset, and the
 * RUNTIME_SETTINGS_PATH override.
 *
 * Run: node --test runtime-settings.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SETTING_ENV_MAP,
  SETTING_NAMES,
  DEFAULT_GEMINI_MODEL,
  settingsFilePath,
  loadRuntimeSettings,
  resolveSetting,
  resolveAllSettings,
  maskKey,
} from './runtime-settings.mjs';

/** Create a temp root with an optional config/runtime.json. */
function makeRoot(json) {
  const root = mkdtempSync(join(tmpdir(), 'rt-settings-'));
  if (json !== undefined) {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'runtime.json'), json, 'utf-8');
  }
  return root;
}

const SAMPLE_KEY = 'AIzaSyExampleKey1234567890abcd4vXQ';

test('SETTING_ENV_MAP maps all five logical names', () => {
  assert.deepEqual(SETTING_NAMES, [
    'geminiApiKey',
    'geminiModel',
    'googleSpreadsheetId',
    'googleDriveFolderId',
    'googleStorageBucket',
  ]);
  assert.equal(SETTING_ENV_MAP.geminiApiKey, 'GEMINI_API_KEY');
  assert.equal(SETTING_ENV_MAP.googleStorageBucket, 'GOOGLE_STORAGE_BUCKET');
});

test('precedence: env wins over file', () => {
  const root = makeRoot(JSON.stringify({ geminiApiKey: 'file-key', googleStorageBucket: 'file-bucket' }));
  try {
    const env = { GEMINI_API_KEY: 'env-key' };
    assert.equal(resolveSetting('geminiApiKey', { root, env }), 'env-key');
    // No env override for bucket → file value used.
    assert.equal(resolveSetting('googleStorageBucket', { root, env }), 'file-bucket');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('precedence: file used when env unset; unset when neither', () => {
  const root = makeRoot(JSON.stringify({ googleSpreadsheetId: 'sheet-1' }));
  try {
    const env = {};
    assert.equal(resolveSetting('googleSpreadsheetId', { root, env }), 'sheet-1');
    assert.equal(resolveSetting('googleDriveFolderId', { root, env }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty / whitespace strings are treated as unset at every layer', () => {
  const root = makeRoot(JSON.stringify({ geminiApiKey: '   ' }));
  try {
    // Empty env string does NOT shadow the (also-empty) file value → unset.
    assert.equal(resolveSetting('geminiApiKey', { root, env: { GEMINI_API_KEY: '' } }), undefined);
    // Whitespace file value → unset.
    assert.equal(resolveSetting('geminiApiKey', { root, env: {} }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tolerance: missing file → {}', () => {
  const root = makeRoot(); // no config/runtime.json
  try {
    assert.deepEqual(loadRuntimeSettings(root), {});
    assert.equal(resolveSetting('geminiApiKey', { root, env: {} }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tolerance: broken JSON → {} (never throws)', () => {
  const root = makeRoot('{ this is : not json,,, ');
  try {
    assert.deepEqual(loadRuntimeSettings(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tolerance: non-object JSON (array/number) → {}', () => {
  const rootArr = makeRoot('[1,2,3]');
  const rootNum = makeRoot('42');
  try {
    assert.deepEqual(loadRuntimeSettings(rootArr), {});
    assert.deepEqual(loadRuntimeSettings(rootNum), {});
  } finally {
    rmSync(rootArr, { recursive: true, force: true });
    rmSync(rootNum, { recursive: true, force: true });
  }
});

test('maskKey never leaks the full key', () => {
  const masked = maskKey(SAMPLE_KEY);
  assert.equal(masked, 'AIza…4vXQ');
  assert.ok(!masked.includes(SAMPLE_KEY));
  assert.ok(masked.length < SAMPLE_KEY.length);
  // The middle of the key must not appear in the mask.
  assert.ok(!masked.includes('ExampleKey'));
});

test('maskKey returns null when unset / empty', () => {
  assert.equal(maskKey(undefined), null);
  assert.equal(maskKey(''), null);
  assert.equal(maskKey('   '), null);
});

test('maskKey fully redacts short values (no meaningful prefix leak)', () => {
  assert.equal(maskKey('abcd'), '…abcd');
  assert.equal(maskKey('short12'), '…rt12');
});

test('model default applies only when both env and file unset', () => {
  const rootEmpty = makeRoot();
  try {
    const { values, sources } = resolveAllSettings({ root: rootEmpty, env: {} });
    assert.equal(values.geminiModel, DEFAULT_GEMINI_MODEL);
    assert.equal(sources.geminiModel, 'unset'); // defaulted, not configured
  } finally {
    rmSync(rootEmpty, { recursive: true, force: true });
  }

  const rootFile = makeRoot(JSON.stringify({ geminiModel: 'gemini-file-model' }));
  try {
    const { values, sources } = resolveAllSettings({ root: rootFile, env: {} });
    assert.equal(values.geminiModel, 'gemini-file-model');
    assert.equal(sources.geminiModel, 'file');
  } finally {
    rmSync(rootFile, { recursive: true, force: true });
  }

  const rootEnv = makeRoot(JSON.stringify({ geminiModel: 'gemini-file-model' }));
  try {
    const { values, sources } = resolveAllSettings({ root: rootEnv, env: { GEMINI_MODEL: 'gemini-env-model' } });
    assert.equal(values.geminiModel, 'gemini-env-model');
    assert.equal(sources.geminiModel, 'env');
  } finally {
    rmSync(rootEnv, { recursive: true, force: true });
  }
});

test('resolveAllSettings reports per-field sources and never includes the raw key', () => {
  const root = makeRoot(JSON.stringify({ geminiApiKey: 'file-key', googleStorageBucket: 'bkt' }));
  try {
    const env = { GEMINI_API_KEY: SAMPLE_KEY };
    const { values, sources } = resolveAllSettings({ root, env });
    assert.equal(values.geminiApiKey, SAMPLE_KEY);
    assert.equal(sources.geminiApiKey, 'env');
    assert.equal(sources.googleStorageBucket, 'file');
    assert.equal(sources.googleSpreadsheetId, 'unset');
    // sources must be plain string labels — never the key value.
    assert.deepEqual([...new Set(Object.values(sources))].sort(), ['env', 'file', 'unset']);
    const serialized = JSON.stringify(sources);
    assert.ok(!serialized.includes(SAMPLE_KEY));
    assert.ok(!serialized.includes('file-key'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RUNTIME_SETTINGS_PATH override is honored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-override-'));
  const custom = join(dir, 'custom-runtime.json');
  writeFileSync(custom, JSON.stringify({ geminiApiKey: 'override-key' }), 'utf-8');
  const prev = process.env.RUNTIME_SETTINGS_PATH;
  process.env.RUNTIME_SETTINGS_PATH = custom;
  try {
    // Path resolves to the override regardless of root.
    assert.equal(settingsFilePath('/some/unrelated/root'), custom);
    assert.equal(resolveSetting('geminiApiKey', { root: '/some/unrelated/root', env: {} }), 'override-key');
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_SETTINGS_PATH;
    else process.env.RUNTIME_SETTINGS_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settingsFilePath defaults to config/runtime.json under root', () => {
  const prev = process.env.RUNTIME_SETTINGS_PATH;
  delete process.env.RUNTIME_SETTINGS_PATH;
  try {
    assert.equal(settingsFilePath('/my/root'), join('/my/root', 'config', 'runtime.json'));
  } finally {
    if (prev !== undefined) process.env.RUNTIME_SETTINGS_PATH = prev;
  }
});
