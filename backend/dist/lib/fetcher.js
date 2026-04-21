"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAll = fetchAll;
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const simple_git_1 = __importDefault(require("simple-git"));
const puppeteer_core_1 = __importDefault(require("puppeteer-core"));
const storage_1 = require("./storage");
const ai_1 = require("./ai");
const subsystem_1 = require("./subsystem");
const CHROME_PATHS_WIN = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME_PATHS_MAC = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const CHROME_PATHS_LINUX = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
];
function findChromePath() {
    const paths = process.platform === 'win32' ? CHROME_PATHS_WIN
        : process.platform === 'darwin' ? CHROME_PATHS_MAC
            : CHROME_PATHS_LINUX;
    const fs = require('fs');
    for (const p of paths) {
        if (p && fs.existsSync(p))
            return p;
    }
    return null;
}
async function launchBrowser() {
    const chromePath = findChromePath();
    if (!chromePath) {
        console.error('[Fetcher] 未找到 Chrome/Edge 浏览器，请设置 CHROME_PATH 环境变量');
        return null;
    }
    console.log(`[Fetcher] 使用浏览器: ${chromePath}`);
    try {
        const browser = await puppeteer_core_1.default.launch({
            executablePath: chromePath,
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: null,
        });
        console.log('[Fetcher] 浏览器已启动');
        return browser;
    }
    catch (err) {
        console.error('[Fetcher] 启动浏览器失败:', err);
        return null;
    }
}
async function fetchPageWithBrowser(browser, url, waitForSelector, timeoutMs = 60000) {
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
        await page.evaluateOnNewDocument(`Object.defineProperty(navigator, 'webdriver', { get: () => false })`);
        console.log(`[Fetcher] 浏览器访问: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
        const maxWait = 90000;
        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            try {
                const hasTarget = await page.evaluate(`!!document.querySelector('${waitForSelector.replace(/'/g, "\\'")}')`);
                if (hasTarget) {
                    console.log('[Fetcher] 目标内容已加载');
                    break;
                }
            }
            catch {
                // page navigated, re-wait for load
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                }
                catch { }
            }
            const isChallenge = await page.evaluate(`document.body?.textContent?.includes('Anubis') || document.body?.textContent?.includes('工作量证明') || document.body?.textContent?.includes('Proof-of-Work') || document.title?.includes('确认')`).catch(() => false);
            if (isChallenge) {
                console.log('[Fetcher] 检测到 Anubis 挑战页面，等待挑战完成...');
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        const html = await page.content();
        return html;
    }
    finally {
        await page.close();
    }
}
function buildLkmlDayPageUrl(baseUrl, day) {
    return new URL(`/lkml/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`, baseUrl).href;
}
function collectLkmlPatchMessagesFromHtml(html, source, excludeAuthors, seenUrls, out, pageLabel) {
    const extractHourMinute = (text) => {
        const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
        if (!timeMatch)
            return null;
        const hour = parseInt(timeMatch[1], 10);
        const minute = parseInt(timeMatch[2], 10);
        if (Number.isNaN(hour) || Number.isNaN(minute))
            return null;
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
            return null;
        return { hour, minute };
    };
    const $ = cheerio.load(html);
    const messageEntries = $('table.mh tr.c0, table.mh tr.c1');
    console.log(`[Fetcher] LKML (${pageLabel}) - 表格行数: ${messageEntries.length}`);
    for (const element of messageEntries.toArray()) {
        const $entry = $(element);
        const $tds = $entry.find('td');
        const $statusTd = $tds.eq(0);
        const statusText = $statusTd.text().replace(/\s+/g, ' ').trim();
        if (!statusText.includes('[New]'))
            continue;
        const $titleTd = $tds.eq(1);
        const $link = $titleTd.find('a:first-child');
        const $authorTd = $tds.eq(2);
        const title = $link.text().trim();
        const link = $link.attr('href');
        const author = $authorTd.find('a').text().trim() || $authorTd.text().trim();
        if (!title || !link)
            continue;
        if (title.toLowerCase().startsWith('re:'))
            continue;
        if (excludeAuthors.some(ex => author.toLowerCase().includes(ex.toLowerCase())))
            continue;
        if (!title.toLowerCase().includes('patch') &&
            !title.toLowerCase().includes('diff') &&
            !title.toLowerCase().includes('git pull') &&
            !title.toLowerCase().includes('rfc'))
            continue;
        const fullUrl = link.startsWith('http') ? link : new URL(link, source.url).href;
        if (seenUrls.has(fullUrl))
            continue;
        let parsedDate = new Date().toISOString();
        const urlDateMatch = fullUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
        if (urlDateMatch) {
            try {
                const year = parseInt(urlDateMatch[1]);
                const month = parseInt(urlDateMatch[2]) - 1;
                const day = parseInt(urlDateMatch[3]);
                const date = new Date(year, month, day);
                const hm = extractHourMinute(statusText);
                if (hm)
                    date.setHours(hm.hour, hm.minute, 0, 0);
                parsedDate = date.toISOString();
            }
            catch { }
        }
        seenUrls.add(fullUrl);
        out.push({
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            url: fullUrl,
            title,
            author,
            date: parsedDate,
            content: '',
            isReply: false,
        });
    }
}
function parseLkmlPatchText(rawText) {
    const normalized = rawText.replace(/\r/g, '').trim();
    if (!normalized)
        return { commitMessage: '', changedFiles: [] };
    const lines = normalized.split('\n').map(line => line.trimEnd());
    const dividerIndex = lines.findIndex(line => line.trim() === '---');
    const messageLines = dividerIndex >= 0 ? lines.slice(0, dividerIndex) : lines;
    let commitMessage = messageLines.filter(line => line.trim().length > 0).join('\n').trim();
    if (!commitMessage || commitMessage.length < 10) {
        const cutByDiff = normalized.split(/\bdiff --git\b/i)[0];
        commitMessage = cutByDiff.split(/\n---\s|\s---\s/)[0].trim();
    }
    const changedFiles = new Set();
    for (const line of lines) {
        // diffstat 行经常被 LKML 页面挤到同一行里；因此不要整行截断，而是在行内抽取像路径的 token
        // 形如: "mm/vmscan.c            | 456 +++++" 或 "drivers/net/ppp/pppoe.c | 166 ++++"
        const diffStatRe = /(^|\s)(\S+?)\s+\|\s+\d+\b/g;
        let m;
        while ((m = diffStatRe.exec(line)) !== null) {
            const candidate = m[2].trim();
            if (!candidate)
                continue;
            // 过滤掉明显不是路径的内容
            if (candidate.length > 200)
                continue;
            if (!/[\/.]/.test(candidate))
                continue;
            if (candidate.includes('://'))
                continue;
            if (/^(hi|this|patch|from|signed-off-by)$/i.test(candidate))
                continue;
            changedFiles.add(candidate);
        }
        // "diff --git a/foo b/foo" 后面可能紧跟 "index ..."（同一行），且不一定在行首
        const diffGitMatch = line.match(/\bdiff --git a\/(\S+)\s+b\/(\S+)/);
        if (diffGitMatch)
            changedFiles.add(diffGitMatch[2].trim());
        // 兜底：从 --- a/ 与 +++ b/ 提取（有些补丁没有 diff --git）
        const minusFile = line.match(/---\s+a\/(\S+)/);
        if (minusFile)
            changedFiles.add(minusFile[1].trim());
        const plusFile = line.match(/\+\+\+\s+b\/(\S+)/);
        if (plusFile)
            changedFiles.add(plusFile[1].trim());
    }
    return { commitMessage, changedFiles: Array.from(changedFiles) };
}
function parseDateTextToIso(raw) {
    if (!raw)
        return null;
    const ts = Date.parse(raw);
    if (Number.isNaN(ts))
        return null;
    return new Date(ts).toISOString();
}
async function fetchLkmlPatchDetails(patchUrl, headers, timeoutMs) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios_1.default.get(patchUrl, { headers, timeout: timeoutMs });
            const $ = cheerio.load(response.data);
            const preTexts = $('pre')
                .toArray()
                .map(el => $(el).text())
                .map(t => (t || '').trim())
                .filter(Boolean);
            const scorePre = (t) => {
                let s = 0;
                if (/\bdiff --git\b/i.test(t))
                    s += 50;
                if (/^---\s+a\//m.test(t) && /^\+\+\+\s+b\//m.test(t))
                    s += 30;
                if (/^Signed-off-by:/mi.test(t))
                    s += 10;
                if (t.length > 4000)
                    s += 5;
                return s;
            };
            const rawPatchText = (preTexts.sort((a, b) => scorePre(b) - scorePre(a))[0] || '').trim();
            const parsed = parseLkmlPatchText(rawPatchText);
            const dateRow = $('tr').filter((_, tr) => {
                const firstCell = $(tr).find('th, td').first().text().replace(/\s+/g, ' ').trim();
                return firstCell === 'Date';
            }).first();
            const dateText = dateRow.find('td').last().text().replace(/\s+/g, ' ').trim();
            return { ...parsed, sentAt: parseDateTextToIso(dateText) };
        }
        catch (error) {
            const status = error?.response?.status;
            if (attempt < 3 && (status === 429 || status >= 500 || error?.code === 'ECONNABORTED')) {
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
                continue;
            }
            console.error(`[Fetcher] LKML - 获取补丁详情失败: ${patchUrl}`);
            return { commitMessage: '', changedFiles: [], sentAt: null };
        }
    }
    return { commitMessage: '', changedFiles: [], sentAt: null };
}
async function fetchLkmlPatchDetailsBrowser(browser, patchUrl, timeoutMs) {
    try {
        const html = await fetchPageWithBrowser(browser, patchUrl, 'pre', 60000);
        const $ = cheerio.load(html);
        const preTexts = $('pre')
            .toArray()
            .map(el => $(el).text())
            .map(t => (t || '').trim())
            .filter(Boolean);
        const scorePre = (t) => {
            let s = 0;
            if (/\bdiff --git\b/i.test(t))
                s += 50;
            if (/^---\s+a\//m.test(t) && /^\+\+\+\s+b\//m.test(t))
                s += 30;
            if (/^Signed-off-by:/mi.test(t))
                s += 10;
            if (t.length > 4000)
                s += 5;
            return s;
        };
        const rawPatchText = (preTexts.sort((a, b) => scorePre(b) - scorePre(a))[0] || '').trim();
        const parsed = parseLkmlPatchText(rawPatchText);
        const dateRow = $('tr').filter((_, tr) => {
            const firstCell = $(tr).find('th, td').first().text().replace(/\s+/g, ' ').trim();
            return firstCell === 'Date';
        }).first();
        const dateText = dateRow.find('td').last().text().replace(/\s+/g, ' ').trim();
        return { ...parsed, sentAt: parseDateTextToIso(dateText) };
    }
    catch (error) {
        console.error(`[Fetcher] LKML - 获取补丁详情失败(浏览器): ${patchUrl}`, error);
        return { commitMessage: '', changedFiles: [], sentAt: null };
    }
}
async function mapWithConcurrency(items, limit, mapper) {
    if (items.length === 0)
        return [];
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length)
                break;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
async function fetchLKML(source) {
    const excludeAuthors = source.excludeAuthors || [];
    const concurrency = Math.min(source.lkmlDetailConcurrency ?? 4, 4);
    const timeoutMs = source.lkmlDetailTimeoutMs ?? 15000;
    const browser = await launchBrowser();
    if (!browser) {
        console.error('[Fetcher] LKML - 无法启动浏览器，跳过抓取');
        return [];
    }
    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const messages = [];
        const seenUrls = new Set();
        for (const { url, label } of [
            { url: buildLkmlDayPageUrl(source.url, yesterday), label: '昨日' },
            { url: buildLkmlDayPageUrl(source.url, today), label: '今日' },
        ]) {
            console.log(`[Fetcher] LKML - 正在访问 (${label}): ${url}`);
            try {
                const html = await fetchPageWithBrowser(browser, url, 'table.mh', 90000);
                collectLkmlPatchMessagesFromHtml(html, source, excludeAuthors, seenUrls, messages, label);
            }
            catch (pageErr) {
                console.error(`[Fetcher] LKML (${label}) 页面抓取失败:`, pageErr);
            }
        }
        console.log(`[Fetcher] LKML - 解析到 ${messages.length} 条 [New] patch 消息`);
        const articles = [];
        const batchSize = 80;
        for (let start = 0; start < messages.length; start += batchSize) {
            const chunk = messages.slice(start, start + batchSize);
            const chunkArticles = await mapWithConcurrency(chunk, concurrency, async (msg) => {
                console.log(`[Fetcher] LKML - 处理补丁: ${msg.title.substring(0, 50)}...`);
                const patchDetails = await fetchLkmlPatchDetailsBrowser(browser, msg.url, timeoutMs);
                const content = [
                    `补丁标题: ${msg.title}`,
                    `补丁链接: ${msg.url}`,
                    '',
                    'Commit message:',
                    patchDetails.commitMessage || '未解析到 commit message',
                    '',
                    '修改的文件:',
                    patchDetails.changedFiles.length > 0
                        ? patchDetails.changedFiles.map(f => `- ${f}`).join('\n')
                        : '- 未解析到修改文件',
                ].join('\n');
                const type = (0, ai_1.inferPatchTypeRuleBased)(msg.title, patchDetails.commitMessage || '');
                const patchData = {
                    id: `patch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    title: msg.title,
                    url: msg.url,
                    author: msg.author,
                    date: patchDetails.sentAt || msg.date,
                    content,
                    subsystem: (0, subsystem_1.inferKernelSubsystem)({ title: msg.title, files: patchDetails.changedFiles }),
                    type,
                    highlight: false,
                    summary: '',
                    changedFiles: patchDetails.changedFiles,
                    messages: [msg],
                    replyCount: 0,
                };
                return {
                    id: (0, storage_1.generateArticleId)(),
                    sourceName: source.name,
                    title: msg.title,
                    content,
                    url: msg.url,
                    author: msg.author,
                    fetchedAt: new Date().toISOString(),
                    patchData,
                };
            });
            articles.push(...chunkArticles);
        }
        return articles.sort((a, b) => new Date(b.patchData?.date || 0).getTime() - new Date(a.patchData?.date || 0).getTime());
    }
    catch (error) {
        console.error(`LKML抓取失败 [${source.name}]:`, error);
        return [];
    }
    finally {
        await browser.close();
        console.log('[Fetcher] 浏览器已关闭');
    }
}
async function fetchGitRepo(source) {
    const gitConfig = source.gitConfig;
    if (!gitConfig?.localPath) {
        console.error(`[Fetcher] Git - 缺少 localPath 配置: ${source.name}`);
        return [];
    }
    try {
        console.log(`[Fetcher] Git - 正在读取仓库: ${gitConfig.localPath}`);
        const git = (0, simple_git_1.default)(gitConfig.localPath);
        if (!await git.checkIsRepo()) {
            console.error(`[Fetcher] Git - 不是有效的 Git 仓库: ${gitConfig.localPath}`);
            return [];
        }
        const sinceDays = gitConfig.sinceDays || 7;
        const maxCommits = gitConfig.maxCommits || 200;
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - sinceDays);
        const sinceStr = sinceDate.toISOString().split('T')[0];
        console.log(`[Fetcher] Git - 时间范围: ${sinceStr} 至今, 最大提交数: ${maxCommits}`);
        const logResult = await git.log(['--since', sinceStr, '--no-merges', `-${maxCommits}`]);
        console.log(`[Fetcher] Git - 获取到 ${logResult.all.length} 个提交`);
        const articles = [];
        for (const commit of logResult.all) {
            const hash = commit.hash;
            const shortHash = hash.substring(0, 7);
            const title = commit.message?.split('\n')[0] || '';
            const author = commit.author_name || '';
            const authorEmail = commit.author_email || '';
            const date = commit.date || '';
            let files = [];
            let additions = 0;
            let deletions = 0;
            try {
                const diffResult = await git.diffSummary([`${hash}^`, hash]);
                files = diffResult.files.map(f => f.file);
                additions = diffResult.insertions || 0;
                deletions = diffResult.deletions || 0;
            }
            catch { }
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
            ].filter(Boolean).join('\n');
            const type = (0, ai_1.inferPatchTypeRuleBased)(title, content);
            const subsystem = (0, subsystem_1.inferKernelSubsystem)({ title, files });
            const gitCommitData = {
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
                subsystem: subsystem,
                type: type,
                url: `https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=${hash}`
            };
            articles.push({
                id: (0, storage_1.generateArticleId)(),
                sourceName: source.name,
                title,
                content,
                url: gitCommitData.url,
                author,
                fetchedAt: new Date().toISOString(),
                gitCommitData,
            });
        }
        return articles.sort((a, b) => new Date(b.gitCommitData?.date || 0).getTime() - new Date(a.gitCommitData?.date || 0).getTime());
    }
    catch (error) {
        console.error(`Git抓取失败 [${source.name}]:`, error);
        return [];
    }
}
async function fetchAll() {
    const todayStr = (0, storage_1.getTodayString)();
    const config = (0, storage_1.loadSourcesConfig)();
    const sources = config.sources.filter(s => s.active);
    console.log(`[Fetcher] 开始抓取 ${sources.length} 个信息源...`);
    for (const source of sources) {
        try {
            console.log(`\n[Fetcher] 正在抓取: ${source.name} (${source.type})`);
            let articles;
            if (source.type === 'lkml') {
                articles = await fetchLKML(source);
            }
            else if (source.type === 'git') {
                articles = await fetchGitRepo(source);
            }
            else {
                console.log(`[Fetcher] 跳过不支持的信息源类型: ${source.type}`);
                continue;
            }
            if (articles.length === 0) {
                console.log(`[Fetcher] ${source.name} 无数据`);
                continue;
            }
            console.log(`[Fetcher] ${source.name} 完成，获取 ${articles.length} 条记录`);
            console.log(`[AI] 正在生成 ${source.name} 摘要...`);
            const summary = await (0, ai_1.generateSummary)(articles, {
                subsystemPrompt: config.subsystemPrompt,
                overallPrompt: config.overallPrompt,
                subsystemSummaryConcurrency: config.subsystemSummaryConcurrency,
                fixedSubsystemRules: config.fixedSubsystemRules,
            });
            const sourceDayData = {
                date: todayStr,
                sourceName: source.name,
                sourceType: source.type,
                generatedAt: new Date().toISOString(),
                summary,
                articles
            };
            (0, storage_1.saveSourceData)(sourceDayData);
            console.log(`[Fetcher] ${source.name} 数据已保存`);
        }
        catch (error) {
            console.error(`[Fetcher] ${source.name} 抓取失败:`, error.message);
        }
    }
    console.log(`\n[Fetcher] 全部抓取完成！`);
}
