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
// 对照工具：抓取指定日期的真实 LKML 补丁，跑一遍 generateSummary 并写到
// .preview-<date>.md，用来评估 prompt / 排序 / 折叠策略的改动效果。
// 用法：npx tsx src/scripts/preview-summary.ts 2026-09-28 [抽稀条数]
// 注意：并发刻意压到和生产一致（4），抓太快会被 lkml.org 限流。
const child_process_1 = require("child_process");
const cheerio = __importStar(require("cheerio"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ai_1 = require("../lib/ai");
const fixedSubsystem_1 = require("../lib/fixedSubsystem");
const storage_1 = require("../lib/storage");
// 注意：lkml.org 前置了 Anubis 反爬（对浏览器 UA 下发 JS PoW 挑战），
// 正式流程用 puppeteer 解题；本脚本只做离线对照，直接用非浏览器 UA 绕开挑战。
// 走 curl 而不是 node 的 http 客户端：这台机器上 node 直连 lkml.org 会超时，curl 正常。
function fetchText(url, timeoutSec = 60) {
    return (0, child_process_1.execFileSync)('curl', ['-sS', '--max-time', String(timeoutSec), url], {
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
    });
}
const EXCLUDE_AUTHORS = ['kernel test robot'];
async function mapPool(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i]);
        }
    }));
    return out;
}
function collectMessages(html, day) {
    const $ = cheerio.load(html);
    const out = [];
    for (const el of $('table.mh tr.c0, table.mh tr.c1').toArray()) {
        const $tds = $(el).find('td');
        const statusText = $tds.eq(0).text().replace(/\s+/g, ' ').trim();
        if (!statusText.includes('[New]'))
            continue;
        const $link = $tds.eq(1).find('a:first-child');
        const $authorTd = $tds.eq(2);
        const title = $link.text().trim();
        const link = $link.attr('href');
        const author = $authorTd.find('a').text().trim() || $authorTd.text().trim();
        if (!title || !link)
            continue;
        if (title.toLowerCase().startsWith('re:'))
            continue;
        if (EXCLUDE_AUTHORS.some(ex => author.toLowerCase().includes(ex)))
            continue;
        const lower = title.toLowerCase();
        if (!['patch', 'diff', 'git pull', 'rfc'].some(k => lower.includes(k)))
            continue;
        const timeMatch = statusText.match(/(\d{1,2}):(\d{2})/);
        const [y, m, d] = day.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        if (timeMatch)
            date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
        out.push({
            url: link.startsWith('http') ? link : `https://lkml.org${link}`,
            title,
            author,
            date: date.toISOString(),
        });
    }
    return out;
}
function parsePatchText(rawText) {
    const normalized = (rawText || '').replace(/\r/g, '').trim();
    if (!normalized)
        return { commitMessage: '', changedFiles: [] };
    const lines = normalized.split('\n').map(l => l.trimEnd());
    const divider = lines.findIndex(l => l.trim() === '---');
    const msgLines = divider >= 0 ? lines.slice(0, divider) : lines;
    let commitMessage = msgLines.filter(l => l.trim().length > 0).join('\n').trim();
    if (!commitMessage || commitMessage.length < 10) {
        commitMessage = normalized.split(/\bdiff --git\b/i)[0].split(/\n---\s|\s---\s/)[0].trim();
    }
    const changedFiles = new Set();
    for (const line of lines) {
        const diffStatRe = /(^|\s)(\S+?)\s+\|\s+\d+\b/g;
        let m;
        while ((m = diffStatRe.exec(line)) !== null) {
            const c = m[2].trim();
            if (!c || c.length > 200 || !/[\/.]/.test(c) || c.includes('://'))
                continue;
            if (/^(hi|this|patch|from|signed-off-by)$/i.test(c))
                continue;
            changedFiles.add(c);
        }
        const g = line.match(/\bdiff --git a\/(\S+)\s+b\/(\S+)/);
        if (g)
            changedFiles.add(g[2].trim());
        const minus = line.match(/---\s+a\/(\S+)/);
        if (minus)
            changedFiles.add(minus[1].trim());
        const plus = line.match(/\+\+\+\s+b\/(\S+)/);
        if (plus)
            changedFiles.add(plus[1].trim());
    }
    return { commitMessage, changedFiles: Array.from(changedFiles) };
}
async function fetchDetails(url) {
    try {
        const $ = cheerio.load(fetchText(url, 30));
        // 与正式流程一致：LKML 用 <br /> 断行，必须先还原成换行
        $('pre').find('br').replaceWith('\n');
        const preTexts = $('pre').toArray().map(el => $(el).text().trim()).filter(Boolean);
        const score = (t) => {
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
        const best = (preTexts.sort((a, b) => score(b) - score(a))[0] || '').trim();
        return parsePatchText(best);
    }
    catch {
        return { commitMessage: '', changedFiles: [] };
    }
}
async function collectArticles(day) {
    const d = new Date(day);
    const prev = new Date(d);
    prev.setDate(prev.getDate() - 1);
    const fmt = (x) => `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`;
    const seen = new Set();
    const msgs = [];
    for (const url of [`https://lkml.org/lkml/${fmt(prev)}`, `https://lkml.org/lkml/${fmt(d)}`]) {
        for (const m of collectMessages(fetchText(url), url.split('/').slice(-3).join('-'))) {
            if (seen.has(m.url))
                continue;
            seen.add(m.url);
            msgs.push(m);
        }
    }
    console.log(`[preview] 解析到 ${msgs.length} 条 patch，开始抓详情...`);
    const details = await mapPool(msgs, 4, m => fetchDetails(m.url));
    return msgs.map((m, i) => {
        const { commitMessage, changedFiles } = details[i];
        const content = [
            `补丁标题: ${m.title}`,
            `补丁链接: ${m.url}`,
            '',
            'Commit message:',
            commitMessage || '未解析到 commit message',
            '',
            '修改的文件:',
            changedFiles.length ? changedFiles.map(f => `- ${f}`).join('\n') : '- 未解析到修改文件',
        ].join('\n');
        const patchData = {
            id: `patch_${i}`,
            title: m.title,
            url: m.url,
            author: m.author,
            date: m.date,
            content,
            subsystem: '',
            type: (0, ai_1.inferPatchTypeRuleBased)(m.title, commitMessage || ''),
            highlight: false,
            summary: '',
            changedFiles,
            messages: [],
            replyCount: 0,
        };
        return { id: `art_${i}`, sourceName: 'Mailing List', title: m.title, author: m.author, url: m.url, fetchedAt: m.date, patchData };
    });
}
async function main() {
    const day = process.argv[2] || '2026-09-28';
    const limit = Number(process.argv[3]) || 0;
    const tag = limit ? `${day}-n${limit}` : day;
    const cfg = (0, storage_1.loadSourcesConfig)();
    const fixturePath = path_1.default.join(__dirname, `../../.preview-articles-${day}.json`);
    let articles;
    if (fs_1.default.existsSync(fixturePath)) {
        articles = JSON.parse(fs_1.default.readFileSync(fixturePath, 'utf8'));
        console.log(`[preview] 复用本地 fixture: ${articles.length} 条`);
    }
    else {
        articles = await collectArticles(day);
        fs_1.default.writeFileSync(fixturePath, JSON.stringify(articles), 'utf8');
        console.log(`[preview] fixture 已缓存: ${fixturePath}`);
    }
    if (limit && articles.length > limit) {
        const step = articles.length / limit;
        articles = Array.from({ length: limit }, (_, i) => articles[Math.floor(i * step)]);
        console.log(`[preview] 已抽稀到 ${articles.length} 条`);
    }
    const types = { feature: 0, bugfix: 0, other: 0 };
    const bySub = new Map();
    for (const a of articles) {
        types[a.patchData?.type || 'other']++;
        const s = (0, fixedSubsystem_1.inferFixedSubsystemFromFiles)(a.patchData?.changedFiles || [], cfg.fixedSubsystemRules) || '(unmatched)';
        bySub.set(s, (bySub.get(s) || 0) + 1);
    }
    console.log('[preview] 类型分布:', JSON.stringify(types));
    console.log('[preview] 子系统分布:', Array.from(bySub.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
    const ranked = articles
        .map(a => ({ title: a.patchData?.title || a.title, ...(0, ai_1.analyzeArticlePriority)(a) }))
        .sort((a, b) => b.score - a.score);
    console.log('[preview] 优先级 Top 10:');
    for (const r of ranked.slice(0, 10)) {
        const tags = [r.category, r.arch, r.driverScope !== 'none' ? r.driverScope : '']
            .filter(Boolean)
            .join('/');
        console.log(`  ${String(r.score).padStart(4)} [${tags}] ${r.title}`);
    }
    const out = await (0, ai_1.generateSummary)(articles, {
        subsystemPrompt: cfg.subsystemPrompt,
        overallPrompt: cfg.overallPrompt,
        summaryMaxChars: cfg.summaryMaxChars,
        subsystemMaxItems: cfg.subsystemMaxItems,
        subsystemSummaryConcurrency: cfg.subsystemSummaryConcurrency,
        fixedSubsystemRules: cfg.fixedSubsystemRules,
    });
    const outPath = path_1.default.join(__dirname, `../../.preview-${tag}.md`);
    fs_1.default.writeFileSync(outPath, out, 'utf8');
    console.log(`[preview] 已写入 ${outPath}`);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
