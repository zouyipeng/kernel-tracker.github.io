'use client'

import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { dayDataApi, type SourceDayData, type Article } from '@/lib/api'
import PenguinIcon from '@/components/PenguinIcon'
import ReactMarkdown from 'react-markdown'

const TYPE_ORDER: Record<string, number> = { feature: 0, bugfix: 1, other: 2 }
const TYPE_LABEL: Record<string, string> = {
  feature: 'Feature',
  bugfix: 'Bugfix',
  other: 'Other',
}
const TYPE_COLOR: Record<string, string> = {
  feature: 'text-emerald-600',
  bugfix: 'text-rose-600',
  other: 'text-slate-500',
}

function sortArticles(articles: Article[], isGit: boolean) {
  return [...articles].sort((a, b) => {
    const ta = TYPE_ORDER[a.patchData?.type ?? a.gitCommitData?.type ?? 'other'] ?? 3
    const tb = TYPE_ORDER[b.patchData?.type ?? b.gitCommitData?.type ?? 'other'] ?? 3
    if (ta !== tb) return ta - tb
    if (isGit) {
      return new Date(b.gitCommitData?.date || 0).getTime() - new Date(a.gitCommitData?.date || 0).getTime()
    }
    return new Date(b.patchData?.date || b.fetchedAt).getTime() - new Date(a.patchData?.date || a.fetchedAt).getTime()
  })
}

function sourceNameToFileName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}

// 子系统小节的徽章统计：条目数 + 需要一眼看到的 `perf` / `bugfix` 数量。
// 「另有 N 项次要改动」是折叠行，不算条目。
function summarizeBlock(markdown: string) {
  let total = 0
  let perf = 0
  let bugfix = 0
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('- ')) continue
    if (line.includes('另有 ') && line.includes('项次要改动')) continue
    total++
    if (line.includes('`perf`')) perf++
    if (line.includes('`bugfix`')) bugfix++
  }
  return { total, perf, bugfix }
}

interface SourceDashboardProps {
  sourceName: string
  initialDate?: string
}

export default function SourceDashboard({ sourceName, initialDate }: SourceDashboardProps) {
  const [sourceData, setSourceData] = useState<SourceDayData | null>(null)
  const [loading, setLoading] = useState(true)
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState<string>(initialDate || '')
  // 子系统详情默认收起，只留一行徽章；点击标题或从总览跳转时展开。
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({})

  const toggleBlock = (title: string) =>
    setExpandedBlocks(prev => ({ ...prev, [title]: !prev[title] }))

  const jumpToAnchor = (id: string) => {
    const scroll = () =>
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

    if (!id.startsWith('subsystem-')) {
      scroll()
      return
    }
    // 从总览点子系统名时先把目标卡片展开，再滚动，否则跳过去看到的还是收起的一行
    const title = decodeURIComponent(id.slice('subsystem-'.length))
    setExpandedBlocks(prev => ({ ...prev, [title]: true }))
    requestAnimationFrame(scroll)
  }

  const isGit = sourceData?.sourceType === 'git'

  useEffect(() => {
    loadInitialData()
  }, [sourceName])

  useEffect(() => {
    if (selectedDate) {
      loadData(selectedDate)
    }
  }, [selectedDate, sourceName])

  const loadInitialData = async () => {
    try {
      const index = await dayDataApi.getSourceDatesIndex()
      const key = sourceNameToFileName(sourceName)
      const dates = index[key]?.dates || []
      setAvailableDates(dates)

      if (initialDate && dates.includes(initialDate)) {
        setSelectedDate(initialDate)
      } else if (dates.length > 0) {
        setSelectedDate(dates[0])
      } else {
        // No available data for this source: stop spinner and show empty state.
        setSourceData(null)
        setLoading(false)
      }
    } catch (error) {
      console.error('加载初始数据失败:', error)
      setAvailableDates([])
      setSourceData(null)
      setLoading(false)
    }
  }

  const loadData = async (dateStr: string) => {
    setLoading(true)
    try {
      const data = await dayDataApi.getSourceData(sourceName, dateStr)
      setSourceData(data)
    } catch (error) {
      console.error('加载数据失败:', error)
      setSourceData(null)
    } finally {
      setLoading(false)
    }
  }

  const articles = useMemo(() => {
    if (!sourceData?.articles) return []
    return sortArticles(sourceData.articles, isGit)
  }, [sourceData, isGit])

  const typeStatsFromArticles = useMemo(() => {
    const stats: Record<string, number> = { feature: 0, bugfix: 0, other: 0 }
    for (const a of articles) {
      const t = a.patchData?.type || a.gitCommitData?.type
      if (t === 'feature' || t === 'bugfix') stats[t]++
      else stats.other++
    }
    return stats
  }, [articles])

  const count = sourceData?.stats?.total ?? articles.length
  const typeStats = {
    feature: sourceData?.stats?.feature ?? typeStatsFromArticles.feature,
    bugfix: sourceData?.stats?.bugfix ?? typeStatsFromArticles.bugfix,
    other: sourceData?.stats?.other ?? typeStatsFromArticles.other,
  }
  const additions = sourceData?.stats?.additions ?? articles.reduce((sum, a) => sum + (a.gitCommitData?.additions || 0), 0)
  const deletions = sourceData?.stats?.deletions ?? articles.reduce((sum, a) => sum + (a.gitCommitData?.deletions || 0), 0)
  const displayName = sourceData?.sourceName || sourceName
  const summary = sourceData?.summary || ''
  const summaryBlocks = useMemo(() => {
    if (!summary.trim()) return []
    const lines = summary.split('\n')
    const blocks: { title: string; markdown: string; isOverview?: boolean }[] = []
    let currentTitle = '总体'
    let currentLines: string[] = []
    let seenFirstH2 = false

    const pushCurrent = () => {
      const md = currentLines.join('\n').trim()
      if (!md) return
      blocks.push({ title: currentTitle, markdown: md, isOverview: !seenFirstH2 && currentTitle === '总体' })
    }

    for (const line of lines) {
      const h2 = line.match(/^##\s+(.+)\s*$/)
      if (h2) {
        pushCurrent()
        currentTitle = h2[1].trim()
        currentLines = [line]
        seenFirstH2 = true
      } else {
        currentLines.push(line)
      }
    }
    pushCurrent()
    return blocks
  }, [summary])

  const subsystemCardId = (title: string) => `subsystem-${encodeURIComponent(title)}`
  const subsystemTitles = useMemo(() => {
    return new Set(summaryBlocks.map(b => b.title).filter(t => t && t !== '总体'))
  }, [summaryBlocks])

  const formatDateDisplay = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-')
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    if (dateStr === todayStr) {
      return `今天 (${month}月${day}日 ${weekdays[date.getDay()]})`
    }
    return `${month}月${day}日 ${weekdays[date.getDay()]}`
  }

  const categorySummaryComponents = {
    h1: ({ children }: { children?: ReactNode }) => (
      <h1 className="text-base font-bold text-sky-700 mt-0 mb-3 border-l-4 border-sky-500 pl-3">{children}</h1>
    ),
    h2: ({ children }: { children?: ReactNode }) => (
      <h2 className="text-sm font-semibold text-sky-600 mt-4 mb-2 first:mt-0 border-l-4 border-sky-400 pl-2.5">{children}</h2>
    ),
    h3: ({ children }: { children?: ReactNode }) => {
      const text =
        typeof children === 'string'
          ? children.trim()
          : Array.isArray(children)
            ? children.map(c => (typeof c === 'string' ? c : '')).join('').trim()
            : ''

      const isSubsystemHeading = !!text && subsystemTitles.has(text)

      if (!isSubsystemHeading) {
        return (
          <h3 className="text-sm font-bold text-sky-700 mt-3 mb-1.5 first:mt-0 border-l-2 border-sky-500/70 pl-2.5 [&_strong]:text-sky-800 [&_strong]:font-bold">
            {children}
          </h3>
        )
      }

      return (
        <h3 className="text-sm font-bold text-sky-700 mt-3 mb-1.5 first:mt-0 border-l-2 border-sky-500/70 pl-2.5">
          <a
            href={`#${subsystemCardId(text)}`}
            className="inline-flex items-center gap-1.5 hover:text-sky-800 transition-colors"
            onClick={e => {
              e.preventDefault()
              const el = document.getElementById(subsystemCardId(text))
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            title={`跳转到 ${text} 详情`}
            aria-label={`跳转到 ${text} 详情`}
          >
            <span>{text}</span>
            <span className="text-sky-500 text-xs leading-none">↧</span>
          </a>
        </h3>
      )
    },
    p: ({ children }: { children?: ReactNode }) => (
      <p className="text-sm text-slate-600 my-1 leading-relaxed">{children}</p>
    ),
    ul: ({ children }: { children?: ReactNode }) => (
      <ul className="text-sm text-slate-600 my-1 pl-4 list-disc space-y-0.5">{children}</ul>
    ),
    ol: ({ children }: { children?: ReactNode }) => (
      <ol className="text-sm text-slate-600 my-1 pl-4 list-decimal space-y-0.5">{children}</ol>
    ),
    li: ({ children }: { children?: ReactNode }) => {
      const hasPerfTag = (node: ReactNode): boolean => {
        if (!node) return false
        if (typeof node === 'string') return node.includes('perf')
        if (typeof node === 'number') return false
        if (Array.isArray(node)) return node.some(hasPerfTag)
        // React element
        const anyNode = node as any
        const type = anyNode?.type
        const props = anyNode?.props
        if (!props) return false
        // `code` nodes render tags like `perf`
        if (type === 'code') {
          const codeText =
            typeof props.children === 'string'
              ? props.children
              : Array.isArray(props.children)
                ? props.children.map((c: any) => (typeof c === 'string' ? c : '')).join('')
                : ''
          return codeText.trim() === 'perf'
        }
        return hasPerfTag(props.children)
      }

      const isPerf = hasPerfTag(children)

      return (
        <li
          className={
            isPerf
              ? 'text-sm text-slate-700 my-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.15)]'
              : 'text-sm text-slate-700 my-1 rounded-lg px-2.5 py-1.5'
          }
        >
          {children}
        </li>
      )
    },
    strong: ({ children }: { children?: ReactNode }) => (
      <strong className="text-slate-800 font-semibold">{children}</strong>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className="border-l-2 border-slate-300 pl-3 text-sm text-slate-600 my-2">{children}</blockquote>
    ),
    code: ({ children }: { children?: ReactNode }) => (
      <code className="bg-sky-100 px-1 py-0.5 rounded text-xs text-sky-800 border border-sky-200">{children}</code>
    ),
    pre: ({ children }: { children?: ReactNode }) => (
      <pre className="bg-slate-100 p-2.5 rounded overflow-x-auto text-xs my-2 text-slate-700">{children}</pre>
    ),
    hr: () => <hr className="border-slate-200 my-3" />,
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (href?.startsWith('#')) {
        const id = href.slice(1)
        const labelText =
          typeof children === 'string'
            ? children
            : Array.isArray(children)
              ? children.map(c => (typeof c === 'string' ? c : '')).join('')
              : '跳转到补丁'
        return (
          <a
            href={href}
            className="text-sky-600 hover:text-sky-700 underline underline-offset-2 text-sm"
            title={labelText || '跳转到补丁'}
            aria-label={labelText || '跳转到补丁'}
            onClick={e => {
              e.preventDefault()
              jumpToAnchor(decodeURIComponent(id))
            }}
          >
            {children}
          </a>
        )
      }
      const external = href?.startsWith('http')
      const childText =
        typeof children === 'string'
          ? children.trim()
          : Array.isArray(children)
            ? children.map(c => (typeof c === 'string' ? c : '')).join('').trim()
            : ''
      const isIconOnly = childText === '🔗' || childText === '↗'
      return (
        <a
          href={href}
          className={
            isIconOnly
              ? 'inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-sky-600 hover:text-sky-700 hover:bg-sky-50 transition-colors text-sm no-underline'
              : 'text-sky-600 hover:text-sky-700 underline underline-offset-2 text-sm'
          }
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {isIconOnly ? '↗' : children}
        </a>
      )
    },
  }

  const overviewSummaryComponents = {
    ...categorySummaryComponents,
    // Overall/overview comments should stay compact and neutral;
    // perf highlighting is reserved for per-subsystem detail blocks.
    li: ({ children }: { children?: ReactNode }) => (
      <li className="text-sm text-slate-700 my-1 rounded-lg px-2.5 py-1.5">{children}</li>
    ),
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">⏳</div>
          <p className="text-slate-500 text-base">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 sm:mb-8">
          <div className="flex items-center gap-3">
            {availableDates.length > 0 && (
              <select
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-base text-slate-700 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                style={{ minWidth: '140px' }}
              >
                {availableDates.map(date => (
                  <option key={date} value={date}>
                    {formatDateDisplay(date)}
                  </option>
                ))}
              </select>
            )}
            <h1 className="flex items-center gap-2 text-lg sm:text-xl font-semibold tracking-wide text-slate-900">
              <PenguinIcon className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" />
              <span>{displayName}</span>
            </h1>
          </div>
        </div>

        {summaryBlocks.length > 0 && (
          <div className="mb-5 sm:mb-8 space-y-3">
            {summaryBlocks.map((block, idx) => {
              if (block.isOverview) {
                return (
                  <div
                    key={`${block.title}-${idx}`}
                    className="bg-white rounded-xl p-4 sm:p-5 border border-slate-200 shadow-sm"
                  >
                    <div className="prose prose-base max-w-none">
                      <ReactMarkdown components={overviewSummaryComponents}>{block.markdown}</ReactMarkdown>
                    </div>
                  </div>
                )
              }

              const isOpen = !!expandedBlocks[block.title]
              const stats = summarizeBlock(block.markdown)
              // 标题由卡片头渲染，正文里去掉重复的 "## xxx"
              const body = block.markdown.replace(/^##\s+.*\n?/, '')

              return (
                <div
                  key={`${block.title}-${idx}`}
                  id={subsystemCardId(block.title)}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden scroll-mt-4"
                >
                  <button
                    type="button"
                    onClick={() => toggleBlock(block.title)}
                    aria-expanded={isOpen}
                    className="w-full flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 sm:px-5 py-3 text-left hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-sm font-semibold text-sky-700">{block.title}</span>
                    <span className="text-xs text-slate-400">{stats.total} 条</span>
                    {stats.perf > 0 && (
                      <span className="text-xs rounded-md bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5">
                        ⚡ {stats.perf}
                      </span>
                    )}
                    {stats.bugfix > 0 && (
                      <span className="text-xs rounded-md bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.5">
                        🐛 {stats.bugfix}
                      </span>
                    )}
                    <span className="ml-auto text-slate-400 text-xs">{isOpen ? '收起 ▲' : '展开 ▼'}</span>
                  </button>
                  {isOpen && (
                    <div className="px-4 sm:px-5 pb-4 prose prose-base max-w-none">
                      <ReactMarkdown components={categorySummaryComponents}>{body}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {summaryBlocks.length === 0 && summary && (
          <div className="bg-white rounded-xl p-4 sm:p-5 mb-5 sm:mb-8 border border-slate-200 shadow-sm">
            <div className="prose prose-base max-w-none">
              <ReactMarkdown components={categorySummaryComponents}>{summary}</ReactMarkdown>
            </div>
          </div>
        )}

        {count === 0 ? (
          <div className="text-center py-12 sm:py-16">
            <div className="text-5xl sm:text-6xl mb-4">📭</div>
            <h3 className="text-lg font-medium text-slate-700 mb-2">暂无内容</h3>
            <p className="text-base text-slate-500">还没有抓取到数据</p>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 text-base">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-slate-500">{displayName}</span>
                <span className="text-slate-900 font-semibold">{count} 条</span>
                <span className="text-slate-300">|</span>
                <span className={TYPE_COLOR.feature}>Feature {typeStats.feature}</span>
                <span className={TYPE_COLOR.bugfix}>Bugfix {typeStats.bugfix}</span>
                <span className={TYPE_COLOR.other}>Other {typeStats.other}</span>
              </div>
              {isGit && (
                <span className="text-slate-500">
                  <span className="text-emerald-600">+{additions.toLocaleString()}</span>
                  <span className="text-slate-300 mx-1">/</span>
                  <span className="text-rose-600">-{deletions.toLocaleString()}</span>
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-500">补丁明细列表已隐藏，仅展示摘要与统计信息。</p>
          </div>
        )}
      </div>
    </div>
  )
}
