import * as cheerio from 'cheerio'
import puppeteer, { type Browser } from 'puppeteer-core'

// lore.kernel.org 前置了 Anubis（对浏览器 UA 下发 JS PoW 挑战），因此仍然要用
// puppeteer 走一遍挑战；挑战通过后浏览器会拿到 cookie，后续分页直接复用同一个浏览器实例。
// 与 lkml.org 不同：lore 不提供按天浏览的 HTML 页面，改用搜索 + Atom 输出：
//   https://lore.kernel.org/lkml/?q=d:YYYYMMDD..YYYYMMDD&x=A&o=<offset>
// Atom 每个 entry 自带完整消息正文（含 diff），所以不需要再逐条抓补丁详情页。

const LORE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

// lore 的搜索结果是按分页返回的，Atom 单页固定最多 200 条（见 o= 偏移）
export const LORE_PAGE_SIZE = 200

const CHROME_PATHS_WIN = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
]

const CHROME_PATHS_MAC = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const CHROME_PATHS_LINUX = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
]

function findChromePath(): string | null {
  const paths =
    process.platform === 'win32'
      ? CHROME_PATHS_WIN
      : process.platform === 'darwin'
        ? CHROME_PATHS_MAC
        : CHROME_PATHS_LINUX
  const fs = require('fs')
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p
  }
  return null
}

export async function launchLoreBrowser(options: { headless?: boolean } = {}): Promise<Browser | null> {
  const chromePath = findChromePath()
  if (!chromePath) {
    console.error('[Lore] 未找到 Chrome/Edge 浏览器，请设置 CHROME_PATH 环境变量')
    return null
  }
  console.log(`[Lore] 使用浏览器: ${chromePath}`)
  try {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: options.headless ?? false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      defaultViewport: null,
    })
    console.log('[Lore] 浏览器已启动')
    return browser
  } catch (err) {
    console.error('[Lore] 启动浏览器失败:', err)
    return null
  }
}

function formatLoreDate(day: Date): string {
  const y = day.getFullYear()
  const m = String(day.getMonth() + 1).padStart(2, '0')
  const d = String(day.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export function buildLoreSearchUrl(
  baseUrl: string,
  since: Date,
  until: Date,
  offset = 0
): string {
  const params = new URLSearchParams({
    q: `d:${formatLoreDate(since)}..${formatLoreDate(until)}`,
    x: 'A',
  })
  if (offset > 0) params.set('o', String(offset))
  return new URL(`?${params.toString()}`, baseUrl).href
}

export interface LoreMessage {
  url: string
  title: string
  author: string
  authorEmail: string
  date: string
  body: string
  // 是否为回复（Atom entry 带 thr:in-reply-to）。补丁系列里 1/N、2/N 都是回复。
  isReply: boolean
}

export function parseLoreAtom(xml: string): LoreMessage[] {
  const $ = cheerio.load(xml, { xmlMode: true })
  const messages: LoreMessage[] = []

  for (const element of $('entry').toArray()) {
    const $entry = $(element)
    const title = $entry.find('title').first().text().trim()
    const url = ($entry.find('link').attr('href') || '').trim()
    if (!title || !url) continue

    const author = $entry.find('author name').text().trim()
    const authorEmail = $entry.find('author email').text().trim()
    const updatedText = $entry.find('updated').first().text().trim()
    const updatedTs = Date.parse(updatedText)
    const date = Number.isNaN(updatedTs) ? new Date().toISOString() : new Date(updatedTs).toISOString()

    // Atom 里正文是 XHTML（<pre> 包着消息原文），cheerio 的 .text() 会还原成纯文本，
    // diff 行、--- 分隔行都在，可直接交给 parseLkmlPatchText。
    const body = $entry.find('content').text().replace(/\r/g, '').trim()

    // cheerio 的 XML 模式无法直接用带命名空间的 thr:in-reply-to 选择器，用序列化文本判断
    const isReply = /<thr:in-reply-to\b/.test($.xml(element))

    messages.push({ url, title, author, authorEmail, date, body, isReply })
  }

  return messages
}

// Anubis 挑战通过后浏览器渲染 Atom 文档，body.innerText 就是原始 XML 文本。
async function fetchLoreFeedXml(browser: Browser, url: string, timeoutMs: number): Promise<string> {
  const page = await browser.newPage()
  try {
    await page.setUserAgent(LORE_USER_AGENT)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' })
    await page.evaluateOnNewDocument(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`)

    console.log(`[Lore] 浏览器访问: ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    const deadline = Date.now() + Math.max(timeoutMs, 90000)
    while (Date.now() < deadline) {
      let text = ''
      try {
        // tsconfig 没有 DOM lib，这里用字符串表达式取 body 文本
        text = (await page.evaluate('(document.body && document.body.innerText) || ""')) as string
      } catch {
        // Anubis 挑战完成后页面会重载，此时的执行上下文可能已失效，下一轮重试
      }
      // 必须等整份文档渲染完（</feed>）；只看到 <feed 时 Chrome 可能还在渐进渲染，
      // 提前返回会截断成 Feed 开头的一小段 entry。
      if (text.includes('</feed>')) return text
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error(`Lore Atom 加载超时（可能 Anubis 挑战未通过）: ${url}`)
  } finally {
    await page.close()
  }
}

async function fetchLoreFeedXmlWithRetry(
  browser: Browser,
  url: string,
  timeoutMs: number,
  attempts = 2
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchLoreFeedXml(browser, url, timeoutMs)
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`[Lore] 第 ${attempt} 次抓取失败，3 秒后重试: ${url}`)
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

export interface FetchLoreMessagesOptions {
  since: Date
  until: Date
  timeoutMs?: number
  maxPages?: number
}

// 按日期范围拉取 lore 上所有消息，自动翻页并按消息 URL 去重。
// 注意：搜索期间若持续有新邮件到达，分页偏移可能造成少量重复/边界遗漏，去重保证不重复。
export async function fetchLoreMessages(
  browser: Browser,
  baseUrl: string,
  options: FetchLoreMessagesOptions
): Promise<LoreMessage[]> {
  const timeoutMs = options.timeoutMs ?? 60000
  const maxPages = options.maxPages ?? 50
  const messages: LoreMessage[] = []
  const seenUrls = new Set<string>()

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const url = buildLoreSearchUrl(baseUrl, options.since, options.until, pageIndex * LORE_PAGE_SIZE)
    let xml: string
    try {
      xml = await fetchLoreFeedXmlWithRetry(browser, url, timeoutMs)
    } catch (error) {
      // 第一页失败视为整体失败；翻页中途失败则保留已抓到的消息
      if (pageIndex === 0) throw error
      console.error(`[Lore] 第 ${pageIndex + 1} 页抓取失败，保留已抓取的 ${messages.length} 条:`, error)
      return messages
    }
    const pageMessages = parseLoreAtom(xml)

    let added = 0
    for (const message of pageMessages) {
      if (seenUrls.has(message.url)) continue
      seenUrls.add(message.url)
      messages.push(message)
      added++
    }

    console.log(
      `[Lore] 第 ${pageIndex + 1} 页: 解析 ${pageMessages.length} 条，新增 ${added} 条`
    )

    if (pageMessages.length < LORE_PAGE_SIZE) return messages
    if (added === 0) return messages
  }

  console.warn(`[Lore] 已达到分页上限 ${maxPages} 页，可能漏抓更早的消息`)
  return messages
}

// 与旧 lkml.org 抓取保持一致的筛选口径：只取线程首封（跳过回复、排除作者），
// 标题需包含补丁类关键词。补丁系列里 1/N、2/N 都是对 0/N 的回复，因此每个线程
// 只保留首封，避免同一系列被拆成十几条、把每日条目数放大好几倍。
export function isLkmlPatchMessage(message: LoreMessage, excludeAuthors: string[] = []): boolean {
  if (message.isReply) return false
  if (/^\s*(re|aw|fwd?):/i.test(message.title)) return false
  if (excludeAuthors.some(ex => message.author.toLowerCase().includes(ex.toLowerCase()))) return false
  const lower = message.title.toLowerCase()
  return ['patch', 'diff', 'git pull', 'rfc'].some(keyword => lower.includes(keyword))
}

export function parseLkmlPatchText(rawText: string): { commitMessage: string; changedFiles: string[] } {
  const normalized = (rawText || '').replace(/\r/g, '').trim()
  if (!normalized) return { commitMessage: '', changedFiles: [] }

  const lines = normalized.split('\n').map(line => line.trimEnd())
  const dividerIndex = lines.findIndex(line => line.trim() === '---')
  const messageLines = dividerIndex >= 0 ? lines.slice(0, dividerIndex) : lines

  let commitMessage = messageLines.filter(line => line.trim().length > 0).join('\n').trim()
  if (!commitMessage || commitMessage.length < 10) {
    const cutByDiff = normalized.split(/\bdiff --git\b/i)[0]
    commitMessage = cutByDiff.split(/\n---\s|\s---\s/)[0].trim()
  }

  const changedFiles = new Set<string>()
  for (const line of lines) {
    // diffstat 行形如: "mm/vmscan.c            | 456 +++++"
    // 或 " drivers/net/ppp/pppoe.c | 166 ++++"（有时被拼进同一行），按行内 token 抽取
    const diffStatRe = /(^|\s)(\S+?)\s+\|\s+\d+\b/g
    let m: RegExpExecArray | null
    while ((m = diffStatRe.exec(line)) !== null) {
      const candidate = m[2].trim()
      if (!candidate) continue
      if (candidate.length > 200) continue
      if (!/[\/.]/.test(candidate)) continue
      if (candidate.includes('://')) continue
      if (/^(hi|this|patch|from|signed-off-by)$/i.test(candidate)) continue
      changedFiles.add(candidate)
    }

    // "diff --git a/foo b/foo" 后面可能紧跟 "index ..."（同一行）
    const diffGitMatch = line.match(/\bdiff --git a\/(\S+)\s+b\/(\S+)/)
    if (diffGitMatch) changedFiles.add(diffGitMatch[2].trim())

    // 兜底：从 --- a/ 与 +++ b/ 提取（有些补丁没有 diff --git）
    const minusFile = line.match(/---\s+a\/(\S+)/)
    if (minusFile) changedFiles.add(minusFile[1].trim())
    const plusFile = line.match(/\+\+\+\s+b\/(\S+)/)
    if (plusFile) changedFiles.add(plusFile[1].trim())
  }

  return { commitMessage, changedFiles: Array.from(changedFiles) }
}
