import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import fs from 'fs'
import path from 'path'
import type { Article } from './storage'
import { inferKernelSubsystem } from './subsystem'
import { inferFixedSubsystemFromFiles } from './fixedSubsystem'

const configPath = path.join(__dirname, '../../config.json')
let config = {
  openai: {
    apiKey: '',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-3.5-turbo',
    // 393216 = deepseek-flash (DeepSeek-V4.1-Flash) 的 max_output_tokens 上限。
    // 注意：1M(1048576) 是上下文窗口，不是输出上限，填 1M 会被 API 以
    // "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]" 拒绝。
    maxTokens: 393216
  }
}

if (fs.existsSync(configPath)) {
  try {
    const configData = fs.readFileSync(configPath, 'utf8')
    const loadedConfig = JSON.parse(configData)
    config = {
      openai: {
        ...config.openai,
        ...loadedConfig.openai
      }
    }
    console.log('[AI] 配置文件加载成功')
  } catch (error) {
    console.error('[AI] 读取配置文件失败:', error)
  }
}

const openai = new OpenAI({
  apiKey: config.openai.apiKey || '',
  baseURL: config.openai.baseURL || 'https://api.openai.com/v1',
})

const MAX_RETRIES = 3
const RETRY_DELAY = 1000

// 总览（「今日社区动态」正文）字数上限的默认值，可在 sources-config.json 用
// summaryMaxChars 覆盖。
// 注意：这里统计的是整行渲染后的可见字数，含图标、子系统名与「：」，13 个子系统的
// 固定开销约 178 字；若上限设得过低（如 500），留给点评正文的额度不足，兜底截断会
// 把每行从中间切断。
const DEFAULT_SUMMARY_MAX_CHARS = 900

// 统计“渲染后可见字数”：Markdown 链接/图片还原成其显示文本，去掉标记符号与空白，
// 再按 Unicode 码点计数（emoji 记 1 个字）。
function countVisibleChars(markdown: string): number {
  const visible = (markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, '')
  return Array.from(visible).length
}

// 把一行拆成 token：Markdown 链接整体作为一个 token，其余按码点切分。
// 按 token 截断可以避免把 [名称](#锚点) 剪断导致链接语法失效。
function markdownTokens(text: string): string[] {
  return text.match(/!?\[[^\]]*\]\([^)]*\)|./gsu) || []
}

// 按可见字数上限截断一行，超出部分用 …
function truncateVisible(text: string, limit: number): string {
  let kept = ''
  let count = 0
  for (const token of markdownTokens(text)) {
    const t = countVisibleChars(token)
    if (count + t > limit - 1) break
    kept += token
    count += t
  }
  return `${kept.replace(/[\s，。；：、,;:.]+$/, '')}…`
}

function cleanAIResponse(content: string): string {
  if (!content) return ''
  
  let cleaned = content
  
  cleaned = cleaned.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
  
  const thinkEndMatch = cleaned.match(/<\/think>/i)
  if (thinkEndMatch) {
    const afterThink = cleaned.substring(thinkEndMatch.index! + thinkEndMatch[0].length)
    cleaned = afterThink.trim()
  }
  
  const thinkStartMatch = cleaned.match(/<think[^>]*>/i)
  if (thinkStartMatch) {
    const beforeThink = cleaned.substring(0, thinkStartMatch.index)
    cleaned = beforeThink.trim()
  }
  
  cleaned = cleaned.replace(/^```json\s*/i, '')
  cleaned = cleaned.replace(/^```\s*/i, '')
  cleaned = cleaned.replace(/\s*```$/i, '')
  
  cleaned = formatSummaryItems(cleaned)
  
  cleaned = cleaned.trim()
  
  return cleaned
}

function formatSummaryItems(content: string): string {
  let cleaned = content
  
  cleaned = cleaned.replace(/^\s*\n+/gm, '\n')
  cleaned = cleaned.trim()
  
  return cleaned
}

function normalizeLineTags(line: string): string {
  const trimmed = (line || '').trim()
  if (!trimmed) return ''

  // Accept:
  // - "bugfix perf ..." (or separated by ':' '/' '|')
  // - "`bugfix` `perf` ..." (already normalized)
  let rest = trimmed
  const tags = new Set<string>()

  const take = (t: string) => tags.add(t)

  while (true) {
    const m = rest.match(/^(`?(feature|bugfix|other|perf)`?)([\s/:|]+)(.*)$/i)
    if (!m) break
    take(m[2].toLowerCase())
    rest = (m[4] || '').trim()
  }

  // also detect tags already present in-line
  if (rest.includes('`feature`')) tags.add('feature')
  if (rest.includes('`bugfix`')) tags.add('bugfix')
  if (rest.includes('`other`')) tags.add('other')
  if (rest.includes('`perf`')) tags.add('perf')

  // enforce mutual exclusivity among {feature, bugfix, other}
  const mainType: 'feature' | 'bugfix' | 'other' =
    tags.has('feature') ? 'feature' : tags.has('bugfix') ? 'bugfix' : 'other'
  const hasPerf = tags.has('perf')

  // strip any stray type tags already in text, we'll re-add cleanly
  rest = rest
    .replace(/`(feature|bugfix|other)`\s*/g, '')
    .replace(/`perf`\s*/g, '')
    .trim()

  const label = `${hasPerf ? '`perf` ' : ''}\`${mainType}\``.trim()
  return `${label} ${rest}`.trim()
}

// 模型很容易把每条都写成「…。该改动重要在于…；点评：…」这种填空句，整篇一个骨架，
// 读起来极其疲劳。提示词里已明令禁止，这里再兜底剥掉残留的固定句式与空泛评价。
const BOILERPLATE_REWRITES: Array<[RegExp, string]> = [
  [/(该|此|本次|这一)?改动(的)?(重要|意义|价值)(性)?(在于|是)[：:，,]?\s*/g, ''],
  [/(重要|意义|关键)(在于|是)[：:，,]?\s*/g, ''],
  [/[；;，,]?\s*点评[：:]\s*/g, '；'],
  [/(值得|建议)(持续|重点)?关注[。，,；;]?/g, ''],
  [/(整体)?风险(较|很|也)?低[。，,；;]?/g, ''],
  [/属于[^。；;]{0,20}的(改进|增强|维护|投入|补充|提升)[。，,；;]?/g, ''],
  [/无突出(的)?(性能|特性|功能)[^。；;]{0,20}[。，,；;]?/g, ''],
]

function stripBoilerplate(block: string): string {
  let out = block || ''
  for (const [re, to] of BOILERPLATE_REWRITES) out = out.replace(re, to)
  return out
    // 剥掉固定句式后常留下重复标点/悬空空格，这里收口
    .replace(/[。；;]\s*[。；;，,]/g, '。')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([。，,；;：:）)])/g, '$1')
}

function normalizeSummaryTagLines(block: string): string {
  return (block || '')
    .split('\n')
    .map(line => {
      const m = line.match(/^(\s*[-*]\s+)(.*)$/)
      if (m) return `${m[1]}${normalizeLineTags(m[2])}`
      return normalizeLineTags(line)
    })
    .join('\n')
    .trim()
}

function normalizeOneItemPerLine(block: string): string {
  const rawLines = (block || '').split('\n')
  const out: string[] = []

  const splitIfMultipleLinks = (line: string): string[] => {
    const t = line.trim()
    if (!t) return []
    // If a single line contains multiple patch links, split after each link.
    // Example: "... [↗](https://...) ... [↗](https://...)"
    // (Backward compatible: also accepts [🔗](...))
    const linkRe = /\[(?:↗|🔗)\]\([^\)]+\)/g
    const matches = Array.from(t.matchAll(linkRe))
    if (matches.length <= 1) return [t]

    const parts: string[] = []
    let start = 0
    for (const m of matches) {
      const end = (m.index || 0) + m[0].length
      const chunk = t.slice(start, end).trim()
      if (chunk) parts.push(chunk)
      start = end
    }
    const tail = t.slice(start).trim()
    if (tail) {
      // attach tail to last item if it doesn't start a new item
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${tail}`.trim()
    }
    return parts
  }

  const startsNewItem = (s: string) => {
    const t = s.trim()
    if (!t) return false
    return (
      t.startsWith('- ') ||
      t.startsWith('* ') ||
      t.startsWith('`feature`') ||
      t.startsWith('`bugfix`') ||
      t.startsWith('`other`') ||
      t.startsWith('`perf`')
    )
  }

  for (const line of rawLines) {
    for (const piece of splitIfMultipleLinks(line)) {
      const t = piece.trim()
      if (!t) continue
      if (out.length === 0) {
        out.push(t)
        continue
      }
      if (startsNewItem(t)) {
        out.push(t)
        continue
      }
      out[out.length - 1] = `${out[out.length - 1]} ${t}`.trim()
    }
  }

  return out
    .map(l => {
      const t = l.trim()
      if (t.startsWith('- ') || t.startsWith('* ')) return t
      return `- ${t}`
    })
    .join('\n')
    .trim()
}

function extractTags(line: string): { hasPerf: boolean; type: 'feature' | 'bugfix' | 'other' } {
  const tags = new Set<string>()
  const rx = /`(feature|bugfix|other|perf)`/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(line)) !== null) tags.add(m[1])
  return {
    hasPerf: tags.has('perf'),
    type: tags.has('feature') ? 'feature' : tags.has('bugfix') ? 'bugfix' : 'other',
  }
}

function extractLinks(line: string): string[] {
  const out: string[] = []
  const rx = /\[(?:↗|🔗)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(line)) !== null) out.push(m[1])
  return out
}

// 条目类型/perf 在抓取阶段已由规则算好（并随输入行的 type=/tag= 字段一并传给模型），
// 但模型偶尔会漏写这些标签。normalizeLineTags 对无标签的行兜底判定为 `other`，
// 一旦整段标签缺失，reorderAndCollapseSubsystemLines 就会误判为「全是次要改动」并
// 折叠成一行链接，把描述文本全部丢掉（曾导致 Networking 87 条 patch 退化成 1 行）。
// 这里按行内链接回查来源文章，直接用规则结果覆盖模型标签；匹配不到的行才保留模型判断。
function applySourceTags(block: string, articles: Article[]): string {
  const byUrl = new Map<string, { type: 'feature' | 'bugfix' | 'other'; perf: boolean }>()
  for (const a of articles) {
    const url = a.patchData?.url || a.gitCommitData?.url || a.url
    if (!url) continue
    const title = a.patchData?.title || a.gitCommitData?.title || a.title
    const content = a.patchData?.content || a.gitCommitData?.content || a.content || ''
    byUrl.set(url, { type: getArticleType(a), perf: detectPerfRelated(patchSignalText(title, content)) })
  }

  return (block || '')
    .split('\n')
    .map(line => {
      const m = line.match(/^(\s*[-*]\s+)(.*)$/)
      if (!m) return line

      const source = extractLinks(m[2])
        .map(u => byUrl.get(u))
        .find(Boolean)
      if (!source) return line

      const text = m[2]
        .replace(/^(`?(feature|bugfix|other|perf)`?[\s/:|]+)+/i, '')
        .replace(/`(feature|bugfix|other)`\s*/g, '')
        .replace(/`perf`\s*/g, '')
        .trim()
      const label = `${source.perf ? '`perf` ' : ''}\`${source.type}\``
      return `${m[1]}${label} ${text}`
    })
    .join('\n')
    .trim()
}

// 全段均为 `other` 且条目足够多时，说明该子系统当天确实只有次要改动，
// 折叠成一行概览避免刷屏；条目不多时保留原描述，不做折叠。
const COLLAPSE_OTHER_MIN_ITEMS = 6
// 单个子系统逐条展开的上限，超出的部分折成一行「另有 N 项」。
const DEFAULT_SUBSYSTEM_MAX_ITEMS = 10
// 折叠行里最多挂多少个链接，太多就只是刷屏。
const MAX_FOLDED_LINKS = 12

function renderLinks(links: string[]): string {
  const uniq: string[] = []
  for (const u of links) {
    if (u && !uniq.includes(u)) uniq.push(u)
  }
  const shown = uniq.slice(0, MAX_FOLDED_LINKS)
  const suffix = uniq.length > shown.length ? ` 等 ${uniq.length} 项` : ''
  return `${shown.map(u => `[↗](${u})`).join(' ')}${suffix}`
}

function reorderAndCollapseSubsystemLines(
  block: string,
  maxItems: number = DEFAULT_SUBSYSTEM_MAX_ITEMS
): string {
  const lines = (block || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  const items = lines.map((l, idx) => {
    const text = l.replace(/^[-*]\s+/, '').trim()
    const tags = extractTags(text)
    return { raw: text, ...tags, links: extractLinks(text), idx }
  })

  // 排序即优先级：perf > bugfix > feature > other。
  // 这里按「风险/收益」排而不是按类型字母序，是因为超出上限的尾部会被折叠掉——
  // 若把 feature 排在 bugfix 前面，折叠时丢掉的会是一整批回归修复。
  const orderType: Record<'feature' | 'bugfix' | 'other', number> = { bugfix: 1, feature: 2, other: 3 }
  items.sort((a, b) => {
    // 1) perf 优先
    // 2) 组内按 bugfix -> feature -> other
    // 3) 同组同类型保持原始顺序（稳定）
    const pa = a.hasPerf ? 0 : 1
    const pb = b.hasPerf ? 0 : 1
    if (pa !== pb) return pa - pb

    const ta = orderType[a.type]
    const tb = orderType[b.type]
    if (ta !== tb) return ta - tb

    return a.idx - b.idx
  })

  const otherItems = items.filter(i => i.type === 'other')
  const nonOther = items.filter(i => i.type !== 'other')

  // 全是次要改动且条目足够多：整块折成一行，一个描述都不展开。
  if (nonOther.length === 0 && otherItems.length >= COLLAPSE_OTHER_MIN_ITEMS) {
    return (
      `- \`other\` 本日另有 ${otherItems.length} 项次要改动（清理、文档、小修正等），详见：` +
      renderLinks(otherItems.flatMap(i => i.links))
    ).trim()
  }

  const limit = Math.max(1, maxItems)
  const kept = items.slice(0, limit)
  const folded = items.slice(limit)

  const outLines = kept.map(it => `- ${it.raw}`)
  if (folded.length > 0) {
    // 折叠行只留纯事实：多少项 + 链接，不做任何评价
    outLines.push(
      `- 另有 ${folded.length} 项改动，详见：${renderLinks(folded.flatMap(i => i.links))}`.trim()
    )
  }

  return outLines.join('\n').trim()
}

// `feature` 是当天的基线，绝大多数条目都是它——逐条打标等于没打标，反而把真正需要一眼看到的
// `perf` / `bugfix` 淹掉。这里在排序/折叠都完成之后，只去掉 `feature` 标记，
// 保留 `perf`、`bugfix` 与表示「次要改动」的 `other`。
// 只认行首那一串带反引号的标记（`perf` `feature` ...），避免误删正文里的 "feature" 一词。
const LEADING_TAG_RUN_RE = /^(?:`(?:feature|bugfix|other|perf)`[\s:：|]*)+/i

function dropFeatureLabels(block: string): string {
  return (block || '')
    .split('\n')
    .map(line => {
      const m = line.match(/^(\s*[-*]\s+)?(.*)$/)
      if (!m) return line
      const prefix = m[1] || ''
      const rest = (m[2] || '')
        .replace(LEADING_TAG_RUN_RE, run => run.replace(/`feature`[\s:：|]*/gi, ''))
        .trim()
      if (!rest) return line
      return `${prefix}${rest}`
    })
    .join('\n')
    .trim()
}

function computeArticleDateRange(articles: Article[]): string {
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = Number.NEGATIVE_INFINITY
  for (const a of articles) {
    const raw = a.patchData?.date || a.gitCommitData?.date || a.fetchedAt
    if (!raw) continue
    const ts = new Date(raw).getTime()
    if (Number.isNaN(ts)) continue
    if (ts < minTs) minTs = ts
    if (ts > maxTs) maxTs = ts
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return ''
  const fmt = (ts: number) =>
    new Date(ts)
          .toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
          .replace(/\//g, '-')
          .replace(/\s/g, '')
  return `${fmt(minTs)} ~ ${fmt(maxTs)}`
}

function lkmlAnchorFragmentId(articleId: string): string {
  return `lkml-${articleId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[AI] ${operationName} - 尝试 ${attempt}/${MAX_RETRIES}`)
      const startTime = Date.now()
      const result = await operation()
      const duration = Date.now() - startTime
      console.log(`[AI] ${operationName} - 成功 (耗时: ${duration}ms)`)
      return result
    } catch (error: any) {
      lastError = error
      console.error(`[AI] ${operationName} - 失败 (尝试 ${attempt}/${MAX_RETRIES}):`, error.message)
      
      if (error.status === 429) {
        console.log('[AI] 遇到限流，等待后重试...')
        await sleep(RETRY_DELAY * attempt * 2)
      } else if (error.status === 401) {
        console.error('[AI] API Key 无效，请检查配置')
        throw error
      } else if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY)
      }
    }
  }
  
  throw lastError
}

async function generateCategorySummary(
  articles: Article[],
  type: 'feature' | 'bugfix',
  customPrompt?: string
): Promise<string> {
  if (articles.length === 0) return ''
  
  const typeLabel = type === 'feature' ? 'Feature' : 'Bugfix'
  
  const articlesWithLinks = articles
    .slice(0, 30)
    .map(a => {
      const anchorId = `lkml-${a.id}`
      return `- [${a.title}](#${anchorId})`
    })
    .join('\n')

  const defaultPrompt = `你是 Linux 内核开发专家。请分析以下${typeLabel}类补丁并输出总结。

要求：
- 用 Markdown 列表输出关键信息
- 每个列表项以 1 个语义匹配的 emoji 开头
- 每条总结必须包含补丁链接，链接统一放在该行最后，格式如 [标题](#lkml-xxx)
- 至少 3 条总结

限制：用中文回复，不要输出思考过程，不要输出"今日社区动态"、"总体评价"等标题，不要逐条罗列补丁标题。`

  const prompt = customPrompt || defaultPrompt

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: `请分析以下${typeLabel}类补丁：\n\n${articlesWithLinks}`,
    },
  ]

  const result = await withRetry(async () => {
    return await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: config.openai.maxTokens,
      temperature: 0.7,
    })
  }, `生成${typeLabel}摘要`)

  const rawContent = result.choices[0]?.message?.content || ''
  let summary = cleanAIResponse(rawContent)
  
  summary = summary.replace(/^###\s*(今日社区动态|总体评价|本周合并动态|合并评价|Feature类补丁分析|总结|Bugfix类补丁分析)\s*$/gim, '')
  summary = summary.replace(/^###\s*总体评价[\s\S]*$/gim, '')
  summary = summary.replace(/^###\s*合并评价[\s\S]*$/gim, '')
  summary = summary.replace(/^\s*\n+/gm, '\n')
  summary = summary.trim()
  
  return summary
}

// 类型/perf 判定只看标题与 commit message 正文：传给模型的 content 里还拼着「修改的文件」
// 列表，而 LKML 页面上没有 diff 时它甚至可能是整段 patch。拿全文去匹配关键词会大量误标
// （例如 `\b(qps|pps|fps)\b` 命中了无关缩写，把一块 RGB LED 驱动标成 perf）。
function patchSignalText(title: string, content: string): string {
  const head = (content || '').split(/\n修改的文件[:：]/)[0]
  const idx = head.indexOf('Commit message:')
  return `${title}\n${idx >= 0 ? head.slice(idx + 'Commit message:'.length) : head}`.trim()
}

function detectPerfRelated(text: string): boolean {
  const lower = (text || '').toLowerCase()
  if (!lower) return false
  return (
    /\bperf(ormance)?\b/.test(lower) ||
    /\b(latency|throughput|qps|pps|fps)\b/.test(lower) ||
    /\b(optimi[sz]e|faster|speed( up)?|slow|overhead)\b/.test(lower) ||
    /\b(scales?|scalability|contention)\b/.test(lower) ||
    /\bbenchmark|micro-?optim(ization)?\b/.test(lower) ||
    /reduce\s+(cpu|cycles|overhead|latency)/.test(lower)
  )
}

function getArticleType(a: Article): 'feature' | 'bugfix' | 'other' {
  const t = (a.patchData?.type || a.gitCommitData?.type) as any
  if (t === 'feature' || t === 'bugfix' || t === 'other') return t
  return 'other'
}

function getArticleSubsystem(a: Article): string {
  const existing = (a.patchData?.subsystem || a.gitCommitData?.subsystem || '') as string
  return existing || ''
}

function buildSubsystemInputLines(articles: Article[]): string {
  const lines: string[] = []
  for (const a of articles) {
    const t = getArticleType(a)
    const title = a.patchData?.title || a.gitCommitData?.title || a.title
    const author = a.patchData?.author || a.gitCommitData?.author || a.author || ''
    const date = a.patchData?.date || a.gitCommitData?.date || a.fetchedAt || ''
    const files = a.patchData?.changedFiles || a.gitCommitData?.files || []
    const content = a.patchData?.content || a.gitCommitData?.content || a.content || ''
    const perf = detectPerfRelated(patchSignalText(title, content)) ? 'perf' : ''
    const url = a.patchData?.url || a.gitCommitData?.url || a.url || `#${lkmlAnchorFragmentId(a.id)}`
    const filesShort =
      files.length > 0 ? files.slice(0, 12).join(', ') + (files.length > 12 ? ', ...' : '') : ''

    lines.push(
      [
        `- id=${a.id}`,
        `type=${t}`,
        perf ? `tag=${perf}` : '',
        author ? `author=${author}` : '',
        date ? `date=${date}` : '',
        filesShort ? `files=${filesShort}` : '',
        `title=${title}`,
        `link=${url}`,
      ]
        .filter(Boolean)
        .join(' | ')
    )
  }
  return lines.join('\n')
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let nextIndex = 0

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex++
      if (idx >= items.length) break
      out[idx] = await mapper(items[idx], idx)
    }
  })

  await Promise.all(workers)
  return out
}

async function summarizeSubsystem(
  subsystem: string,
  subsystemArticles: Article[],
  prompt: string | undefined,
  maxItems?: number
): Promise<string> {
  const defaultPrompt =
    '你是 Linux 内核开发专家。现在只分析单个子系统下的补丁/提交动态。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 逐条输出该子系统的具体改动，每条单独一行；一个补丁/提交一条，不要合并成一条\n- 每条控制在 80 字以内，只说清「改了什么 + 带来什么影响或收益」\n- 每条必须包含：`feature`/`bugfix`/`other` 标记；若为性能优化/性能相关需额外标注 `perf`\n- 每条行末必须包含补丁/提交的原始链接，格式为 [↗](https://...)\n- 不要原样复述 title，也不要写固定句式的评价：禁止「该改动重要在于」「点评：」「值得关注」「整体风险低」「属于……的改进」\n- 除非确有兼容性、ABI 或安全风险需要提醒，不要额外加一句评价\n'

  const systemPrompt = (prompt || defaultPrompt).trim()

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `子系统：${subsystem}\n` +
        `补丁/提交条目如下（每行含 type/tag/link 等字段）：\n\n` +
        buildSubsystemInputLines(subsystemArticles),
    },
  ]

  const result = await withRetry(async () => {
    return await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: config.openai.maxTokens,
      temperature: 0.6,
    })
  }, `生成子系统摘要 - ${subsystem}`)

  const rawContent = result.choices[0]?.message?.content || ''
  const normalized = normalizeOneItemPerLine(
    normalizeSummaryTagLines(stripBoilerplate(cleanAIResponse(rawContent)))
  ).trim()
  const tagged = applySourceTags(normalized, subsystemArticles)
  const ordered = reorderAndCollapseSubsystemLines(tagged, maxItems)
  return dropFeatureLabels(ordered)
}

// Make subsystem names clickable to jump to corresponding detail blocks.
// Frontend cards use: id="subsystem-${encodeURIComponent(title)}"
function wrapSubsystemLinks(cleaned: string, subsystems: string[]): string[] {
  const toId = (name: string) => `#subsystem-${encodeURIComponent(name)}`

  const lines = cleaned.split('\n').map(l => l.trimEnd())
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue

    // only rewrite list items; keep others untouched
    const m = t.match(/^([-*]\s+)(.*)$/)
    if (!m) {
      out.push(t)
      continue
    }
    const prefix = m[1]
    let rest = m[2]

    // If already has a markdown link for a subsystem, don't double-wrap.
    if (/\[[^\]]+\]\(#subsystem-/.test(rest)) {
      out.push(`${prefix}${rest}`)
      continue
    }

    // 新格式：行末的 （<子系统>）；旧格式：行首的 <图标> <子系统>：
    // 两种都做链接化，保证自定义 overallPrompt 用旧格式时也不会退化。
    // 同一行可能两种都出现（模型偶尔两头都写），所以不提前 break。
    for (const s of subsystems) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const colonRe = new RegExp(`(^|\\s)(${esc})(\\s*：)`)
      const parenRe = new RegExp(`([（(])\\s*(${esc})\\s*([）)])`)
      let hit = false
      if (colonRe.test(rest)) {
        rest = rest.replace(colonRe, (_all, p1, p2, p3) => `${p1}[${p2}](${toId(s)})${p3}`)
        hit = true
      }
      if (parenRe.test(rest)) {
        rest = rest.replace(parenRe, (_all, p1, p2, p3) => `${p1}[${p2}](${toId(s)})${p3}`)
        hit = true
      }
      if (hit) break
    }

    out.push(`${prefix}${rest}`)
  }

  return out
}

// 拆分总览行，兼容两种格式：
//   旧：`- 🧠 [Memory](#subsystem-Memory)：正文`      -> { label: '🧠 Memory', body: '正文' }
//   新：`- ⚡ 正文（[Memory](#subsystem-Memory)）`      -> { label: 'Memory', body: '⚡ 正文' }
// 新格式只在括号内容确实是已知子系统时才当标签，避免把正文里的普通括号误判成子系统。
function splitOverviewLine(line: string, subsystems: string[] = []): { label: string; body: string } {
  const t = (line || '').trim().replace(/^[-*]\s+/, '')
  const plain = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '')

  const paren = plain.match(/^(.*?)[（(]\s*([^（）()]{1,40}?)\s*[）)]\s*$/)
  if (paren && subsystems.includes(paren[2])) {
    return { label: paren[2], body: paren[1].trim() }
  }

  const idx = plain.search(/[：:]/)
  if (idx < 0) return { label: '', body: plain.trim() }
  return { label: plain.slice(0, idx).trim(), body: plain.slice(idx + 1).trim() }
}

// 模型对当天只有清理/注释/配置/小修正的子系统，常写「以清理、配置更新和小修复为主，
// 无突出性能或特性变更，风险低」这类套话。这类行没体现任何具体动态，总览里直接不展示。
// 为保守起见，仅当正文命中套话、且不含英文标识符（如 io_uring、blk-mq、XFS）时才判空。
const EMPTY_DYNAMIC_PATTERNS: RegExp[] = [
  /无\s*(突出|重大|显著|明显|实质|值得一提)/,
  /未见\s*(显著|明显|重大|突出|实质)/,
  /未(发现|出现)\s*(显著|明显|重大|突出)/,
  /(以|多为|主要(是|为))\s*[^，。；]{0,12}(清理|注释|配置|小修正|小修复|维护)/,
  /无\s*(新特性|性能优化|功能变化|接口变化)/,
  /风险\s*(较)?低/,
  /代码卫生/,
]
const IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9_.&-]+/

function isEmptyDynamicLine(line: string, subsystems: string[] = []): boolean {
  const { body } = splitOverviewLine(line, subsystems)
  if (!body) return true
  if (IDENTIFIER_RE.test(body)) return false
  return EMPTY_DYNAMIC_PATTERNS.some(re => re.test(body))
}

// 兜底：模型多轮后仍未收敛时，硬性压到上限内。
// 优先按篇幅比例压缩每一行，尽量让所有子系统都保留；实在压不下去才从末尾整条删减。
function enforceOverviewBudget(lines: string[], maxChars: number): string[] {
  const items = lines.filter(l => l.trim())
  if (items.length === 0) return []
  if (countVisibleChars(items.join('\n')) <= maxChars) return items

  let factor = maxChars / countVisibleChars(items.join('\n'))
  for (let round = 0; round < 8; round++) {
    const shrunk = items.map(item => {
      const len = countVisibleChars(item)
      const quota = Math.max(12, Math.floor(len * factor))
      return len <= quota ? item : truncateVisible(item, quota)
    })
    const total = countVisibleChars(shrunk.join('\n'))
    if (total <= maxChars) return shrunk
    factor *= maxChars / total
  }

  const out = items.slice()
  while (out.length > 1 && countVisibleChars(out.join('\n')) > maxChars) out.pop()
  return out
}

async function summarizeOverall(
  subsystemSummaries: { subsystem: string; summary: string }[],
  prompt: string | undefined,
  maxChars: number = DEFAULT_SUMMARY_MAX_CHARS
): Promise<string> {
  const defaultPrompt =
    '你是 Linux 内核开发专家。你将收到多个子系统的条目式总结。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 输出 Markdown 无序列表，共 3~6 条，按重要性从高到低排序\n- 每条格式固定为：<图标> <一句话>（<子系统名>），子系统名必须与输入中的「## 子系统名」完全一致\n- 跨子系统挑当天全局最值得关注的动态，不要按子系统逐个铺开\n'

  // 硬约束：直接追加到 prompt 后面，保证自定义 prompt 也生效。
  const budgetRule =
    `\n\n【硬约束】\n` +
    '- 全文 3~6 条，按重要性从高到低排序；宁可少于 6 条，也不要为凑数硬写\n' +
    '- 每条一句话（不超过 70 字），只讲一个动态，不要把多个改动挤进同一条\n' +
    '- 每条行末用中文括号标注子系统名，例如（Memory）；这个名字会被渲染成跳转到详情的链接，必须准确\n' +
    '- 优先挑选：性能收益、新特性/新接口、安全修复、回归修复、有争议或有兼容性风险的改动\n' +
    '- 禁止空话：「以清理为主」「风险较低」「值得关注」「属于……的改进」等；\n' +
    '  某子系统当天没有实质动态就不要出现在总览里\n' +
    `- 全文不超过 ${maxChars} 字`

  const systemPrompt = `${(prompt || defaultPrompt).trim()}${budgetRule}`

  const merged = subsystemSummaries
    .filter(s => s.summary.trim())
    .map(s => `## ${s.subsystem}\n${s.summary.trim()}`)
    .join('\n\n')

  const subsystems = subsystemSummaries.map(s => s.subsystem).filter(Boolean)

  let lines: string[] = []
  let droppedLabels: string[] = []
  const MAX_ATTEMPTS = 2
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryRule =
      attempt === 1
        ? ''
        : `\n\n【重试】上一次输出为 ${countVisibleChars(lines.join('\n'))} 字，超出 ${maxChars} 字上限。` +
          '请大幅压缩：只保留最重要的 3 条，每条不超过 40 字，删掉所有细节与次要项。'

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}${retryRule}` },
      { role: 'user', content: merged || '（无子系统条目）' },
    ]

    const result = await withRetry(async () => {
      return await openai.chat.completions.create({
        model: config.openai.model,
        messages,
        max_tokens: config.openai.maxTokens,
        temperature: 0.6,
      })
    }, '生成整体点评')

    const rawContent = result.choices[0]?.message?.content || ''
    const cleaned = cleanAIResponse(rawContent).trim()

    // 丢掉「无实质动态」的占位行：这类子系统在总览里不体现（详情小节不受影响）。
    const kept: string[] = []
    droppedLabels = []
    for (const line of wrapSubsystemLinks(cleaned, subsystems)) {
      if (isEmptyDynamicLine(line, subsystems)) {
        droppedLabels.push(splitOverviewLine(line, subsystems).label || line.trim())
      } else {
        kept.push(line)
      }
    }
    lines = kept

    if (countVisibleChars(lines.join('\n')) <= maxChars) break
  }

  const budgeted = enforceOverviewBudget(lines, maxChars)
  if (droppedLabels.length > 0) {
    console.log(`[AI] 总览省略无实质动态的子系统: ${droppedLabels.join('、')}`)
  }
  console.log(`[AI] 总览字数: ${countVisibleChars(budgeted.join('\n'))}/${maxChars}`)

  return budgeted.join('\n').trim()
}

function summarizeUnmatchedScopeLocally(unmatched: Article[]): { total: number; topAreas: string[] } {
  const total = unmatched.length
  const counts = new Map<string, number>()

  const bump = (k: string) => counts.set(k, (counts.get(k) || 0) + 1)

  for (const a of unmatched) {
    const files = a.patchData?.changedFiles || a.gitCommitData?.files || []
    for (const f of files) {
      const p = (f || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
      if (!p) continue
      const segs = p.split('/').filter(Boolean)
      if (segs.length === 0) continue
      const area = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0]
      bump(area)
    }
  }

  const topAreas = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k)

  return { total, topAreas }
}

async function summarizeUnmatchedScopeAI(input: { total: number; topAreas: string[] }): Promise<string> {
  const systemPrompt =
    '你是 Linux 内核开发专家。请对“未匹配到固定子系统规则”的补丁做一个非常简短的概览。\n' +
    '要求：中文；不输出思考过程；不输出标题；输出 1~2 句即可，说明大概修改范围（用给定目录分布概括）以及数量。'

  const userText =
    `未匹配补丁数量：${input.total}\n` +
    `目录分布（top）：${input.topAreas.length ? input.topAreas.join('、') : '（无法从 changedFiles 推断）'}\n`

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ]

  const result = await withRetry(async () => {
    return await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      // 改为跟随 config.openai.maxTokens（原先硬编码 300，推理模型会把额度全花在
      // reasoning_content 上导致 content 返回空，Other 段静默缺失）
      max_tokens: config.openai.maxTokens,
      temperature: 0.4,
    })
  }, '生成未匹配子系统概览')

  return cleanAIResponse(result.choices[0]?.message?.content || '').trim()
}

export async function generateSummary(
  articles: Article[],
  promptOrOptions?:
    | string
    | {
        summaryPrompt?: string
        subsystemPrompt?: string
        overallPrompt?: string
        summaryMaxChars?: number
        subsystemMaxItems?: number
        subsystemSummaryConcurrency?: number
        fixedSubsystemRules?: Record<string, string[]>
      }
): Promise<string> {
  if (articles.length === 0) {
    return ''
  }

  if (!config.openai.apiKey) {
    console.log('[AI] generateSummary - API Key 未配置，使用默认摘要')
    return `今日共收集到 ${articles.length} 条记录。`
  }

  const options =
    typeof promptOrOptions === 'string'
      ? { summaryPrompt: promptOrOptions }
      : (promptOrOptions || {})

  const dateRange = computeArticleDateRange(articles)
  const model = config.openai.model?.trim() || 'unknown'

  const bySubsystem = new Map<string, Article[]>()
  const unmatched: Article[] = []
  for (const a of articles) {
    const title = a.patchData?.title || a.gitCommitData?.title || a.title
    const files = a.patchData?.changedFiles || a.gitCommitData?.files || []

    // 1) 固定子系统（按配置目录规则归类）
    const fixed = inferFixedSubsystemFromFiles(files, options.fixedSubsystemRules)
    // 2) 兼容：如果没有配置固定规则，则退回动态推断
    const s = options.fixedSubsystemRules ? fixed : (getArticleSubsystem(a) || inferKernelSubsystem({ title, files }) || 'other')
    if (options.fixedSubsystemRules && !s) {
      unmatched.push(a)
      continue
    }
    if (!bySubsystem.has(s)) bySubsystem.set(s, [])
    bySubsystem.get(s)!.push(a)
  }

  const subsystemEntries = Array.from(bySubsystem.entries())
    .map(([subsystem, list]) => ({ subsystem, list }))
    .sort((a, b) => b.list.length - a.list.length)

  const fixedOrder = options.fixedSubsystemRules ? Object.keys(options.fixedSubsystemRules) : []
  const orderedFixedSubsystems =
    fixedOrder.length > 0
      ? fixedOrder
          .map(name => ({ subsystem: name, list: bySubsystem.get(name) || [] }))
          .filter(e => e.list.length > 0)
      : []

  const maxSubsystems = 24
  const minItemsPerSubsystem = 2
  const primarySubsystems =
    orderedFixedSubsystems.length > 0
      ? orderedFixedSubsystems
      : subsystemEntries.filter(e => e.list.length >= minItemsPerSubsystem).slice(0, maxSubsystems)
  const secondarySubsystems =
    orderedFixedSubsystems.length > 0
      ? []
      : subsystemEntries.filter(e => !primarySubsystems.some(p => p.subsystem === e.subsystem))

  const concurrency = Math.max(1, options.subsystemSummaryConcurrency || 6)
  console.log(
    `[AI] 子系统数: ${subsystemEntries.length}，参与AI总结子系统: ${primarySubsystems.length}，子系统总结并发: ${concurrency}`
  )

  const subsystemSummaries = await mapWithConcurrency(primarySubsystems, concurrency, async (entry) => {
    const summary = await summarizeSubsystem(
      entry.subsystem,
      entry.list,
      options.subsystemPrompt || options.summaryPrompt,
      options.subsystemMaxItems
    )
    return { subsystem: entry.subsystem, summary, articleCount: entry.list.length }
  })

  const overall = await summarizeOverall(
    subsystemSummaries,
    options.overallPrompt,
    options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS
  )

  const parts: string[] = []
  parts.push(`# 今日社区动态（${model} | ${dateRange || '未知'}）`)
  parts.push('')
  parts.push(overall || `今日共收集到 ${articles.length} 条记录。`)

  // 详情区按当天活跃度（条目数）排序，而不是固定的 config 顺序：
  // 当天最热闹的子系统排在最前面，读者不用先翻过一片安静的板块。
  const orderedSummaries = [...subsystemSummaries].sort((a, b) => b.articleCount - a.articleCount)

  for (const s of orderedSummaries) {
    const body = s.summary.trim()
    if (!body) continue
    parts.push('')
    parts.push(`## ${s.subsystem}`)
    parts.push(body)
  }

  if (secondarySubsystems.length > 0) {
    const total = secondarySubsystems.reduce((sum, e) => sum + e.list.length, 0)
    const totals = { feature: 0, bugfix: 0, other: 0, perf: 0 }
    for (const e of secondarySubsystems) {
      for (const a of e.list) {
        const t = getArticleType(a)
        totals[t]++
        const title = a.patchData?.title || a.gitCommitData?.title || a.title
        const content = a.patchData?.content || a.gitCommitData?.content || a.content || ''
        if (detectPerfRelated(patchSignalText(title, content))) totals.perf++
      }
    }

    const topNames = secondarySubsystems
      .slice(0, 6)
      .map(e => e.subsystem)
      .join('、')

    parts.push('')
    parts.push('## 其他子系统（聚合）')
    parts.push(
      `其余 ${secondarySubsystems.length} 个子系统共 ${total} 条改动，整体以 \`bugfix\` 与 \`other\` 为主，包含少量 \`feature\` 与 \`perf\` 相关更新。`
    )
    parts.push(
      `标签统计：\`feature\` ${totals.feature} / \`bugfix\` ${totals.bugfix} / \`other\` ${totals.other} / \`perf\` ${totals.perf}。`
    )
    if (topNames) {
      parts.push(`主要分布在：${topNames} 等子系统。`)
    }
  }

  if (unmatched.length > 0) {
    const totals = { feature: 0, bugfix: 0, other: 0, perf: 0 }
    for (const a of unmatched) {
      const t = getArticleType(a)
      totals[t]++
      const title = a.patchData?.title || a.gitCommitData?.title || a.title
      const content = a.patchData?.content || a.gitCommitData?.content || a.content || ''
      if (detectPerfRelated(patchSignalText(title, content))) totals.perf++
    }

    parts.push('')
    parts.push('## Other')
    const localScope = summarizeUnmatchedScopeLocally(unmatched)
    let aiScope = ''
    try {
      aiScope = await summarizeUnmatchedScopeAI(localScope)
    } catch {
      aiScope = ''
    }
    if (aiScope) parts.push(aiScope)
    parts.push(
      `Unmatched by fixed subsystem rules: ${unmatched.length} items. Consider extending directory rules to improve classification.`
    )
    parts.push(
      `标签统计：\`feature\` ${totals.feature} / \`bugfix\` ${totals.bugfix} / \`other\` ${totals.other} / \`perf\` ${totals.perf}。`
    )
  }

  return parts.join('\n').trim()
}

// 标题形如 "wifi: iwlwifi: mvm: fix a deadlock"：先剥掉 [PATCH v2 3/5] 这类标签，再剥掉
// 任意层数的 "子系统:" 前缀，剩下的才是真正的动作描述。原先只剥一层前缀，多段前缀的补丁
// （wifi: iwlwifi: mvm: fix ...）判不出 bugfix，只能落到正文启发式，于是被误标成 feature。
function stripSubjectPrefixes(title: string): string {
  const t = (title || '').replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').trim()
  return t.replace(/^(?:[A-Za-z0-9_.+\/&-]+\s*:\s*)+/, '').trim()
}

// 正文只取首段：后面的 changelog、Signed-off-by、评审讨论里满是 add/support/enable，
// 拿它们判 feature 会把大量修复误标成新特性。
function firstParagraph(text: string): string {
  const t = (text || '').replace(/\r/g, '').trim()
  if (!t) return ''
  const idx = t.search(/\n\s*\n/)
  return (idx >= 0 ? t.slice(0, idx) : t).slice(0, 800)
}

export function inferPatchTypeRuleBased(title: string, body: string): 'feature' | 'bugfix' | 'other' {
  const subject = stripSubjectPrefixes(title)
  const lead = firstParagraph(body)
  const leadLower = lead.toLowerCase()

  const bugfixInSubject = /\b(fix|fixes|fixup|revert)\b/i.test(subject)
  // 正文里的 "fix" 出现得太泛（changelog、评审答复、后续补丁说明都会带），
  // 用它判 bugfix 会把大量新特性/整理误标，所以正文只认高置信的缺陷信号。
  const bugfixInText =
    /\b(fixes:|fixes\s+[0-9a-f]{7,})/.test(leadLower) ||
    /\b(data\s+race|race\s+condition|kcsan)\b/.test(leadLower) ||
    /\b(leak|memory\s+leak|refcount)\b/.test(leadLower) ||
    /\b(crash|oops|panic|null\s*deref|null\s*pointer|use[-\s]after[-\s]free|\buaf\b)\b/.test(leadLower) ||
    /\b(overflow|underflow|deadlock|hang)\b/.test(leadLower) ||
    /\b(syzbot|regression)\b/.test(leadLower)

  const featureInSubject =
    // 剥掉前缀后只需看动作词开头，兼容：
    // 1) "[PATCH] subsys: Add ..."（带 "subsys:" 前缀）
    // 2) "[PATCH 0/N] Add support for ..."（不带前缀，尤其 cover letter 常见）
    // 3) "wifi: iwlwifi: mvm: add ..."（多段前缀）
    /^(add|adds|implement|introduce|support|enable)\b/i.test(subject) ||
    /^\s*\[patch[^\]]*\]\s*(add|adds|implement|introduce|support|enable)\b/i.test(title)
  const featureInText =
    // 常见 feature 表述（只扫正文首段）
    /\b(add(s|ed|ing)?|introduce(s|d)?|implement(s|ed|ing)?|enable(s|d)?|support(s|ed|ing)?)\b/.test(leadLower) ||
    /\b(add(s|ing)?\s+support(\s+for)?|support\s+for)\b/.test(leadLower) ||
    /\b(expose(s|d)?|export(s|ed|ing)?|provide(s|d)?|allow(s|ed|ing)?|permit(s|ted|ting)?)\b/.test(leadLower) ||
    /\b(extend(s|ed|ing)?|expand(s|ed|ing)?|generaliz(e|es|ed|ing))\b/.test(leadLower) ||
    /\b(plumb(s|ed|ing)?|wire(s|d)?\s+up|hook(s|ed|ing)?\s+up)\b/.test(leadLower) ||
    /\b(new|initial)\s+(api|abi|interface|feature|support|infrastructure|framework|mechanism)\b/.test(leadLower)

  // 按约定的优先级：
  // 1) 动作词在标题里最可信，先判 feature 再判 bugfix
  //    （避免标题是 "Add support ..."、正文 changelog 里提到 "Fix ..." 被倒挂）
  // 2) 标题判不出时才看正文首段：先判 bugfix 再判 feature
  //    —— 正文里 "add" 的出现频率远高于 "fix"，先判 feature 会大量吞掉修复
  // 3) 都不命中才是 other
  if (featureInSubject) return 'feature'
  if (bugfixInSubject) return 'bugfix'
  if (bugfixInText) return 'bugfix'
  if (featureInText) return 'feature'
  return 'other'
}
