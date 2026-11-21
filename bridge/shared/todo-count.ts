export const todoCountEvent = 'cweb:todo-count'

export interface TodoCount {
  sessionId: string
  version: number
  count: number
}

export interface TodoCountSource { version: number; tasks: { state: string }[] }

export function todoCount(sessionId: string, note: TodoCountSource): TodoCount {
  return { sessionId, version: note.version, count: note.tasks.filter(task => task.state === 'active' || task.state === 'awaiting').length }
}
