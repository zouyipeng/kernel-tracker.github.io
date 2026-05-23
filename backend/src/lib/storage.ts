import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'public')
const SOURCES_CONFIG_PATH = path.join(__dirname, '..', '..', 'sources-config.json')

export interface GitConfig {
  branch: string
  sinceDays: number
  maxCommits: number
  localPath?: string
  timeoutMs?: number // 仓库抓取超时（毫秒），默认 120000
}

export interface Source {
  name: string
  type: string
  url: string
  active: boolean
  excludeAuthors?: string[]
  lkmlDetailConcurrency?: number
  lkmlDetailTimeoutMs?: number
  gitConfig?: GitConfig
}

export interface SourcesConfig {
  // 全局固定子系统目录归类规则（用于把补丁归类到预定义子系统集合）
  // key 为子系统名（如: 内存/调度/网络/安全/维测/文件系统/arm64/x86），patterns 为目录前缀或简单 glob
  fixedSubsystemRules?: Record<string, string[]>
  // 全局 prompt（每个子系统独立上下文）
  subsystemPrompt?: string
  // 全局 prompt（聚合各子系统后整体点评，独立上下文）
  overallPrompt?: string
  // 全局并发上限（避免一次性几十个子系统触发限流）
  subsystemSummaryConcurrency?: number
  sources: Source[]
}

export interface Article {
  id: string
  sourceName: string
  title: string
  content?: string
  url?: string
  author?: string
  fetchedAt: string
  patchData?: LKMLPatch
  gitCommitData?: GitCommit
}

export interface SourceDayData {
  date: string
  sourceName: string
  sourceType: string
  generatedAt: string
  summary: string
  articles?: Article[]
  stats?: {
    total: number
    feature: number
    bugfix: number
    other: number
    additions?: number
    deletions?: number
  }
}

export interface SourceDatesIndex {
  [sourceName: string]: {
    dates: string[]
    lastUpdated: string
  }
}

export type PatchType = 'feature' | 'bugfix' | 'other'

// 子系统名允许动态抽取（如 drm/msm、netfilter、arch/riscv 等）
export type KernelSubsystem = string

export interface LKMLMessage {
  id: string
  url: string
  title: string
  author: string
  date: string
  content: string
  isReply: boolean
}

export interface LKMLPatch {
  id: string
  title: string
  url: string
  author: string
  date: string
  content: string
  subsystem: KernelSubsystem
  type: PatchType
  highlight: boolean
  summary: string
  changedFiles?: string[]
  messages: LKMLMessage[]
  replyCount: number
}

export interface GitCommit {
  hash: string
  shortHash: string
  title: string
  author: string
  authorEmail: string
  date: string
  content: string
  files: string[]
  additions: number
  deletions: number
  subsystem: KernelSubsystem
  type: PatchType
  url: string
}

function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

export function loadSourcesConfig(): SourcesConfig {
  try {
    if (!fs.existsSync(SOURCES_CONFIG_PATH)) {
      console.error('[Storage] 信息源配置文件不存在:', SOURCES_CONFIG_PATH)
      return { sources: [] }
    }
    const content = fs.readFileSync(SOURCES_CONFIG_PATH, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    console.error('[Storage] 加载信息源配置失败:', error)
    return { sources: [] }
  }
}

function sourceNameToFileName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}

export function loadSourceData(sourceName: string, dateStr: string): SourceDayData | null {
  try {
    const fileName = `${sourceNameToFileName(sourceName)}-${dateStr}.json`
    const filePath = path.join(DATA_DIR, fileName)
    if (!fs.existsSync(filePath)) {
      return null
    }
    const content = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    console.error('[Storage] 加载数据源数据失败:', error)
    return null
  }
}

export function saveSourceData(data: SourceDayData): void {
  ensureDirectoryExists(DATA_DIR)
  const sourceFileName = sourceNameToFileName(data.sourceName)

  const stats = data.stats || (() => {
    let feature = 0
    let bugfix = 0
    let other = 0
    let additions = 0
    let deletions = 0
    for (const article of data.articles || []) {
      const t = article.patchData?.type || article.gitCommitData?.type
      if (t === 'feature') feature++
      else if (t === 'bugfix') bugfix++
      else other++
      additions += article.gitCommitData?.additions || 0
      deletions += article.gitCommitData?.deletions || 0
    }
    return {
      total: (data.articles || []).length,
      feature,
      bugfix,
      other,
      additions: data.sourceType === 'git' ? additions : undefined,
      deletions: data.sourceType === 'git' ? deletions : undefined,
    }
  })()

  const compactData: SourceDayData = {
    date: data.date,
    sourceName: data.sourceName,
    sourceType: data.sourceType,
    generatedAt: data.generatedAt,
    summary: data.summary,
    stats,
  }

  const fileName = `${sourceFileName}-${data.date}.json`
  const filePath = path.join(DATA_DIR, fileName)
  fs.writeFileSync(filePath, JSON.stringify(compactData, null, 2), 'utf8')
  console.log(`[Storage] 精简数据已保存: ${filePath}`)

  updateSourceDatesIndex(data.sourceName, data.date)
}

export function updateSourceDatesIndex(sourceName: string, dateStr: string): void {
  ensureDirectoryExists(DATA_DIR)
  
  const indexPath = path.join(DATA_DIR, 'source-dates.json')
  let index: SourceDatesIndex = {}
  
  if (fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8')
      index = JSON.parse(content)
    } catch {
      index = {}
    }
  }
  
  const key = sourceNameToFileName(sourceName)
  if (!index[key]) {
    index[key] = { dates: [], lastUpdated: '' }
  }
  
  if (!index[key].dates.includes(dateStr)) {
    index[key].dates.push(dateStr)
    index[key].dates.sort().reverse()
  }
  
  index[key].lastUpdated = new Date().toISOString()
  
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log(`[Storage] 数据源日期索引已更新: ${sourceName} - ${index[key].dates.length} 个日期`)
}

export function loadSourceDatesIndex(): SourceDatesIndex {
  try {
    const filePath = path.join(DATA_DIR, 'source-dates.json')
    if (!fs.existsSync(filePath)) {
      return {}
    }
    const content = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    console.error('[Storage] 加载数据源日期索引失败:', error)
    return {}
  }
}

export function getTodayString(): string {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function generateArticleId(): string {
  return `art_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}
