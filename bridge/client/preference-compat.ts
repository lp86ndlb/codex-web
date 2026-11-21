import { defaultPreferences, type Preferences } from '../shared/types.ts'

// UI assets can be published while an older service is finishing its tasks.
// Keep only its unsupported layout setting locally, then flush it on reconnect.
const key = 'cweb:pending-todo-layout'
type TodoLayout = Pick<Preferences, 'todoPlacement' | 'showInspector'>
export function pendingTodoLayout(): TodoLayout | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    if (['sidebar', 'floating'].includes(value?.todoPlacement) && typeof value?.showInspector === 'boolean') return { todoPlacement: value.todoPlacement, showInspector: value.showInspector }
  } catch { /* Storage is unavailable or contains an obsolete value. */ }
}
export function compatiblePreferences(value?: Preferences): Preferences {
  const pending = pendingTodoLayout()
  return { ...defaultPreferences, ...value, ...(!value?.todoPlacement && !pending ? { showInspector: true } : {}), ...pending }
}
export function compatiblePreferencePatch(patch: Partial<Preferences>, nativeLayout: boolean) {
  const result = { ...patch }
  if (!nativeLayout) delete result.todoPlacement
  return result
}
export function rememberPreferenceWrite(value: Preferences, patch: Partial<Preferences>) {
  try {
    if (value.todoPlacement) {
      if (patch.todoPlacement) localStorage.removeItem(key)
    } else if (patch.todoPlacement || patch.showInspector !== undefined) {
      localStorage.setItem(key, JSON.stringify({ todoPlacement: patch.todoPlacement || compatiblePreferences(value).todoPlacement,
        showInspector: patch.showInspector ?? value.showInspector }))
    }
  } catch { /* Keep the live preference if browser storage is unavailable. */ }
}
