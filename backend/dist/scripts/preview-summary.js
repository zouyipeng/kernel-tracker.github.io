"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 对照工具：抓取指定日期的真实 LKML 补丁，跑一遍 generateSummary 并写到
// .preview-<date>.md，用来评估 prompt / 排序 / 折叠策略的改动效果。
// 用法：npx tsx src/scripts/preview-summary.ts 2026-09-28 [抽稀条数]
// 数据来自 lore.kernel.org 的 Atom 搜索流（lkml.org 已不可用）。
// lore 前置了 Anubis 反爬，这里用 headless Chrome 过挑战；消息正文随 Atom entry 一起返回，
// 不需要再逐条抓补丁详情页。
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ai_1 = require("../lib/ai");
const fixedSubsystem_1 = require("../lib/fixedSubsystem");
const storage_1 = require("../lib/storage");
const lore_1 = require("../lib/lore");
const EXCLUDE_AUTHORS = ['kernel test robot'];
const LORE_BASE_URL = 'https://lore.kernel.org/lkml/';
async function collectArticles(day) {
    const [y, m, d] = day.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const browser = await (0, lore_1.launchLoreBrowser)({ headless: true });
    if (!browser)
        throw new Error('未找到 Chrome/Edge 浏览器，请设置 CHROME_PATH 环境变量');
    let messages;
    try {
        messages = await (0, lore_1.fetchLoreMessages)(browser, LORE_BASE_URL, {
            since: target,
            until: target,
            timeoutMs: 60000,
            maxPages: 50,
        });
    }
    finally {
        await browser.close();
    }
    const patches = messages.filter(msg => (0, lore_1.isLkmlPatchMessage)(msg, EXCLUDE_AUTHORS));
    console.log(`[preview] 解析到 ${patches.length} 条 patch`);
    return patches.map((msg, i) => {
        const { commitMessage, changedFiles } = (0, lore_1.parseLkmlPatchText)(msg.body);
        const content = [
            `补丁标题: ${msg.title}`,
            `补丁链接: ${msg.url}`,
            '',
            'Commit message:',
            commitMessage || '未解析到 commit message',
            '',
            '修改的文件:',
            changedFiles.length ? changedFiles.map(f => `- ${f}`).join('\n') : '- 未解析到修改文件',
        ].join('\n');
        const patchData = {
            id: `patch_${i}`,
            title: msg.title,
            url: msg.url,
            author: msg.author,
            date: msg.date,
            content,
            subsystem: '',
            type: (0, ai_1.inferPatchTypeRuleBased)(msg.title, commitMessage || ''),
            highlight: false,
            summary: '',
            changedFiles,
            messages: [],
            replyCount: 0,
        };
        return { id: `art_${i}`, sourceName: 'Mailing List', title: msg.title, author: msg.author, url: msg.url, fetchedAt: msg.date, patchData };
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
