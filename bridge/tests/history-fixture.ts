import type { Bridge } from '../server/bridge.ts'

/** Existing DOM-window tests intentionally exercise a fully browsed transcript.
 * Startup and transport paging are covered separately, without this preload. */
export async function loadFixtureHistory(bridge: Bridge, id: string) {
  let view = await bridge.open(id)
  const seen = new Set<string>()
  while (view.history?.hasOlder && view.history.cursor) {
    if (seen.has(view.history.cursor)) throw new Error('Fixture history cursor repeated')
    seen.add(view.history.cursor)
    view = await bridge.olderHistory(id, view.history.cursor)
  }
  return view
}
