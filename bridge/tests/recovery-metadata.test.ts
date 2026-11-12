import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RunHistory } from '../server/run-history.ts'
import { projectThread } from '../server/projection.ts'
import { PreferencesStore, preferencesSchema } from '../server/preferences.ts'

test('automatic retry provenance and last known context survive native history reload without storing message text', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/recovery-metadata-'))
  try {
    const native = { id: 'thread', turns: [{ id: 'retry', status: 'completed', startedAt: 1, completedAt: 2, items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'PRIVATE_FIXTURE_REQUEST_TEXT' }] }] }] }
    const first = projectThread(native)
    first.runs![0].recoveryOf = 'failed-source'
    first.contextUsage = { inputTokens: 350_000, windowTokens: 475_000, updatedAt: 1234 }
    await new RunHistory(root).save(first)
    const reopened = await new RunHistory(root).enrich(projectThread(native))
    assert.equal(reopened.runs![0].recoveryOf, 'failed-source')
    assert.deepEqual(reopened.contextUsage, first.contextUsage)
    assert.equal((await readFile(resolve(root, 'thread.json'), 'utf8')).includes('PRIVATE_FIXTURE_REQUEST_TEXT'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recovery and image input choices persist and unrelated patches preserve explicit opt-outs', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/recovery-preferences-'))
  try {
    const file = resolve(root, 'preferences.json'), store = new PreferencesStore(file)
    assert.equal((await store.snapshot()).preferences.autoRecovery, true)
    assert.equal((await store.snapshot()).preferences.imageInputMode, 'on-demand')
    await store.update({ autoRecovery: false, imageInputMode: 'inline' })
    await store.update(preferencesSchema.partial().parse({ fontSize: 18 }))
    const saved = await new PreferencesStore(file).snapshot()
    assert.equal(saved.preferences.autoRecovery, false)
    assert.equal(saved.preferences.imageInputMode, 'inline')
    assert.equal(preferencesSchema.partial().safeParse({ imageInputMode: 'compress-and-delete' }).success, false)
    assert.deepEqual(preferencesSchema.partial().parse({ fontSize: 17 }), { fontSize: 17 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
