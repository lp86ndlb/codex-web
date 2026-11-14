import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JsonStore } from './storage.ts'
import { BridgeError } from './errors.ts'

const receiptSchema = z.object({ id: z.string(), threadId: z.string(), digest: z.string(), state: z.enum(['pending', 'accepted', 'unknown', 'rejected']), updatedAt: z.number(), code: z.string().optional() })
export type SubmissionReceipt = z.infer<typeof receiptSchema>
export class SubmissionJournal {
  private store: JsonStore<Record<string, SubmissionReceipt>>
  constructor(file: string) { this.store = new JsonStore(file, {}, value => z.record(receiptSchema).parse(value)) }
  async claim(threadId: string, id: string, input: unknown) {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    return this.store.update(rows => {
      const previous = rows[id]
      if (previous) {
        if (previous.threadId !== threadId || previous.digest !== digest) throw new BridgeError('MESSAGE_ID_CONFLICT', '消息标识已用于另一次提交，请核对已有记录。', 409)
        return { fresh: false, receipt: previous }
      }
      const old = Object.values(rows).filter(row => ['accepted', 'rejected'].includes(row.state)).sort((a, b) => a.updatedAt - b.updatedAt)
      while (Object.keys(rows).length >= 2000 && old.length) delete rows[old.shift()!.id]
      if (Object.keys(rows).length >= 2000) throw new BridgeError('RECEIPTS_FULL', '存在过多未核对的提交，请先核对运行状态。', 409)
      const receipt: SubmissionReceipt = { id, threadId, digest, state: 'pending', updatedAt: Date.now() }
      rows[id] = receipt
      return { fresh: true, receipt }
    })
  }
  async get(threadId: string, id: string) { const receipt = (await this.store.read())[id]; return receipt?.threadId === threadId ? receipt : undefined }
  async settle(id: string, state: SubmissionReceipt['state'], code?: string) { await this.store.update(rows => { if (rows[id] && rows[id].state !== 'accepted') rows[id] = { ...rows[id], state, code, updatedAt: Date.now() } }) }
  async forget(id: string) { await this.store.update(rows => { delete rows[id] }) }
}
