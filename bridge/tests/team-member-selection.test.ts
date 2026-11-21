import test from 'node:test'
import assert from 'node:assert/strict'
import type { TeamMember, TeamSnapshot } from '../shared/team.ts'
import { emptyMemberSelection, initialMemberPlacement, memberPlacementLevels, memberSelectionKey, readMemberSelection, rememberMemberPlacement, resolveMemberPlacement, saveMemberSelection, validMemberPlacement } from '../client/team-member-selection.ts'

const member = (threadId: string, level: number, parentId: string | null, groupId: string | null): TeamMember => ({ threadId, name: threadId, level, parentId, groupId, role: level === 1 ? 'lead' : level === 2 ? 'manager' : 'worker', cwd: '/project', order: 0, useDefaults: true, model: '', effort: '' })
function graph(): Pick<TeamSnapshot, 'members' | 'groups' | 'levels'> {
  return { levels: ['负责人', '主管', '成员', '辅助'], members: [member('lead', 1, null, null), member('manager-a', 2, 'lead', 'managers'), member('manager-b', 2, 'lead', 'managers'), member('worker-a', 3, 'manager-a', 'a'), member('worker-b', 3, 'manager-b', 'b')], groups: [
    { id: 'managers', name: '主管', parentId: 'lead', level: 2, order: 0 },
    { id: 'a', name: 'A 组', parentId: 'manager-a', level: 3, order: 1 },
    { id: 'a-2', name: 'A 备选组', parentId: 'manager-a', level: 3, order: 2 },
    { id: 'b', name: 'B 组', parentId: 'manager-b', level: 3, order: 3 },
  ] }
}
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) } } }

test('first use follows the most recently joined valid member instead of always choosing level two', () => {
  assert.deepEqual(initialMemberPlacement(graph(), emptyMemberSelection()), { level: 3, parentId: 'manager-b', groupId: 'b' })
  const state = graph(); state.members = state.members.slice(0, 1)
  assert.deepEqual(initialMemberPlacement(state, emptyMemberSelection()), { level: 2, parentId: 'lead', groupId: '' })
})

test('empty teams allow only the single root even if memory or context names another level', () => {
  const state = graph(); state.members = []; state.groups = []
  const memory = rememberMemberPlacement(emptyMemberSelection(), { level: 3, parentId: 'old-manager', groupId: 'old-group' })
  assert.deepEqual(memberPlacementLevels(state), [1])
  assert.deepEqual(initialMemberPlacement(state, memory, 'old-manager'), { level: 1, parentId: '', groupId: '' })
})

test('successful submissions survive reopening and a fresh storage read, scoped per workspace', () => {
  const store = storage(), state = graph(), a = { level: 3, parentId: 'manager-a', groupId: 'a-2' }, b = { level: 2, parentId: 'lead', groupId: 'managers' }
  assert.equal(saveMemberSelection(store, 'project-a', state, a, true), true)
  assert.equal(saveMemberSelection(store, 'project-b', state, b, true), true)
  assert.deepEqual(initialMemberPlacement(state, readMemberSelection(store, 'project-a')), a)
  assert.deepEqual(initialMemberPlacement(state, readMemberSelection(store, 'project-b')), b)
  assert.deepEqual(initialMemberPlacement(state, readMemberSelection(store, 'project-c')), { level: 3, parentId: 'manager-b', groupId: 'b' })
  assert.notEqual(memberSelectionKey('a:b'), memberSelectionKey('a/b'))
})

test('failed or cancelled forms and temporary navigation never overwrite successful defaults', () => {
  const store = storage(), state = graph(), saved = { level: 3, parentId: 'manager-a', groupId: 'a' }
  saveMemberSelection(store, 'project', state, saved, true)
  const before = store.getItem(memberSelectionKey('project'))
  let draft = rememberMemberPlacement(readMemberSelection(store, 'project'), { level: 2, parentId: 'lead', groupId: '' })
  draft = rememberMemberPlacement(draft, { level: 3, parentId: 'manager-b', groupId: 'b' })
  assert.equal(saveMemberSelection(store, 'project', state, resolveMemberPlacement(state, draft), false), false)
  assert.equal(store.getItem(memberSelectionKey('project')), before)
  assert.deepEqual(initialMemberPlacement(state, readMemberSelection(store, 'project')), saved)
})

test('a successful submission saves only its own selection, not other unsubmitted layers visited in that form', () => {
  const store = storage(), state = graph()
  saveMemberSelection(store, 'project', state, { level: 2, parentId: 'lead', groupId: 'managers' }, true)
  const temporary = rememberMemberPlacement(readMemberSelection(store, 'project'), { level: 2, parentId: 'lead', groupId: '' })
  const submitted = resolveMemberPlacement(state, temporary, { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  saveMemberSelection(store, 'project', state, submitted, true)
  assert.deepEqual(resolveMemberPlacement(state, readMemberSelection(store, 'project'), { level: 2 }), { level: 2, parentId: 'lead', groupId: 'managers' })
})

test('switching layers restores each layer parent and switching parents restores their own group', () => {
  const state = graph()
  let memory = rememberMemberPlacement(emptyMemberSelection(), { level: 2, parentId: 'lead', groupId: 'managers' })
  memory = rememberMemberPlacement(memory, { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  memory = rememberMemberPlacement(memory, { level: 3, parentId: 'manager-b', groupId: '' })
  assert.deepEqual(resolveMemberPlacement(state, memory, { level: 2 }), { level: 2, parentId: 'lead', groupId: 'managers' })
  assert.deepEqual(resolveMemberPlacement(state, memory, { level: 3 }), { level: 3, parentId: 'manager-b', groupId: '' })
  assert.deepEqual(resolveMemberPlacement(state, memory, { level: 3, parentId: 'manager-a' }), { level: 3, parentId: 'manager-a', groupId: 'a-2' })
})

test('an explicit node context overrides remembered level and parent but restores that parent group', () => {
  const state = graph()
  let memory = rememberMemberPlacement(emptyMemberSelection(), { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  memory = rememberMemberPlacement(memory, { level: 2, parentId: 'lead', groupId: 'managers' })
  assert.deepEqual(initialMemberPlacement(state, memory, 'manager-a'), { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  assert.deepEqual(initialMemberPlacement(state, memory, 'deleted-parent'), { level: 2, parentId: 'lead', groupId: 'managers' })
})

test('deleted parents, reassigned groups and removed levels are checked against the current graph', () => {
  const state = graph(), memory = rememberMemberPlacement(emptyMemberSelection(), { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  state.groups.find(group => group.id === 'a-2')!.parentId = 'manager-b'
  assert.deepEqual(initialMemberPlacement(state, memory), { level: 3, parentId: 'manager-a', groupId: 'a' })
  state.members = state.members.filter(member => member.threadId !== 'manager-a')
  assert.deepEqual(initialMemberPlacement(state, memory), { level: 3, parentId: 'manager-b', groupId: 'b' })
  state.levels = state.levels.slice(0, 2)
  assert.deepEqual(initialMemberPlacement(state, memory), { level: 2, parentId: 'lead', groupId: 'managers' })
})

test('a parent moved to another tier is not reused as an invalid remembered supervisor', () => {
  const state = graph(), memory = rememberMemberPlacement(emptyMemberSelection(), { level: 3, parentId: 'manager-a', groupId: 'a-2' })
  state.members.find(member => member.threadId === 'manager-a')!.level = 3
  const selection = initialMemberPlacement(state, memory)
  assert.deepEqual(selection, { level: 3, parentId: 'manager-b', groupId: 'b' })
  assert.equal(validMemberPlacement(state, selection), true)
  assert.equal(saveMemberSelection(storage(), 'project', state, { level: 3, parentId: 'manager-a', groupId: 'a-2' }, true), false)
})

test('broken, oversized and unavailable browser storage do not prevent choosing a valid placement', () => {
  const store = storage()
  for (const raw of ['not json', JSON.stringify({ version: 9 }), 'x'.repeat(65_000), JSON.stringify({ version: 1, lastLevel: '3', parents: [], groups: [] })]) {
    store.setItem(memberSelectionKey('project'), raw)
    assert.deepEqual(initialMemberPlacement(graph(), readMemberSelection(store, 'project')), { level: 3, parentId: 'manager-b', groupId: 'b' })
  }
  const denied = { getItem: () => { throw new Error('storage unavailable') }, setItem: () => { throw new Error('storage unavailable') } }
  assert.deepEqual(readMemberSelection(denied, 'project'), emptyMemberSelection())
  assert.equal(saveMemberSelection(denied, 'project', graph(), { level: 3, parentId: 'manager-b', groupId: 'b' }, true), false)
  assert.equal(saveMemberSelection(store, '', graph(), { level: 3, parentId: 'manager-b', groupId: 'b' }, true), false)
})
