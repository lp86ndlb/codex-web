import { mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BridgeError } from './errors.ts'
import type { AttachmentInfo } from '../shared/types.ts'

export const attachmentLimit = 20 * 1024 * 1024
const schema = z.object({ id: z.string().uuid(), name: z.string().max(240), size: z.number(), kind: z.enum(['image', 'file']), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']) }).strict()
export class AttachmentStore {
  directory: string
  constructor(directory: string) { this.directory = directory }
  async save(name: string, data: Buffer): Promise<AttachmentInfo> {
    if (!data.length || data.length > attachmentLimit) throw new BridgeError('ATTACHMENT_SIZE', '附件必须非空，单个文件不能超过 20 MB', 413)
    const safe = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180)
    if (!safe || safe === '.' || safe === '..') throw new BridgeError('ATTACHMENT_NAME', '附件名称无效')
    const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : 'application/octet-stream'
    const id = randomUUID(); const dir = resolve(this.directory, id)
    const value: z.infer<typeof schema> = { id, name: safe, size: data.length, kind: mime.startsWith('image/') ? 'image' : 'file', mime }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try { await writeFile(resolve(dir, 'file-' + safe), data, { mode: 0o600 }); await writeFile(resolve(dir, 'attachment.json'), JSON.stringify(value), { mode: 0o600 }) }
    catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
    return this.view(value)
  }
  private view(value: z.infer<typeof schema>): AttachmentInfo { const { mime, ...info } = value; return { ...info, url: `/api/attachments/${info.id}/content` } }
  async get(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new BridgeError('ATTACHMENT_ID', '附件编号无效', 404)
    try {
      const value = schema.parse(JSON.parse(await readFile(resolve(this.directory, id, 'attachment.json'), 'utf8')))
      if (value.id !== id || basename(value.name) !== value.name || value.name.includes('\\')) throw new Error('invalid metadata')
      const path = await realpath(resolve(this.directory, id, 'file-' + value.name))
      if (!path.startsWith(resolve(this.directory, id) + sep)) throw new Error('invalid attachment path')
      return { info: this.view(value), mime: value.mime, path }
    } catch { throw new BridgeError('ATTACHMENT_MISSING', '附件不存在或已失效，请重新添加', 404) }
  }
  async input(ids: string[]) {
    const attachments = await Promise.all([...new Set(ids)].map(id => this.get(id)))
    if (!attachments.length) return []
    const descriptions = await Promise.all(attachments.map(async ({ info, path }) => {
      let contents = ''
      if (info.kind === 'file' && info.size <= 200_000) {
        const data = await readFile(path)
        if (!data.includes(0)) { try { contents = `\n文本内容：\n${new TextDecoder('utf-8', { fatal: true }).decode(data)}` } catch { /* Binary files remain local references for CLI tools. */ } }
      }
      return `附件：${JSON.stringify(info.name)}\n本地文件路径：${JSON.stringify(path)}${contents}`
    }))
    return [{ type: 'text', text: `<cweb_attachments>\n${JSON.stringify(attachments.map(row => row.info))}\n</cweb_attachments>\n以下是用户提供的附件内容，可按任务需要读取。\n${descriptions.join('\n\n')}` },
      ...attachments.filter(row => row.info.kind === 'image').map(row => ({ type: 'localImage', path: row.path }))]
  }
}
