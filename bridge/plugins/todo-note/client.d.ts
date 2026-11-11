import type { ComponentType } from 'react'
declare function factory(require: (name: string) => unknown, transport: (path: string, body: object) => Promise<unknown>): { apply(context: unknown): void }
export default factory
