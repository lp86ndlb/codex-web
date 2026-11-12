import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TodoNotePlugin } from '../server/todo-note.ts'

test('changing the live todo preserves durable guidance while retaining fresh focus and acceptance reminders', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(resolve('test-results/context-parts-'))
  try {
    const plugin = new TodoNotePlugin(root)
    await plugin.initialize(); await plugin.register('session')
    const before = await plugin.contextParts('session')
    await plugin.call('session', 'todo_note_update', { focus: { current: 'Inspect fixture', next: 'Review results' }, add_tasks: [{ title: 'Read-only fixture check' }] })
    const after = await plugin.contextParts('session')
    assert.equal(after.instructions, before.instructions)
    assert.notEqual(after.snapshot, before.snapshot)
    assert.ok(after.snapshot.includes('Inspect fixture'))
    assert.equal(await plugin.context('session'), after.instructions + '\n' + after.snapshot)
    const note = await plugin.get('session')
    await plugin.call('session', 'todo_note_complete', { id: note.tasks[0].id, note: 'Fixture evidence is ready' })
    const awaiting = await plugin.contextParts('session')
    assert.equal(awaiting.instructions, before.instructions)
    assert.match(awaiting.snapshot, /awaiting user acceptance/)
    await plugin.setEnabled(false)
    assert.deepEqual(await plugin.contextParts('session'), { instructions: '', snapshot: '' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
