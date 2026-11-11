import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defaultPreferences, type ActivityCollapseTiming } from '../shared/types.ts'
import { PreferencesStore, preferencesSchema } from '../server/preferences.ts'

async function fixture(initial?: object) {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/preferences-collapse-'))
  const file = resolve(root, 'preferences.json')
  if (initial) await writeFile(file, JSON.stringify(initial))
  return { file, store: new PreferencesStore(file), close: () => rm(root, { recursive: true, force: true }) }
}

test('new preferences default to folding work details on next input without writing until changed', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.store.snapshot()).preferences.activityCollapseTiming, 'next-input')
    await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('legacy preferences gain collapse timing without replacing saved preferences or session options', async () => {
  const legacy = { ...defaultPreferences, theme: 'light', fontSize: 19, showActivityDetails: false }
  Reflect.deleteProperty(legacy, 'activityCollapseTiming')
  const options = { model: 'saved-model', effort: 'high', mode: 'read-only', approvalPolicy: 'on-request' }
  const initial = { preferences: legacy, sessions: { existing: options }, skillUsage: {}, disabledSkills: ['saved-skill'] }
  const f = await fixture(initial)
  try {
    const value = await f.store.snapshot()
    assert.deepEqual(value.preferences, { ...legacy, activityCollapseTiming: 'next-input' })
    assert.deepEqual(value.sessionOptions.existing, options)
    assert.deepEqual(await f.store.disabledSkills(), ['saved-skill'])
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), initial, 'Reading an old config must not rewrite its contents')
  } finally { await f.close() }
})

test('collapse timing persists all three values and unrelated HTTP-style patches do not reset it', async () => {
  const f = await fixture()
  try {
    for (const timing of ['completion', 'next-input', 'never'] as ActivityCollapseTiming[]) {
      await f.store.update(preferencesSchema.partial().parse({ activityCollapseTiming: timing }))
      assert.equal((await new PreferencesStore(f.file).snapshot()).preferences.activityCollapseTiming, timing)
      const patch = preferencesSchema.partial().parse({ fontSize: 18 })
      assert.deepEqual(patch, { fontSize: 18 }, 'Defaults must not be inserted into partial HTTP updates')
      await f.store.update(patch)
      assert.equal((await new PreferencesStore(f.file).snapshot()).preferences.activityCollapseTiming, timing)
    }
  } finally { await f.close() }
})

test('invalid collapse timing values are rejected and preserve the last valid saved state', async () => {
  const f = await fixture()
  try {
    await f.store.update({ activityCollapseTiming: 'never' })
    const saved = await readFile(f.file, 'utf8')
    for (const invalid of ['later', '', null, 1]) {
      assert.equal(preferencesSchema.partial().safeParse({ activityCollapseTiming: invalid }).success, false)
    }
    await assert.rejects(f.store.update({ activityCollapseTiming: 'later' as ActivityCollapseTiming }))
    assert.equal(await readFile(f.file, 'utf8'), saved)
    assert.equal((await f.store.snapshot()).preferences.activityCollapseTiming, 'never')
  } finally { await f.close() }
})
