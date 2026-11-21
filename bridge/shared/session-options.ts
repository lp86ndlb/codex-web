import type { SessionOptions } from './types.ts'

/** Empty model/effort selections follow the web settings. Keep those empty
 * selections in storage; resolve only when sending native parameters. */
export function withModelDefaults(options: SessionOptions, defaults: Pick<SessionOptions, 'model' | 'effort'>): SessionOptions {
  return { ...options, model: options.model || defaults.model, effort: options.effort || defaults.effort }
}
