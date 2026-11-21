import simpleGit from 'simple-git'
import {
  loadSourcesConfig,
  getTodayString,
  generateArticleId,
  saveSourceData,
  type Source,
  type Article,
  type LKMLMessage,
  type LKMLPatch,
  type GitCommit,
  type SourceDayData
} from './storage'
import {
  generateSummary,
  inferPatchTypeRuleBased,
} from './ai'
import { inferKernelSubsystem } from './subsystem'
import {
  fetchLoreMessages,
  isLkmlPatchMessage,
  launchLoreBrowser,
  parseLkmlPatchText,
} from './lore'

async function fetchLKML(source: Source): Promise<Article[]> {
  const excludeAuthors = source.excludeAuthors || []
  const timeoutMs = source.lkmlPageTimeoutMs ?? 60000
  const maxPages = source.lkmlMaxPages ?? 50

  const browser = await launchLoreBrowser()
  if (!browser) {
    console.error('[Fetcher] LKML - 无法启动浏览器，跳过抓取')
    return []
  }

  try {
    const today = new Date()
    // lore 搜索的 d: 按服务器时区（美国太平洋时间）切天，比东八区晚 16 小时。
    // 只取“昨天..今天”会漏掉本地昨天 00:00 到 16:00 这一段的邮件；
    // 往前多取一天，让相邻两次日更的抓取窗口有重叠、不留空档。
    const since = new Date(today)
    since.setDate(since.getDate() - 2)
    console.log(
      `[Fetcher] LKML - 正在抓取 ${source.url} (${since.toLocaleDateString()} ~ ${today.toLocaleDateString()})`
    )

    // lore 的 Atom 搜索流里每条 entry 自带完整消息正文（含 diff），
    // 所以这里一次性拿全，不再逐条访问补丁详情页。
    const messages = await fetchLoreMessages(browser, source.url, {
      since,
      until: today,
      timeoutMs,
      maxPages,
    })

    const patches = messages.filter(msg => isLkmlPatchMessage(msg, excludeAuthors))
    console.log(`[Fetcher] LKML - 共 ${messages.length} 条消息，其中补丁 ${patches.length} 条`)

    const articles: Article[] = patches.map((msg, index) => {
      const parsed = parseLkmlPatchText(msg.body)
      const content = [
        `补丁标题: ${msg.title}`,
        `补丁链接: ${msg.url}`,
        '',
        'Commit message:',
        parsed.commitMessage || '未解析到 commit message',
        '',
        '修改的文件:',
        parsed.changedFiles.length > 0
          ? parsed.changedFiles.map(f => `- ${f}`).join('\n')
          : '- 未解析到修改文件',
      ].join('\n')

      const type = inferPatchTypeRuleBased(msg.title, parsed.commitMessage)

      const message: LKMLMessage = {
        id: `msg_${Date.now()}_${index}`,
        url: msg.url,
        title: msg.title,
        author: msg.author,
        date: msg.date,
        content: '',
        isReply: false,
      }

      const patchData: LKMLPatch = {
        id: `patch_${Date.now()}_${index}`,
        title: msg.title,
        url: msg.url,
        author: msg.author,
        date: msg.date,
        content,
        subsystem: inferKernelSubsystem({ title: msg.title, files: parsed.changedFiles }),
        type,
        highlight: false,
        summary: '',
        changedFiles: parsed.changedFiles,
        messages: [message],
        replyCount: 0,
      }

      return {
        id: generateArticleId(),
        sourceName: source.name,
        title: msg.title,
        content,
        url: msg.url,
        author: msg.author,
        fetchedAt: new Date().toISOString(),
        patchData,
      }
    })

    return articles.sort(
      (a, b) => new Date(b.patchData?.date || 0).getTime() - new Date(a.patchData?.date || 0).getTime()
    )
  } catch (error) {
    console.error(`LKML抓取失败 [${source.name}]:`, error)
    return []
  } finally {
    await browser.close()
    console.log('[Fetcher] 浏览器已关闭')
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`[Timeout] ${label} (${timeoutMs}ms)`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId!)
  }
}

async function fetchGitRepo(source: Source): Promise<Article[]> {
  const gitConfig = source.gitConfig
  if (!gitConfig?.localPath) {
    console.error(`[Fetcher] Git - 缺少 localPath 配置: ${source.name}`)
    return []
  }

  const fetchTimeoutMs = gitConfig.timeoutMs ?? 120000 // 默认 2 分钟

  try {
    console.log(`[Fetcher] Git - 正在读取仓库: ${gitConfig.localPath}`)
    const git = simpleGit(gitConfig.localPath)

    if (!await withTimeout(git.checkIsRepo(), 30000, `检查仓库: ${source.name}`)) {
      console.error(`[Fetcher] Git - 不是有效的 Git 仓库: ${gitConfig.localPath}`)
      return []
    }

    const sinceDays = gitConfig.sinceDays || 7
    const maxCommits = gitConfig.maxCommits || 200
    const sinceDate = new Date()
    sinceDate.setDate(sinceDate.getDate() - sinceDays)
    const sinceStr = sinceDate.toISOString().split('T')[0]

    console.log(`[Fetcher] Git - 时间范围: ${sinceStr} 至今, 最大提交数: ${maxCommits}, 超时: ${fetchTimeoutMs}ms`)

    const logResult = await withTimeout(
      git.log(['--since', sinceStr, '--no-merges', `-${maxCommits}`]),
      fetchTimeoutMs,
      `git.log: ${source.name}`
    )
    console.log(`[Fetcher] Git - 获取到 ${logResult.all.length} 个提交`)

    const articles: Article[] = []
    for (const commit of logResult.all) {
      const hash = commit.hash
      const shortHash = hash.substring(0, 7)
      const title = commit.message?.split('\n')[0] || ''
      const author = commit.author_name || ''
      const authorEmail = commit.author_email || ''
      const date = commit.date || ''

      let files: string[] = []
      let additions = 0
      let deletions = 0

      try {
        const diffResult = await withTimeout(
          git.diffSummary([`${hash}^`, hash]),
          30000,
          `git.diffSummary: ${shortHash}`
        )
        files = diffResult.files.map(f => f.file)
        additions = diffResult.insertions || 0
        deletions = diffResult.deletions || 0
      } catch {
        // 单个 diff 超时不影响整体，继续处理下一个 commit
      }

      const content = [
        `提交: ${shortHash}`,
        `作者: ${author} <${authorEmail}>`,
        `日期: ${date}`,
        `标题: ${title}`,
        '',
        '修改的文件:',
        ...files.slice(0, 20).map(f => `- ${f}`),
        files.length > 20 ? `... 还有 ${files.length - 20} 个文件` : '',
        '',
        `统计: +${additions} -${deletions}`
      ].filter(Boolean).join('\n')

      const type = inferPatchTypeRuleBased(title, content)
      const subsystem = inferKernelSubsystem({ title, files })

      const gitCommitData: GitCommit = {
        hash,
        shortHash,
        title,
        author,
        authorEmail,
        date,
        content,
        files,
        additions,
        deletions,
        subsystem: subsystem as any,
        type: type as any,
        url: `https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=${hash}`
      }

      articles.push({
        id: generateArticleId(),
        sourceName: source.name,
        title,
        content,
        url: gitCommitData.url,
        author,
        fetchedAt: new Date().toISOString(),
        gitCommitData,
      })
    }

    return articles.sort(
      (a, b) => new Date(b.gitCommitData?.date || 0).getTime() - new Date(a.gitCommitData?.date || 0).getTime()
    )
  } catch (error: any) {
    if (error.message?.includes('[Timeout]')) {
      console.warn(`[Fetcher] Git - 仓库抓取超时已跳过 [${source.name}]: ${error.message}`)
    } else {
      console.error(`Git抓取失败 [${source.name}]:`, error)
    }
    return []
  }
}

export async function fetchAll(): Promise<void> {
  const todayStr = getTodayString()
  const config = loadSourcesConfig()
  const sources = config.sources.filter(s => s.active)
  
  console.log(`[Fetcher] 开始抓取 ${sources.length} 个信息源...`)
  
  for (const source of sources) {
    try {
      console.log(`\n[Fetcher] 正在抓取: ${source.name} (${source.type})`)
      
      let articles: Article[]
      if (source.type === 'lkml') {
        articles = await fetchLKML(source)
      } else if (source.type === 'git') {
        articles = await fetchGitRepo(source)
      } else {
        console.log(`[Fetcher] 跳过不支持的信息源类型: ${source.type}`)
        continue
      }

      if (articles.length === 0) {
        console.log(`[Fetcher] ${source.name} 无数据`)
        continue
      }

      console.log(`[Fetcher] ${source.name} 完成，获取 ${articles.length} 条记录`)

      console.log(`[AI] 正在生成 ${source.name} 摘要...`)
      const summary = await generateSummary(articles, {
        subsystemPrompt: config.subsystemPrompt,
        overallPrompt: config.overallPrompt,
        summaryMaxChars: config.summaryMaxChars,
        subsystemMaxItems: config.subsystemMaxItems,
        subsystemSummaryConcurrency: config.subsystemSummaryConcurrency,
        fixedSubsystemRules: config.fixedSubsystemRules,
      })

      const sourceDayData: SourceDayData = {
        date: todayStr,
        sourceName: source.name,
        sourceType: source.type,
        generatedAt: new Date().toISOString(),
        summary,
        articles
      }

      saveSourceData(sourceDayData)
      console.log(`[Fetcher] ${source.name} 数据已保存`)
    } catch (error: any) {
      console.error(`[Fetcher] ${source.name} 抓取失败:`, error.message)
    }
  }
  
  console.log(`\n[Fetcher] 全部抓取完成！`)
}
