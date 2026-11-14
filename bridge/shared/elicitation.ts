export interface ElicitationField {
  id: string; title: string; description: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'array'; required: boolean
  options?: { value: string; title: string }[]; initial?: unknown; format?: string
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number
}
export interface Elicitation { server: string; message: string; mode: 'form' | 'url' | 'unsupported'; fields: ElicitationField[]; url?: string; error?: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 8000) : ''
export function parseElicitation(params: Record<string, unknown>): Elicitation {
  const result: Elicitation = { server: text(params.serverName), message: text(params.message) || text(params.description), mode: 'unsupported', fields: [] }
  const unsupported = () => ({ ...result, mode: 'unsupported' as const, error: '这份请求包含尚未支持的表单或设备验证类型，可以取消或在支持它的原生客户端处理。' })
  if (params.mode === 'url') {
    try { const url = new URL(text(params.url)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unsupported(); return { ...result, mode: 'url', url: url.href } } catch { return unsupported() }
  }
  if (!['form', 'openai/form', 'openaiForm'].includes(String(params.mode))) return unsupported()
  const schema = object(params.requestedSchema), properties = object(schema.properties)
  const required = Array.isArray(schema.required) ? schema.required : []
  if (schema.type !== 'object' || Object.keys(properties).length > 40 || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key)) || Object.keys(schema).some(key => !['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties'].includes(key))) return unsupported()
  for (const [id, raw] of Object.entries(properties)) {
    const field = object(raw), type = String(field.type)
    if (['__proto__', 'constructor', 'prototype'].includes(id) || !['string', 'number', 'integer', 'boolean', 'array'].includes(type) || field.$ref || field.pattern || field.allOf || field.anyOf) return unsupported()
    const entry: ElicitationField = { id, title: text(field.title) || id, description: text(field.description), type: type as ElicitationField['type'], required: required.includes(id), initial: field.default, format: text(field.format) || undefined }
    const common = ['type', 'title', 'description', 'default']
    const allowed = type === 'string' ? ['enum', 'enumNames', 'oneOf', 'format', 'minLength', 'maxLength'] : type === 'array' ? ['items', 'minItems', 'maxItems'] : type === 'boolean' ? [] : ['minimum', 'maximum']
    if (Object.keys(field).some(key => !common.includes(key) && !allowed.includes(key)) || entry.format && !['email', 'uri', 'date', 'date-time'].includes(entry.format)) return unsupported()
    const values = type === 'array' ? object(field.items) : field
    if (type === 'array' && (Object.keys(values).some(key => !['type', 'enum', 'anyOf', 'oneOf'].includes(key)) || values.type && values.type !== 'string')) return unsupported()
    if (Array.isArray(values.enum)) {
      if (values.enum.some(value => typeof value !== 'string')) return unsupported()
      entry.options = values.enum.map((value, i) => ({ value, title: Array.isArray(field.enumNames) ? text(field.enumNames[i]) || value : value }))
    } else if (Array.isArray(values.oneOf) || Array.isArray(values.anyOf)) {
      const options = Array.isArray(values.oneOf) ? values.oneOf : values.anyOf as unknown[]
      if (options.some(option => typeof object(option).const !== 'string' || Object.keys(object(option)).some(key => !['const', 'title'].includes(key)))) return unsupported()
      entry.options = options.map(option => ({ value: String(object(option).const), title: text(object(option).title) || String(object(option).const) }))
    }
    if (entry.options && (!entry.options.length || entry.options.length > 100 || new Set(entry.options.map(o => o.value)).size !== entry.options.length)) return unsupported()
    if (type === 'array' && !entry.options) return unsupported()
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (typeof field[key] === 'number') entry[key] = field[key]
    result.fields.push(entry)
  }
  return { ...result, mode: 'form' }
}
export function validateElicitation(request: Elicitation, input: Record<string, unknown>) {
  if (request.mode === 'unsupported') throw new Error(request.error)
  if (request.mode === 'url') return null
  const result: Record<string, unknown> = Object.create(null)
  if (Object.keys(input).some(key => !request.fields.some(field => field.id === key))) throw new Error('回答包含未请求的字段')
  for (const field of request.fields) {
    const value = Object.hasOwn(input, field.id) ? input[field.id] : undefined
    if (value === undefined || value === null) { if (field.required) throw new Error('请填写：' + field.title); continue }
    let valid = true
    if (field.type === 'string') {
      valid = typeof value === 'string' && value.length <= Math.min(field.maxLength ?? 20000, 20000) && value.length >= (field.minLength ?? 0)
      if (valid && field.format === 'email') valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))
      if (valid && field.format === 'uri') { try { new URL(String(value)) } catch { valid = false } }
      if (valid && ['date', 'date-time'].includes(field.format || '')) valid = Number.isFinite(Date.parse(String(value)))
    } else if (field.type === 'boolean') valid = typeof value === 'boolean'
    else if (field.type === 'array') valid = Array.isArray(value) && value.length >= (field.minItems ?? 0) && value.length <= Math.min(field.maxItems ?? 100, 100) && new Set(value).size === value.length
    else valid = typeof value === 'number' && Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity)
    if (valid && field.options) valid = (Array.isArray(value) ? value : [value]).every(item => field.options!.some(option => option.value === item))
    if (!valid) throw new Error('请检查字段格式或范围：' + field.title)
    result[field.id] = value
  }
  return result
}
