// ── dsh-cuoti (错题本) v0.1.0 ─────────────────────────────────────────────────
// 踩过的坑、犯过的错、根因、解法、以后咋躲——全钉进系统提示词，同样的错不许犯第二遍。
// · 四个工具：cuoti_add 记错题 / cuoti_list 查错题 / cuoti_fix 改账 / cuoti_forget 删账
// · 一个全局提示词章节「错题本」：active 错题的守则每轮都在眼皮子底下
// · 账本落 ~/.dsh/storages/dsh-cuoti/mistakes.json（JSON 原子写，同题自动合并）
// · 单实例闸门：幽灵 entry 双开也不许章节/工具注册两份（2026-10-05 dsh-im-alive 踩过的坑）
// 记忆库记生活账（人、偏好、约定），错题本记技术账（坑、根因、解法、守则），各记各的。

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-cuoti'
export const version = '0.1.0'
export const inject = ['tools', 'systemPrompt']

const SECTION_NAME = 'dsh-cuoti:rules'
const SECTION_ORDER = 320
const MAX_RULES = 30   // 提示词里最多钉多少条守则（按最近更新取）

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function stripBraces(text) {
  // 防 DSH 提示词变量插值引擎误解析（非内置变量的连续花括号安全转义）
  return String(text).replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, '{ {')
}

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx) {
  const storeFile = join(dshHome(), 'storages', 'dsh-cuoti', 'mistakes.json')

  // ── 账本 ────────────────────────────────────────────────────────────────────
  function loadStore() {
    try {
      if (!existsSync(storeFile)) return { version: 1, seq: 0, records: [] }
      const j = JSON.parse(readFileSync(storeFile, 'utf8'))
      return { version: j.version ?? 1, seq: j.seq ?? 0, records: Array.isArray(j.records) ? j.records : [] }
    } catch {
      return { version: 1, seq: 0, records: [] }
    }
  }
  function saveStore(store) {
    mkdirSync(dirname(storeFile), { recursive: true })
    const tmp = `${storeFile}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmp, storeFile)
  }

  // ── 提示词章节：active 错题的守则 ───────────────────────────────────────────
  function buildText() {
    const recs = loadStore().records
      .filter((r) => r && r.status !== 'archived' && (r.rule || r.title))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, MAX_RULES)
    const lines = recs.map((r) => {
      const tag = (Array.isArray(r.tags) && r.tags.length) ? `[${r.tags.slice(0, 2).join('/')}] ` : ''
      const fix = r.fix ? `（解法：${norm(r.fix).slice(0, 80)}）` : ''
      return `- ${tag}${norm(r.title) || '（无题面）'} → ${norm(r.rule) || '待补守则'}${fix}`
    })
    return stripBraces(`# 错题本 (dsh-cuoti) —— 同样的错不许犯第二遍
这是本小姐的错题本：以前踩过的坑、犯过的错、当时咋修的、以后咋躲，全钉在这儿。**摔过的坑不许摔第二遍**。
- 动手前扫一眼下面的守则，撞上的活儿按守则来——这些坑全踩过、解法全验过。
- 犯了新错/发现新坑 → 干完当场 cuoti_add 记账（题面/根因/解法/以后咋躲），别等第二遍才想起来。
- 解法升级/守则过时 → cuoti_fix 改账；用户点头才 cuoti_forget 删账。
- 记忆库记生活账（人、偏好、约定），错题本记技术账（坑、根因、解法、守则），两边都得勤快。

## 守则（${lines.length} 条，按最近更新排）
${lines.length ? lines.join('\n') : '- （本子还空着——从现在起摔一个坑记一条）'}`)
  }

  // ── 注册（单实例闸门：后加载者接管，任一时刻只许注册一份） ──────────────────
  const GUARD = Symbol.for('dsh-cuoti.reg')
  const disposers = []
  const owner = {
    dispose() {
      while (disposers.length) {
        try { disposers.pop()() } catch { /* 卸都卸了 */ }
      }
    },
  }
  const prev = globalThis[GUARD]
  if (prev && typeof prev.dispose === 'function') {
    prev.dispose()
  }
  globalThis[GUARD] = owner

  function refreshSection() {
    // 章节文本随账本变——改账就重挂，提示词永远端最新一本
    const i = disposers.findIndex((d) => d && d.__cuotiSection)
    if (i >= 0) {
      try { disposers[i]() } catch { /* 旧的不谢幕也得换新的 */ }
      disposers.splice(i, 1)
    }
    const disposer = ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: buildText() })
    if (typeof disposer === 'function') {
      disposer.__cuotiSection = true
      disposers.push(disposer)
    }
  }

  // ── 工具面 ──────────────────────────────────────────────────────────────────
  const cuotiAdd = {
    name: 'cuoti_add',
    description: '记一道错题进错题本：坑是啥/根因/解法/以后咋躲（rule 防再犯守则必填）。同题面再记会自动合并改账。干活犯了错、踩了坑、排完障就用它。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话题面（这个坑叫啥）' },
        problem: { type: 'string', description: '出错现场：啥症状、报啥错' },
        cause: { type: 'string', description: '根因：为啥会犯' },
        fix: { type: 'string', description: '解法：当时咋修好的' },
        rule: { type: 'string', description: '守则：以后咋做才不再犯（一句可执行的话）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 pwsh/插件/网络' },
      },
      required: ['title', 'rule'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const store = loadStore()
      const title = norm(args.title)
      const rule = norm(args.rule)
      if (!title || !rule) return { ok: false, error: 'title 和 rule 必填' }
      const existing = store.records.find((r) => r.status !== 'archived' && norm(r.title) === title)
      if (existing) {
        existing.problem = norm(args.problem) || existing.problem
        existing.cause = norm(args.cause) || existing.cause
        existing.fix = norm(args.fix) || existing.fix
        existing.rule = rule
        if (Array.isArray(args.tags) && args.tags.length) existing.tags = [...new Set([...(existing.tags ?? []), ...args.tags.map(norm)])]
        existing.updatedAt = nowIso()
        store.seq += 1
        saveStore(store)
        refreshSection()
        return { ok: true, action: 'merged', record: existing }
      }
      const record = {
        id: newId(),
        title,
        problem: norm(args.problem),
        cause: norm(args.cause),
        fix: norm(args.fix),
        rule,
        tags: Array.isArray(args.tags) ? args.tags.map(norm).filter(Boolean) : [],
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      store.records.push(record)
      store.seq += 1
      saveStore(store)
      refreshSection()
      return { ok: true, action: 'added', record }
    },
  }

  const cuotiList = {
    name: 'cuoti_list',
    description: '查错题本：按关键词搜（题面/现场/根因/解法/守则/标签），不带词就全列。用户问「以前踩过啥坑/这坑见过没」时用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（可空 = 全列）' },
        includeArchived: { type: 'boolean', description: '连归档的一起看，默认 false' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const store = loadStore()
      const q = norm(args.query).toLowerCase()
      const recs = store.records.filter((r) => {
        if (!args.includeArchived && r.status === 'archived') return false
        if (!q) return true
        return [r.title, r.problem, r.cause, r.fix, r.rule, (r.tags ?? []).join(' ')].join('\n').toLowerCase().includes(q)
      })
      return { ok: true, total: store.records.length, matched: recs.length, records: recs }
    },
  }

  const cuotiFix = {
    name: 'cuoti_fix',
    description: '改一道错题：补/换根因、解法、守则、标签，或 archive 归档（过时的守则）。不改 id。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '错题 id' },
        problem: { type: 'string', description: '新的出错现场' },
        cause: { type: 'string', description: '新的根因' },
        fix: { type: 'string', description: '新的解法' },
        rule: { type: 'string', description: '新的守则' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（整体替换）' },
        archive: { type: 'boolean', description: 'true 归档，false 取回归档' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const store = loadStore()
      const rec = store.records.find((r) => r.id === args.id)
      if (!rec) return { ok: false, error: `没这道错题：${args.id}` }
      for (const k of ['problem', 'cause', 'fix', 'rule']) {
        if (typeof args[k] === 'string' && norm(args[k])) rec[k] = norm(args[k])
      }
      if (Array.isArray(args.tags)) rec.tags = args.tags.map(norm).filter(Boolean)
      if (typeof args.archive === 'boolean') rec.status = args.archive ? 'archived' : 'active'
      rec.updatedAt = nowIso()
      store.seq += 1
      saveStore(store)
      refreshSection()
      return { ok: true, action: 'updated', record: rec }
    },
  }

  const cuotiForget = {
    name: 'cuoti_forget',
    description: '删一道错题（物理删）。只在用户明确说删的时候用；过时的守则走 cuoti_fix 归档，别直接删。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '错题 id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const store = loadStore()
      const before = store.records.length
      store.records = store.records.filter((r) => r.id !== args.id)
      if (store.records.length === before) return { ok: false, error: `没这道错题：${args.id}` }
      store.seq += 1
      saveStore(store)
      refreshSection()
      return { ok: true, action: 'deleted', id: args.id }
    },
  }

  for (const tool of [cuotiAdd, cuotiList, cuotiFix, cuotiForget]) {
    const d = ctx.tools.register(tool)
    if (typeof d === 'function') disposers.push(d)
  }
  refreshSection()

  // 卸载/热重载即净：本 owner 的注册全撤，全局让位
  ctx.effect(() => () => {
    owner.dispose()
    if (globalThis[GUARD] === owner) globalThis[GUARD] = null
  })

  ctx.logger?.info?.('dsh-cuoti v%s: 错题本摊开（%d 条守则钉进提示词）', version, loadStore().records.filter((r) => r.status !== 'archived').length)
}
