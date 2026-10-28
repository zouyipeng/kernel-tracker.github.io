"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeArticlePriority = analyzeArticlePriority;
exports.scoreArticlePriority = scoreArticlePriority;
exports.scoreSubsystemPriority = scoreSubsystemPriority;
exports.generateSummary = generateSummary;
exports.inferPatchTypeRuleBased = inferPatchTypeRuleBased;
const openai_1 = __importDefault(require("openai"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const subsystem_1 = require("./subsystem");
const fixedSubsystem_1 = require("./fixedSubsystem");
const configPath = path_1.default.join(__dirname, '../../config.json');
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
};
if (fs_1.default.existsSync(configPath)) {
    try {
        const configData = fs_1.default.readFileSync(configPath, 'utf8');
        const loadedConfig = JSON.parse(configData);
        config = {
            openai: {
                ...config.openai,
                ...loadedConfig.openai
            }
        };
        console.log('[AI] 配置文件加载成功');
    }
    catch (error) {
        console.error('[AI] 读取配置文件失败:', error);
    }
}
const openai = new openai_1.default({
    apiKey: config.openai.apiKey || '',
    baseURL: config.openai.baseURL || 'https://api.openai.com/v1',
});
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
// 总览（「今日社区动态」正文）字数上限的默认值，可在 sources-config.json 用
// summaryMaxChars 覆盖。
// 注意：这里统计的是整行渲染后的可见字数，含图标、子系统名与「：」，13 个子系统的
// 固定开销约 178 字；若上限设得过低（如 500），留给点评正文的额度不足，兜底截断会
// 把每行从中间切断。
const DEFAULT_SUMMARY_MAX_CHARS = 900;
// 统计“渲染后可见字数”：Markdown 链接/图片还原成其显示文本，去掉标记符号与空白，
// 再按 Unicode 码点计数（emoji 记 1 个字）。
function countVisibleChars(markdown) {
    const visible = (markdown || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_~>#]/g, '')
        .replace(/\s+/g, '');
    return Array.from(visible).length;
}
// 把一行拆成 token：Markdown 链接整体作为一个 token，其余按码点切分。
// 按 token 截断可以避免把 [名称](#锚点) 剪断导致链接语法失效。
function markdownTokens(text) {
    return text.match(/!?\[[^\]]*\]\([^)]*\)|./gsu) || [];
}
// 按可见字数上限截断一行，超出部分用 …
function truncateVisible(text, limit) {
    let kept = '';
    let count = 0;
    for (const token of markdownTokens(text)) {
        const t = countVisibleChars(token);
        if (count + t > limit - 1)
            break;
        kept += token;
        count += t;
    }
    return `${kept.replace(/[\s，。；：、,;:.]+$/, '')}…`;
}
function cleanAIResponse(content) {
    if (!content)
        return '';
    let cleaned = content;
    cleaned = cleaned.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
    const thinkEndMatch = cleaned.match(/<\/think>/i);
    if (thinkEndMatch) {
        const afterThink = cleaned.substring(thinkEndMatch.index + thinkEndMatch[0].length);
        cleaned = afterThink.trim();
    }
    const thinkStartMatch = cleaned.match(/<think[^>]*>/i);
    if (thinkStartMatch) {
        const beforeThink = cleaned.substring(0, thinkStartMatch.index);
        cleaned = beforeThink.trim();
    }
    cleaned = cleaned.replace(/^```json\s*/i, '');
    cleaned = cleaned.replace(/^```\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/i, '');
    cleaned = formatSummaryItems(cleaned);
    cleaned = cleaned.trim();
    return cleaned;
}
function formatSummaryItems(content) {
    let cleaned = content;
    cleaned = cleaned.replace(/^\s*\n+/gm, '\n');
    cleaned = cleaned.trim();
    return cleaned;
}
function normalizeLineTags(line) {
    const trimmed = (line || '').trim();
    if (!trimmed)
        return '';
    // Accept:
    // - "bugfix perf ..." (or separated by ':' '/' '|')
    // - "`bugfix` `perf` ..." (already normalized)
    let rest = trimmed;
    const tags = new Set();
    const take = (t) => tags.add(t);
    while (true) {
        const m = rest.match(/^(`?(feature|bugfix|other|perf)`?)([\s/:|]+)(.*)$/i);
        if (!m)
            break;
        take(m[2].toLowerCase());
        rest = (m[4] || '').trim();
    }
    // also detect tags already present in-line
    if (rest.includes('`feature`'))
        tags.add('feature');
    if (rest.includes('`bugfix`'))
        tags.add('bugfix');
    if (rest.includes('`other`'))
        tags.add('other');
    if (rest.includes('`perf`'))
        tags.add('perf');
    // enforce mutual exclusivity among {feature, bugfix, other}
    const mainType = tags.has('feature') ? 'feature' : tags.has('bugfix') ? 'bugfix' : 'other';
    const hasPerf = tags.has('perf');
    // strip any stray type tags already in text, we'll re-add cleanly
    rest = rest
        .replace(/`(feature|bugfix|other)`\s*/g, '')
        .replace(/`perf`\s*/g, '')
        .trim();
    const label = `${hasPerf ? '`perf` ' : ''}\`${mainType}\``.trim();
    return `${label} ${rest}`.trim();
}
// 模型很容易把每条都写成「…。该改动重要在于…；点评：…」这种填空句，整篇一个骨架，
// 读起来极其疲劳。提示词里已明令禁止，这里再兜底剥掉残留的固定句式与空泛评价。
const BOILERPLATE_REWRITES = [
    [/(该|此|本次|这一)?改动(的)?(重要|意义|价值)(性)?(在于|是)[：:，,]?\s*/g, ''],
    [/(重要|意义|关键)(在于|是)[：:，,]?\s*/g, ''],
    [/[；;，,]?\s*点评[：:]\s*/g, '；'],
    [/(值得|建议)(持续|重点)?关注[。，,；;]?/g, ''],
    [/(整体)?风险(较|很|也)?低[。，,；;]?/g, ''],
    [/属于[^。；;]{0,20}的(改进|增强|维护|投入|补充|提升)[。，,；;]?/g, ''],
    [/无突出(的)?(性能|特性|功能)[^。；;]{0,20}[。，,；;]?/g, ''],
];
function stripBoilerplate(block) {
    let out = block || '';
    for (const [re, to] of BOILERPLATE_REWRITES)
        out = out.replace(re, to);
    return out
        // 剥掉固定句式后常留下重复标点/悬空空格，这里收口
        .replace(/[。；;]\s*[。；;，,]/g, '。')
        .replace(/[（(]\s*[）)]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([。，,；;：:）)])/g, '$1');
}
function normalizeSummaryTagLines(block) {
    return (block || '')
        .split('\n')
        .map(line => {
        const m = line.match(/^(\s*[-*]\s+)(.*)$/);
        if (m)
            return `${m[1]}${normalizeLineTags(m[2])}`;
        return normalizeLineTags(line);
    })
        .join('\n')
        .trim();
}
function normalizeOneItemPerLine(block) {
    const rawLines = (block || '').split('\n');
    const out = [];
    const splitIfMultipleLinks = (line) => {
        const t = line.trim();
        if (!t)
            return [];
        // If a single line contains multiple patch links, split after each link.
        // Example: "... [↗](https://...) ... [↗](https://...)"
        // (Backward compatible: also accepts [🔗](...))
        const linkRe = /\[(?:↗|🔗)\]\([^\)]+\)/g;
        const matches = Array.from(t.matchAll(linkRe));
        if (matches.length <= 1)
            return [t];
        const parts = [];
        let start = 0;
        for (const m of matches) {
            const end = (m.index || 0) + m[0].length;
            const chunk = t.slice(start, end).trim();
            if (chunk)
                parts.push(chunk);
            start = end;
        }
        const tail = t.slice(start).trim();
        if (tail) {
            // attach tail to last item if it doesn't start a new item
            parts[parts.length - 1] = `${parts[parts.length - 1]} ${tail}`.trim();
        }
        return parts;
    };
    const startsNewItem = (s) => {
        const t = s.trim();
        if (!t)
            return false;
        return (t.startsWith('- ') ||
            t.startsWith('* ') ||
            t.startsWith('`feature`') ||
            t.startsWith('`bugfix`') ||
            t.startsWith('`other`') ||
            t.startsWith('`perf`'));
    };
    for (const line of rawLines) {
        for (const piece of splitIfMultipleLinks(line)) {
            const t = piece.trim();
            if (!t)
                continue;
            if (out.length === 0) {
                out.push(t);
                continue;
            }
            if (startsNewItem(t)) {
                out.push(t);
                continue;
            }
            out[out.length - 1] = `${out[out.length - 1]} ${t}`.trim();
        }
    }
    return out
        .map(l => {
        const t = l.trim();
        if (t.startsWith('- ') || t.startsWith('* '))
            return t;
        return `- ${t}`;
    })
        .join('\n')
        .trim();
}
function extractTags(line) {
    const tags = new Set();
    const rx = /`(feature|bugfix|other|perf)`/g;
    let m;
    while ((m = rx.exec(line)) !== null)
        tags.add(m[1]);
    return {
        hasPerf: tags.has('perf'),
        type: tags.has('feature') ? 'feature' : tags.has('bugfix') ? 'bugfix' : 'other',
    };
}
function extractLinks(line) {
    const out = [];
    const rx = /\[(?:↗|🔗)\]\(([^)]+)\)/g;
    let m;
    while ((m = rx.exec(line)) !== null)
        out.push(m[1]);
    return out;
}
// 条目类型/perf 在抓取阶段已由规则算好（并随输入行的 type=/tag= 字段一并传给模型），
// 但模型偶尔会漏写这些标签。normalizeLineTags 对无标签的行兜底判定为 `other`，
// 一旦整段标签缺失，reorderAndCollapseSubsystemLines 就会误判为「全是次要改动」并
// 折叠成一行链接，把描述文本全部丢掉（曾导致 Networking 87 条 patch 退化成 1 行）。
// 这里按行内链接回查来源文章，直接用规则结果覆盖模型标签；匹配不到的行才保留模型判断。
function applySourceTags(block, articles) {
    const byUrl = new Map();
    for (const a of articles) {
        const url = a.patchData?.url || a.gitCommitData?.url || a.url;
        if (!url)
            continue;
        const title = a.patchData?.title || a.gitCommitData?.title || a.title;
        const content = a.patchData?.content || a.gitCommitData?.content || a.content || '';
        byUrl.set(url, { type: getArticleType(a), perf: detectPerfRelated(patchSignalText(title, content)) });
    }
    return (block || '')
        .split('\n')
        .map(line => {
        const m = line.match(/^(\s*[-*]\s+)(.*)$/);
        if (!m)
            return line;
        const source = extractLinks(m[2])
            .map(u => byUrl.get(u))
            .find(Boolean);
        if (!source)
            return line;
        const text = m[2]
            .replace(/^(`?(feature|bugfix|other|perf)`?[\s/:|]+)+/i, '')
            .replace(/`(feature|bugfix|other)`\s*/g, '')
            .replace(/`perf`\s*/g, '')
            .trim();
        const label = `${source.perf ? '`perf` ' : ''}\`${source.type}\``;
        return `${m[1]}${label} ${text}`;
    })
        .join('\n')
        .trim();
}
// 全段均为 `other` 且条目足够多时，说明该子系统当天确实只有次要改动，
// 折叠成一行概览避免刷屏；条目不多时保留原描述，不做折叠。
const COLLAPSE_OTHER_MIN_ITEMS = 6;
// 单个子系统逐条展开的上限，超出的部分折成一行「另有 N 项」。
const DEFAULT_SUBSYSTEM_MAX_ITEMS = 10;
// 折叠行里最多挂多少个链接，太多就只是刷屏。
const MAX_FOLDED_LINKS = 12;
function renderLinks(links) {
    const uniq = [];
    for (const u of links) {
        if (u && !uniq.includes(u))
            uniq.push(u);
    }
    const shown = uniq.slice(0, MAX_FOLDED_LINKS);
    const suffix = uniq.length > shown.length ? ` 等 ${uniq.length} 项` : '';
    return `${shown.map(u => `[↗](${u})`).join(' ')}${suffix}`;
}
// 单个子系统里最多展开几条「具体设备驱动」条目；超出的折进「另有 N 项」，
// 避免具体驱动把驱动框架/核心改动挤出详情区。
const MAX_SPECIFIC_DRIVER_ITEMS = 2;
function reorderAndCollapseSubsystemLines(block, maxItems = DEFAULT_SUBSYSTEM_MAX_ITEMS, priorityByUrl) {
    const lines = (block || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    const items = lines.map((l, idx) => {
        const text = l.replace(/^[-*]\s+/, '').trim();
        const tags = extractTags(text);
        const links = extractLinks(text);
        const linkInfos = links
            .map(u => priorityByUrl?.get(u))
            .filter((x) => Boolean(x));
        // 找不到来源文章时（链接不匹配），退回按标签估算，保证排序仍然稳定
        const fallbackScore = tags.hasPerf ? 40 : tags.type === 'feature' ? 30 : tags.type === 'other' ? 10 : 0;
        const score = linkInfos.length > 0 ? Math.max(...linkInfos.map(i => i.score)) : fallbackScore;
        // 同一行有多个链接时，只要有一个不是具体驱动，就按非具体驱动处理
        const driverScope = linkInfos.length > 0 && linkInfos.every(i => i.driverScope === 'specific')
            ? 'specific'
            : 'none';
        return { raw: text, ...tags, links, idx, score, driverScope };
    });
    // 排序即优先级：分数来自来源文章（arm64/x86、性能/功能重构、驱动框架加权；
    // 其他架构、bugfix、具体设备驱动降权）。超出上限的尾部会被折叠，因此必须先按分数排。
    items.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const otherItems = items.filter(i => i.type === 'other');
    const nonOther = items.filter(i => i.type !== 'other');
    // 全是次要改动且条目足够多：整块折成一行，一个描述都不展开。
    if (nonOther.length === 0 && otherItems.length >= COLLAPSE_OTHER_MIN_ITEMS) {
        return (`- \`other\` 本日另有 ${otherItems.length} 项次要改动（清理、文档、小修正等），详见：` +
            renderLinks(otherItems.flatMap(i => i.links))).trim();
    }
    const limit = Math.max(1, maxItems);
    // 具体设备驱动永远排在最后，且最多展开 MAX_SPECIFIC_DRIVER_ITEMS 条；
    // 驱动框架/核心代码优先占满名额。
    const nonSpecific = items.filter(i => i.driverScope !== 'specific');
    const specific = items.filter(i => i.driverScope === 'specific');
    const keptNonSpecific = nonSpecific.slice(0, limit);
    const specificBudget = Math.max(0, limit - keptNonSpecific.length);
    const keptSpecific = specific.slice(0, Math.min(MAX_SPECIFIC_DRIVER_ITEMS, specificBudget));
    const kept = [...keptNonSpecific, ...keptSpecific];
    const keptSet = new Set(kept);
    const folded = items.filter(i => !keptSet.has(i));
    const outLines = kept.map(it => `- ${it.raw}`);
    if (folded.length > 0) {
        // 折叠行只留纯事实：多少项 + 链接，不做任何评价
        outLines.push(`- 另有 ${folded.length} 项改动，详见：${renderLinks(folded.flatMap(i => i.links))}`.trim());
    }
    return outLines.join('\n').trim();
}
// `feature` 是当天的基线，绝大多数条目都是它——逐条打标等于没打标，反而把真正需要一眼看到的
// `perf` / `bugfix` 淹掉。这里在排序/折叠都完成之后，只去掉 `feature` 标记，
// 保留 `perf`、`bugfix` 与表示「次要改动」的 `other`。
// 只认行首那一串带反引号的标记（`perf` `feature` ...），避免误删正文里的 "feature" 一词。
const LEADING_TAG_RUN_RE = /^(?:`(?:feature|bugfix|other|perf)`[\s:：|]*)+/i;
function dropFeatureLabels(block) {
    return (block || '')
        .split('\n')
        .map(line => {
        const m = line.match(/^(\s*[-*]\s+)?(.*)$/);
        if (!m)
            return line;
        const prefix = m[1] || '';
        const rest = (m[2] || '')
            .replace(LEADING_TAG_RUN_RE, run => run.replace(/`feature`[\s:：|]*/gi, ''))
            .trim();
        if (!rest)
            return line;
        return `${prefix}${rest}`;
    })
        .join('\n')
        .trim();
}
function computeArticleDateRange(articles) {
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (const a of articles) {
        const raw = a.patchData?.date || a.gitCommitData?.date || a.fetchedAt;
        if (!raw)
            continue;
        const ts = new Date(raw).getTime();
        if (Number.isNaN(ts))
            continue;
        if (ts < minTs)
            minTs = ts;
        if (ts > maxTs)
            maxTs = ts;
    }
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs))
        return '';
    const fmt = (ts) => new Date(ts)
        .toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
        .replace(/\//g, '-')
        .replace(/\s/g, '');
    return `${fmt(minTs)} ~ ${fmt(maxTs)}`;
}
function lkmlAnchorFragmentId(articleId) {
    return `lkml-${articleId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function withRetry(operation, operationName) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[AI] ${operationName} - 尝试 ${attempt}/${MAX_RETRIES}`);
            const startTime = Date.now();
            const result = await operation();
            const duration = Date.now() - startTime;
            console.log(`[AI] ${operationName} - 成功 (耗时: ${duration}ms)`);
            return result;
        }
        catch (error) {
            lastError = error;
            console.error(`[AI] ${operationName} - 失败 (尝试 ${attempt}/${MAX_RETRIES}):`, error.message);
            if (error.status === 429) {
                console.log('[AI] 遇到限流，等待后重试...');
                await sleep(RETRY_DELAY * attempt * 2);
            }
            else if (error.status === 401) {
                console.error('[AI] API Key 无效，请检查配置');
                throw error;
            }
            else if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY);
            }
        }
    }
    throw lastError;
}
async function generateCategorySummary(articles, type, customPrompt) {
    if (articles.length === 0)
        return '';
    const typeLabel = type === 'feature' ? 'Feature' : 'Bugfix';
    const articlesWithLinks = articles
        .slice(0, 30)
        .map(a => {
        const anchorId = `lkml-${a.id}`;
        return `- [${a.title}](#${anchorId})`;
    })
        .join('\n');
    const defaultPrompt = `你是 Linux 内核开发专家。请分析以下${typeLabel}类补丁并输出总结。

要求：
- 用 Markdown 列表输出关键信息
- 每个列表项以 1 个语义匹配的 emoji 开头
- 每条总结必须包含补丁链接，链接统一放在该行最后，格式如 [标题](#lkml-xxx)
- 至少 3 条总结

限制：用中文回复，不要输出思考过程，不要输出"今日社区动态"、"总体评价"等标题，不要逐条罗列补丁标题。`;
    const prompt = customPrompt || defaultPrompt;
    const messages = [
        { role: 'system', content: prompt },
        {
            role: 'user',
            content: `请分析以下${typeLabel}类补丁：\n\n${articlesWithLinks}`,
        },
    ];
    const result = await withRetry(async () => {
        return await openai.chat.completions.create({
            model: config.openai.model,
            messages,
            max_tokens: config.openai.maxTokens,
            temperature: 0.7,
        });
    }, `生成${typeLabel}摘要`);
    const rawContent = result.choices[0]?.message?.content || '';
    let summary = cleanAIResponse(rawContent);
    summary = summary.replace(/^###\s*(今日社区动态|总体评价|本周合并动态|合并评价|Feature类补丁分析|总结|Bugfix类补丁分析)\s*$/gim, '');
    summary = summary.replace(/^###\s*总体评价[\s\S]*$/gim, '');
    summary = summary.replace(/^###\s*合并评价[\s\S]*$/gim, '');
    summary = summary.replace(/^\s*\n+/gm, '\n');
    summary = summary.trim();
    return summary;
}
// 类型/perf 判定只看标题与 commit message 正文：传给模型的 content 里还拼着「修改的文件」
// 列表，而 LKML 页面上没有 diff 时它甚至可能是整段 patch。拿全文去匹配关键词会大量误标
// （例如 `\b(qps|pps|fps)\b` 命中了无关缩写，把一块 RGB LED 驱动标成 perf）。
function patchSignalText(title, content) {
    const head = (content || '').split(/\n修改的文件[:：]/)[0];
    const idx = head.indexOf('Commit message:');
    return `${title}\n${idx >= 0 ? head.slice(idx + 'Commit message:'.length) : head}`.trim();
}
function detectPerfRelated(text) {
    const lower = (text || '').toLowerCase();
    if (!lower)
        return false;
    return (/\bperf(ormance)?\b/.test(lower) ||
        /\b(latency|throughput|qps|pps|fps)\b/.test(lower) ||
        /\b(optimi[sz]e|faster|speed( up)?|slow|overhead)\b/.test(lower) ||
        /\b(scales?|scalability|contention)\b/.test(lower) ||
        /\bbenchmark|micro-?optim(ization)?\b/.test(lower) ||
        /reduce\s+(cpu|cycles|overhead|latency)/.test(lower));
}
const ARCH64_TITLE_KEYS = new Set(['arm64', 'aarch64']);
const X86_TITLE_KEYS = new Set(['x86', 'x86_64', 'amd64']);
const OTHER_ARCH_TITLE_KEYS = new Set([
    'arm', 'riscv', 'powerpc', 'ppc', 'ppc64', 'mips', 's390', 'loongarch', 'parisc',
    'sparc', 'ia64', 'alpha', 'm68k', 'openrisc', 'nios2', 'hexagon', 'arc', 'csky',
    'xtensa', 'microblaze', 'um',
]);
// 标题前缀（如 "arm64: mm: ..."、"riscv: ..."）在 cover letter 没有 changedFiles 时兜底。
const ARCH_TITLE_PREFIX_RE = /^(?:\s*\[[^\]]*\]\s*)*(arm64|aarch64|x86_64|x86|amd64|arm|riscv|powerpc|ppc(?:64)?|mips|s390|loongarch|parisc|sparc|ia64|alpha|m68k|openrisc|nios2|hexagon|arc|csky|xtensa|microblaze|um)\s*:/i;
function normalizeRepoPath(p) {
    return (p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
function detectArchScope(title, files) {
    let scope = '';
    for (const raw of files || []) {
        const f = normalizeRepoPath(raw);
        if (/^arch\/arm64\//i.test(f))
            return 'arm64';
        if (/^arch\/x86\//i.test(f))
            return 'x86';
        if (/^arch\/[A-Za-z0-9_-]+\//i.test(f))
            scope = 'other';
    }
    const m = (title || '').match(ARCH_TITLE_PREFIX_RE);
    if (!m)
        return scope;
    const key = m[1].toLowerCase();
    if (scope === 'other')
        return 'other'; // changedFiles 比标题前缀更可信
    if (ARCH64_TITLE_KEYS.has(key))
        return 'arm64';
    if (X86_TITLE_KEYS.has(key))
        return 'x86';
    if (OTHER_ARCH_TITLE_KEYS.has(key))
        return 'other';
    return scope;
}
// 驱动框架层文件：各子系统 core/class/bus 实现、总线/OF/ACPI/DMA/PCI core 等。
// 具体型号驱动（drivers/gpu/drm/amd、drivers/net/ethernet/intel、drivers/iio/adc/... 等）
// 不在此列表中，会被当作 specific 大幅降权。
const DRIVER_FRAMEWORK_PATH_RES = [
    // drivers/<subsys>/{core,class,bus,framework,subsys}/ 下的核心实现
    /^drivers\/[^/]+\/(?:core|class|bus|framework|subsys)\//i,
    // drivers/<subsys>/<name>{-core,-class,-bus,-framework}.c
    /^drivers\/[^/]+\/(?:[^/]*-)?(?:core|class|bus|framework|subsys)\.c$/i,
    /^drivers\/base\//i,
    /^drivers\/bus\//i,
    /^drivers\/of\//i,
    /^drivers\/virtio\//i,
    /^drivers\/pci\/[^/]+\.c$/i,
    /^drivers\/pci\/endpoint\//i,
    /^drivers\/dma\/(?:dmaengine|of-dma|acpi-dma|dma-direct|dma-ops|virt-dma|dma-mapping)\.c$/i,
    /^drivers\/i2c\/i2c-core/i,
    /^drivers\/gpio\/gpiolib/i,
    /^drivers\/spi\/spi\.c$/i,
    /^drivers\/tty\/tty_/i,
    /^drivers\/tty\/serial\/serial_core\.c$/i,
    /^drivers\/usb\/core\//i,
    /^drivers\/usb\/gadget\/(?:udc\/core|configfs)\.c$/i,
    /^drivers\/mmc\/core\//i,
    /^drivers\/gpu\/drm\/drm_[^/]*\.c$/i,
    /^drivers\/gpu\/drm\/(?:ttm|gpu_sched|scheduler|display)\//i,
    /^drivers\/iio\/industrialio/i,
    /^drivers\/regulator\/(?:core|devres|of_regulator|helpers)\.c$/i,
    /^drivers\/clk\/[^/]+\.c$/i,
    /^drivers\/thermal\/thermal_(?:core|sysfs|helpers|netlink|hwmon)\.c$/i,
    /^drivers\/power\/supply\/power_supply_(?:core|sysfs|leds)\.c$/i,
    /^drivers\/leds\/led-(?:core|class|class-flash|triggers)\.c$/i,
    /^drivers\/hid\/hid-(?:core|raw|debug)\.c$/i,
    /^drivers\/input\/[^/]+\.c$/i,
    /^drivers\/mfd\/mf-core\.c$/i,
    /^drivers\/i3c\/(?:master|device|i3c)\.c$/i,
    /^drivers\/interconnect\/core\.c$/i,
    /^drivers\/reset\/core\.c$/i,
    /^drivers\/phy\/phy-core\.c$/i,
    /^drivers\/pwm\/core\.c$/i,
    /^drivers\/rtc\/(?:class|interface|lib|rtc-proc|rtc-sysfs)\.c$/i,
    /^drivers\/devfreq\/(?:devfreq|devfreq-event|governor_[^/]+)\.c$/i,
    /^drivers\/opp\//i,
    /^drivers\/pmdomain\/(?:core|governor[^/]*)\.c$/i,
    /^drivers\/dma-buf\//i,
    /^drivers\/iommu\/(?:iommu|iova|io-pgtable|dma-iommu)\.c$/i,
    /^drivers\/mailbox\/mailbox\.c$/i,
    /^drivers\/rpmsg\/rpmsg_(?:core|internal)\.c$/i,
    /^drivers\/remoteproc\/remoteproc_(?:core|sysfs|virtio|debugfs|elf_loader|internal)\.c$/i,
    /^drivers\/extcon\/extcon\.c$/i,
    /^drivers\/nvmem\/core\.c$/i,
    /^drivers\/slimbus\/(?:slimbus|slimbus-core)\.c$/i,
    /^drivers\/soundwire\/(?:bus|master|slave|stream|sysfs|irq)\.c$/i,
    /^drivers\/watchdog\/watchdog_(?:core|dev|pretimeout|hrtimer)\.c$/i,
    /^sound\/core\//i,
    /^sound\/soc\/soc-[^/]*\.c$/i,
];
function detectDriverScope(files) {
    const normalized = (files || []).map(normalizeRepoPath).filter(Boolean);
    const driverCode = normalized.filter(f => /^(?:drivers|sound)\//i.test(f) && /\.(?:c|h|S)$/i.test(f));
    if (driverCode.length === 0)
        return 'none';
    if (driverCode.some(f => DRIVER_FRAMEWORK_PATH_RES.some(re => re.test(f)))) {
        return 'framework';
    }
    // 同时改动 net/、mm/、include/ 等非驱动代码的，属于跨层改动，不做「具体驱动」降权。
    // dts/dtsi 也算非驱动代码：SoC/板级支持通常同时改 arch/<arch>/boot/dts 与 drivers/soc，
    // 不应被当成纯具体驱动。
    const otherCode = normalized.filter(f => !/^(?:drivers|sound)\//i.test(f) && /\.(?:c|h|S|dts|dtsi)$/i.test(f));
    return otherCode.length > 0 ? 'none' : 'specific';
}
const REFACTOR_RE = /\b(?:refactor(?:ed|ing|s)?|restructur(?:e|ed|ing)|rework(?:ed|ing)?|consolidat(?:e|ed|ing)|reorganiz(?:e|ed|ing)|deduplicat(?:e|ed|ing)|simplif(?:y|ied|ies)|clean\s?up)\b/i;
function detectRefactorRelated(text) {
    return REFACTOR_RE.test(text || '');
}
// 影响面大的安全修复，允许在「bugfix 降权」之外小幅回升。
const SECURITY_RE = /\b(?:cve-\d{4}-\d+|security|vulnerab\w*|use[-\s]after[-\s]free|\buaf\b|out[-\s]of[-\s]bounds|privilege escalation|information leak)\b|漏洞|安全|越界|提权/i;
function detectSecurityRelated(text) {
    return SECURITY_RE.test(text || '');
}
// 影响范围：文件数越多、改到公共头文件或核心目录，优先级略高。
function detectImpactBonus(files) {
    const normalized = (files || []).map(normalizeRepoPath).filter(Boolean);
    const n = normalized.length;
    let bonus = n >= 10 ? 6 : n >= 5 ? 4 : n >= 2 ? 2 : 0;
    if (normalized.some(f => /^include\/(?:uapi\/linux|linux|asm-generic)\//i.test(f)))
        bonus += 3;
    if (normalized.some(f => /^(?:kernel|mm|fs|net|security|block|io_uring|virt|ipc|lib)\/[^/]+$/i.test(f))) {
        bonus += 2;
    }
    return Math.min(bonus, 10);
}
function analyzeArticlePriority(a) {
    const title = a.patchData?.title || a.gitCommitData?.title || a.title;
    const content = a.patchData?.content || a.gitCommitData?.content || a.content || '';
    const files = a.patchData?.changedFiles || a.gitCommitData?.files || [];
    const type = getArticleType(a);
    const signal = patchSignalText(title, content);
    const perf = detectPerfRelated(signal);
    const refactor = detectRefactorRelated(signal);
    const security = detectSecurityRelated(signal);
    let category;
    let score;
    if (perf) {
        category = 'perf';
        score = 40;
    }
    else if (type === 'feature') {
        category = 'feature';
        score = 30;
    }
    else if (refactor) {
        category = 'refactor';
        score = 25;
    }
    else if (type === 'other') {
        category = 'other';
        score = 10;
    }
    else {
        category = 'bugfix';
        score = 0;
    }
    const arch = detectArchScope(title, files);
    if (arch === 'arm64' || arch === 'x86') {
        // arm64/x86 的特性和性能改动优先；同架构的 bugfix 也比其他架构更值得看
        score += category === 'bugfix' ? 12 : 30;
    }
    else if (arch === 'other') {
        // 仍高于具体驱动改动与大部分 bugfix，但低于 arm64/x86 与核心子系统
        score -= 15;
    }
    const driverScope = detectDriverScope(files);
    if (driverScope === 'framework')
        score += 25;
    else if (driverScope === 'specific')
        score -= 50;
    if (security)
        score += 10;
    score += detectImpactBonus(files);
    return { score, arch, driverScope, category };
}
function scoreArticlePriority(a) {
    return analyzeArticlePriority(a).score;
}
function buildArticlePriorityByUrl(articles) {
    const out = new Map();
    for (const a of articles) {
        const { score, driverScope } = analyzeArticlePriority(a);
        for (const url of [a.patchData?.url, a.gitCommitData?.url, a.url]) {
            if (!url)
                continue;
            const prev = out.get(url);
            if (!prev || score > prev.score)
                out.set(url, { score, driverScope });
        }
    }
    return out;
}
// 子系统级优先级：最强条目 + 高优先级条目数量（影响面），用于详情小节和总览的排序。
function scoreSubsystemPriority(articles) {
    if (!articles.length)
        return 0;
    const scores = articles.map(scoreArticlePriority).sort((a, b) => b - a);
    return scores[0] + Math.min(scores.filter(s => s >= 25).length, 8);
}
function getArticleType(a) {
    const t = (a.patchData?.type || a.gitCommitData?.type);
    if (t === 'feature' || t === 'bugfix' || t === 'other')
        return t;
    return 'other';
}
function getArticleSubsystem(a) {
    const existing = (a.patchData?.subsystem || a.gitCommitData?.subsystem || '');
    return existing || '';
}
function buildSubsystemInputLines(articles) {
    const lines = [];
    for (const a of articles) {
        const t = getArticleType(a);
        const title = a.patchData?.title || a.gitCommitData?.title || a.title;
        const author = a.patchData?.author || a.gitCommitData?.author || a.author || '';
        const date = a.patchData?.date || a.gitCommitData?.date || a.fetchedAt || '';
        const files = a.patchData?.changedFiles || a.gitCommitData?.files || [];
        const content = a.patchData?.content || a.gitCommitData?.content || a.content || '';
        const perf = detectPerfRelated(patchSignalText(title, content)) ? 'perf' : '';
        const url = a.patchData?.url || a.gitCommitData?.url || a.url || `#${lkmlAnchorFragmentId(a.id)}`;
        const filesShort = files.length > 0 ? files.slice(0, 12).join(', ') + (files.length > 12 ? ', ...' : '') : '';
        lines.push([
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
            .join(' | '));
    }
    return lines.join('\n');
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const out = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
        while (true) {
            const idx = nextIndex++;
            if (idx >= items.length)
                break;
            out[idx] = await mapper(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}
async function summarizeSubsystem(subsystem, subsystemArticles, prompt, maxItems) {
    const defaultPrompt = '你是 Linux 内核开发专家。现在只分析单个子系统下的补丁/提交动态。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 逐条输出该子系统的具体改动，每条单独一行；一个补丁/提交一条，不要合并成一条\n- 每条控制在 80 字以内，只说清「改了什么 + 带来什么影响或收益」\n- 每条必须包含：`feature`/`bugfix`/`other` 标记；若为性能优化/性能相关需额外标注 `perf`\n- 每条行末必须包含补丁/提交的原始链接，格式为 [↗](https://...)\n' +
        '- 子系统内按重要程度从高到低输出：arm64/x86 架构相关的性能/功能/重构 > 其他子系统的性能/功能/重构 > 其他架构改动 > `bugfix` > 具体设备驱动（非驱动框架）\n' +
        '- 驱动类改动优先保留驱动框架层（driver core、OF/ACPI、bus、DMA、PCI core、各子系统 core）的重构/优化；具体型号驱动的普通改动不要排在前面\n' +
        '- 不要原样复述 title，也不要写固定句式的评价：禁止「该改动重要在于」「点评：」「值得关注」「整体风险低」「属于……的改进」\n' +
        '- 除非确有兼容性、ABI 或安全风险需要提醒，不要额外加一句评价\n';
    const systemPrompt = (prompt || defaultPrompt).trim();
    // 按同一套优先级把输入排好，让模型先看到最值得关注的条目
    const orderedArticles = [...subsystemArticles].sort((a, b) => scoreArticlePriority(b) - scoreArticlePriority(a));
    const priorityByUrl = buildArticlePriorityByUrl(subsystemArticles);
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: `子系统：${subsystem}\n` +
                `补丁/提交条目如下（每行含 type/tag/link 等字段）：\n\n` +
                buildSubsystemInputLines(orderedArticles),
        },
    ];
    const result = await withRetry(async () => {
        return await openai.chat.completions.create({
            model: config.openai.model,
            messages,
            max_tokens: config.openai.maxTokens,
            temperature: 0.6,
        });
    }, `生成子系统摘要 - ${subsystem}`);
    const rawContent = result.choices[0]?.message?.content || '';
    const normalized = normalizeOneItemPerLine(normalizeSummaryTagLines(stripBoilerplate(cleanAIResponse(rawContent)))).trim();
    const tagged = applySourceTags(normalized, subsystemArticles);
    const ordered = reorderAndCollapseSubsystemLines(tagged, maxItems, priorityByUrl);
    return dropFeatureLabels(ordered);
}
// Make subsystem names clickable to jump to corresponding detail blocks.
// Frontend cards use: id="subsystem-${encodeURIComponent(title)}"
function wrapSubsystemLinks(cleaned, subsystems) {
    const toId = (name) => `#subsystem-${encodeURIComponent(name)}`;
    const lines = cleaned.split('\n').map(l => l.trimEnd());
    const out = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t)
            continue;
        // only rewrite list items; keep others untouched
        const m = t.match(/^([-*]\s+)(.*)$/);
        if (!m) {
            out.push(t);
            continue;
        }
        const prefix = m[1];
        let rest = m[2];
        // If already has a markdown link for a subsystem, don't double-wrap.
        if (/\[[^\]]+\]\(#subsystem-/.test(rest)) {
            out.push(`${prefix}${rest}`);
            continue;
        }
        // 新格式：行末的 （<子系统>）；旧格式：行首的 <图标> <子系统>：
        // 两种都做链接化，保证自定义 overallPrompt 用旧格式时也不会退化。
        // 同一行可能两种都出现（模型偶尔两头都写），所以不提前 break。
        for (const s of subsystems) {
            const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const colonRe = new RegExp(`(^|\\s)(${esc})(\\s*：)`);
            const parenRe = new RegExp(`([（(])\\s*(${esc})\\s*([）)])`);
            let hit = false;
            if (colonRe.test(rest)) {
                rest = rest.replace(colonRe, (_all, p1, p2, p3) => `${p1}[${p2}](${toId(s)})${p3}`);
                hit = true;
            }
            if (parenRe.test(rest)) {
                rest = rest.replace(parenRe, (_all, p1, p2, p3) => `${p1}[${p2}](${toId(s)})${p3}`);
                hit = true;
            }
            if (hit)
                break;
        }
        out.push(`${prefix}${rest}`);
    }
    return out;
}
// 拆分总览行，兼容两种格式：
//   旧：`- 🧠 [Memory](#subsystem-Memory)：正文`      -> { label: '🧠 Memory', body: '正文' }
//   新：`- ⚡ 正文（[Memory](#subsystem-Memory)）`      -> { label: 'Memory', body: '⚡ 正文' }
// 新格式只在括号内容确实是已知子系统时才当标签，避免把正文里的普通括号误判成子系统。
function splitOverviewLine(line, subsystems = []) {
    const t = (line || '').trim().replace(/^[-*]\s+/, '');
    const plain = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '');
    const paren = plain.match(/^(.*?)[（(]\s*([^（）()]{1,40}?)\s*[）)]\s*$/);
    if (paren && subsystems.includes(paren[2])) {
        return { label: paren[2], body: paren[1].trim() };
    }
    const idx = plain.search(/[：:]/);
    if (idx < 0)
        return { label: '', body: plain.trim() };
    return { label: plain.slice(0, idx).trim(), body: plain.slice(idx + 1).trim() };
}
// 模型对当天只有清理/注释/配置/小修正的子系统，常写「以清理、配置更新和小修复为主，
// 无突出性能或特性变更，风险低」这类套话。这类行没体现任何具体动态，总览里直接不展示。
// 为保守起见，仅当正文命中套话、且不含英文标识符（如 io_uring、blk-mq、XFS）时才判空。
const EMPTY_DYNAMIC_PATTERNS = [
    /无\s*(突出|重大|显著|明显|实质|值得一提)/,
    /未见\s*(显著|明显|重大|突出|实质)/,
    /未(发现|出现)\s*(显著|明显|重大|突出)/,
    /(以|多为|主要(是|为))\s*[^，。；]{0,12}(清理|注释|配置|小修正|小修复|维护)/,
    /无\s*(新特性|性能优化|功能变化|接口变化)/,
    /风险\s*(较)?低/,
    /代码卫生/,
];
const IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9_.&-]+/;
function isEmptyDynamicLine(line, subsystems = []) {
    const { body } = splitOverviewLine(line, subsystems);
    if (!body)
        return true;
    if (IDENTIFIER_RE.test(body))
        return false;
    return EMPTY_DYNAMIC_PATTERNS.some(re => re.test(body));
}
// 兜底：模型多轮后仍未收敛时，硬性压到上限内。
// 优先按篇幅比例压缩每一行，尽量让所有子系统都保留；实在压不下去才从末尾整条删减。
function enforceOverviewBudget(lines, maxChars) {
    const items = lines.filter(l => l.trim());
    if (items.length === 0)
        return [];
    if (countVisibleChars(items.join('\n')) <= maxChars)
        return items;
    let factor = maxChars / countVisibleChars(items.join('\n'));
    for (let round = 0; round < 8; round++) {
        const shrunk = items.map(item => {
            const len = countVisibleChars(item);
            const quota = Math.max(12, Math.floor(len * factor));
            return len <= quota ? item : truncateVisible(item, quota);
        });
        const total = countVisibleChars(shrunk.join('\n'));
        if (total <= maxChars)
            return shrunk;
        factor *= maxChars / total;
    }
    const out = items.slice();
    while (out.length > 1 && countVisibleChars(out.join('\n')) > maxChars)
        out.pop();
    return out;
}
// 总览行的最终排序兜底：模型负责挑选内容，这里按同一套优先级把行序钉死。
// 基线取子系统级优先级，再用行内出现的架构/类型关键词微调。
function overviewLinePriority(line, subsystemPriority, subsystems) {
    const { label, body } = splitOverviewLine(line, subsystems);
    const base = subsystemPriority.get(label) ?? 0;
    const text = body || line;
    let boost = 0;
    if (/(?:^|[^a-z0-9])(?:arm64|aarch64|x86_64|x86|amd64)(?:[^a-z0-9]|$)/i.test(text))
        boost += 20;
    if (/(?:^|[^a-z0-9])(?:riscv|powerpc|ppc|mips|s390|loongarch|sparc|parisc|m68k|arm32)(?:[^a-z0-9]|$)/i.test(text))
        boost -= 20;
    if (/(性能|吞吐|延迟|加速|perf)/i.test(text))
        boost += 12;
    if (/(重构|统一|简化|合并|整理|优化)/.test(text))
        boost += 8;
    // 安全修复属于「高影响 bugfix」，不按普通 bugfix 降权
    if (detectSecurityRelated(text))
        boost += 4;
    else if (/(修复|修正|回归|\bbug\b|\bfix(?:es|ed)?\b)/i.test(text))
        boost -= 8;
    if (/(驱动框架|driver core|核心框架|框架层|子系统\s*core)/i.test(text))
        boost += 10;
    return base * 0.6 + boost;
}
async function summarizeOverall(subsystemSummaries, prompt, maxChars = DEFAULT_SUMMARY_MAX_CHARS, priorityHints = []) {
    const defaultPrompt = '你是 Linux 内核开发专家。你将收到多个子系统的条目式总结。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 输出 Markdown 无序列表，共 3~6 条，按重要性从高到低排序\n- 每条格式固定为：<图标> <一句话>（<子系统名>），子系统名必须与输入中的「## 子系统名」完全一致\n- 跨子系统挑当天全局最值得关注的动态，不要按子系统逐个铺开\n';
    // 硬约束：直接追加到 prompt 后面，保证自定义 prompt 也生效。
    const budgetRule = `\n\n【硬约束】\n` +
        '- 全文 3~6 条，按重要性从高到低排序；宁可少于 6 条，也不要为凑数硬写\n' +
        '- 每条一句话（不超过 70 字），只讲一个动态，不要把多个改动挤进同一条\n' +
        '- 每条行末用中文括号标注子系统名，例如（Memory）；这个名字会被渲染成跳转到详情的链接，必须准确\n' +
        '- 排序与取舍按以下优先级（从高到低）：\n' +
        '  1) arm64 / x86 架构相关的性能优化、功能特性、重构\n' +
        '  2) 核心子系统的性能、功能重构与优化，以及影响面大的公共接口/ABI 改动\n' +
        '  3) 驱动框架层（driver core、OF/ACPI、bus、DMA、PCI core、各子系统 core）的优化或重构\n' +
        '  4) 其他架构（riscv/powerpc/mips/s390/loongarch/arm32 等）的改动、`bugfix`\n' +
        '- 不要收录具体设备驱动的动态（某型号 GPU/网卡/传感器/控制器驱动、板级适配等）；\n' +
        '  驱动只取框架层面的优化与重构\n' +
        '- `perf` 标记的条目按性能优化对待，即使同时带 `bugfix`\n' +
        '- 输入开头的「高优先级候选」由规则计算，优先从中挑选；若它们确实不如其他动态重要，可以不用\n' +
        '- 禁止空话：「以清理为主」「风险较低」「值得关注」「属于……的改进」等；\n' +
        '  某子系统当天没有符合上述优先级的动态就不要出现在总览里\n' +
        `- 全文不超过 ${maxChars} 字`;
    const systemPrompt = `${(prompt || defaultPrompt).trim()}${budgetRule}`;
    // 高优先级子系统先交给模型看，配合硬约束引导取舍；最终行序还会再按规则兜底排序。
    const merged = [...subsystemSummaries]
        .filter(s => s.summary.trim())
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .map(s => `## ${s.subsystem}\n${s.summary.trim()}`)
        .join('\n\n');
    const hintText = priorityHints.length > 0
        ? `【按规则计算的高优先级候选（分数越高越优先）】\n` +
            priorityHints
                .map((h, idx) => {
                const flags = [
                    h.category,
                    h.arch,
                    h.driverScope !== 'none' ? h.driverScope : '',
                ]
                    .filter(Boolean)
                    .join('/');
                return `${idx + 1}. [${h.score}] ${h.subsystem} | ${flags} | ${h.title}`;
            })
                .join('\n')
        : '';
    const userContent = [hintText, merged].filter(Boolean).join('\n\n') || '（无子系统条目）';
    const subsystems = subsystemSummaries.map(s => s.subsystem).filter(Boolean);
    const subsystemPriority = new Map(subsystemSummaries.map(s => [s.subsystem, s.priority ?? 0]));
    let lines = [];
    let droppedLabels = [];
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const retryRule = attempt === 1
            ? ''
            : `\n\n【重试】上一次输出为 ${countVisibleChars(lines.join('\n'))} 字，超出 ${maxChars} 字上限。` +
                '请大幅压缩：只保留最重要的 3 条，每条不超过 40 字，删掉所有细节与次要项。';
        const messages = [
            { role: 'system', content: `${systemPrompt}${retryRule}` },
            { role: 'user', content: userContent },
        ];
        const result = await withRetry(async () => {
            return await openai.chat.completions.create({
                model: config.openai.model,
                messages,
                max_tokens: config.openai.maxTokens,
                temperature: 0.6,
            });
        }, '生成整体点评');
        const rawContent = result.choices[0]?.message?.content || '';
        const cleaned = cleanAIResponse(rawContent).trim();
        // 丢掉「无实质动态」的占位行：这类子系统在总览里不体现（详情小节不受影响）。
        const kept = [];
        droppedLabels = [];
        for (const line of wrapSubsystemLinks(cleaned, subsystems)) {
            if (isEmptyDynamicLine(line, subsystems)) {
                droppedLabels.push(splitOverviewLine(line, subsystems).label || line.trim());
            }
            else {
                kept.push(line);
            }
        }
        // 模型可能按自己的理解排序，这里按「重点模块 > 影响范围 > bugfix/其他架构」再钉一次。
        // 同分保持模型原顺序（稳定排序）。
        lines = kept
            .map((line, idx) => ({
            line,
            idx,
            score: overviewLinePriority(line, subsystemPriority, subsystems),
        }))
            .sort((a, b) => b.score - a.score || a.idx - b.idx)
            .map(item => item.line);
        if (countVisibleChars(lines.join('\n')) <= maxChars)
            break;
    }
    const budgeted = enforceOverviewBudget(lines, maxChars);
    if (droppedLabels.length > 0) {
        console.log(`[AI] 总览省略无实质动态的子系统: ${droppedLabels.join('、')}`);
    }
    console.log(`[AI] 总览字数: ${countVisibleChars(budgeted.join('\n'))}/${maxChars}`);
    return budgeted.join('\n').trim();
}
function summarizeUnmatchedScopeLocally(unmatched) {
    const total = unmatched.length;
    const counts = new Map();
    const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
    for (const a of unmatched) {
        const files = a.patchData?.changedFiles || a.gitCommitData?.files || [];
        for (const f of files) {
            const p = (f || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
            if (!p)
                continue;
            const segs = p.split('/').filter(Boolean);
            if (segs.length === 0)
                continue;
            const area = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0];
            bump(area);
        }
    }
    const topAreas = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k]) => k);
    return { total, topAreas };
}
async function summarizeUnmatchedScopeAI(input) {
    const systemPrompt = '你是 Linux 内核开发专家。请对“未匹配到固定子系统规则”的补丁做一个非常简短的概览。\n' +
        '要求：中文；不输出思考过程；不输出标题；输出 1~2 句即可，说明大概修改范围（用给定目录分布概括）以及数量。';
    const userText = `未匹配补丁数量：${input.total}\n` +
        `目录分布（top）：${input.topAreas.length ? input.topAreas.join('、') : '（无法从 changedFiles 推断）'}\n`;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
    ];
    const result = await withRetry(async () => {
        return await openai.chat.completions.create({
            model: config.openai.model,
            messages,
            // 改为跟随 config.openai.maxTokens（原先硬编码 300，推理模型会把额度全花在
            // reasoning_content 上导致 content 返回空，Other 段静默缺失）
            max_tokens: config.openai.maxTokens,
            temperature: 0.4,
        });
    }, '生成未匹配子系统概览');
    return cleanAIResponse(result.choices[0]?.message?.content || '').trim();
}
async function generateSummary(articles, promptOrOptions) {
    if (articles.length === 0) {
        return '';
    }
    if (!config.openai.apiKey) {
        console.log('[AI] generateSummary - API Key 未配置，使用默认摘要');
        return `今日共收集到 ${articles.length} 条记录。`;
    }
    const options = typeof promptOrOptions === 'string'
        ? { summaryPrompt: promptOrOptions }
        : (promptOrOptions || {});
    const dateRange = computeArticleDateRange(articles);
    const model = config.openai.model?.trim() || 'unknown';
    const bySubsystem = new Map();
    const unmatched = [];
    for (const a of articles) {
        const title = a.patchData?.title || a.gitCommitData?.title || a.title;
        const files = a.patchData?.changedFiles || a.gitCommitData?.files || [];
        // 1) 固定子系统（按配置目录规则归类）
        const fixed = (0, fixedSubsystem_1.inferFixedSubsystemFromFiles)(files, options.fixedSubsystemRules);
        // 2) 兼容：如果没有配置固定规则，则退回动态推断
        const s = options.fixedSubsystemRules ? fixed : (getArticleSubsystem(a) || (0, subsystem_1.inferKernelSubsystem)({ title, files }) || 'other');
        if (options.fixedSubsystemRules && !s) {
            unmatched.push(a);
            continue;
        }
        if (!bySubsystem.has(s))
            bySubsystem.set(s, []);
        bySubsystem.get(s).push(a);
    }
    const subsystemEntries = Array.from(bySubsystem.entries())
        .map(([subsystem, list]) => ({ subsystem, list }))
        .sort((a, b) => b.list.length - a.list.length);
    const fixedOrder = options.fixedSubsystemRules ? Object.keys(options.fixedSubsystemRules) : [];
    const orderedFixedSubsystems = fixedOrder.length > 0
        ? fixedOrder
            .map(name => ({ subsystem: name, list: bySubsystem.get(name) || [] }))
            .filter(e => e.list.length > 0)
        : [];
    const maxSubsystems = 24;
    const minItemsPerSubsystem = 2;
    const primarySubsystems = orderedFixedSubsystems.length > 0
        ? orderedFixedSubsystems
        : subsystemEntries.filter(e => e.list.length >= minItemsPerSubsystem).slice(0, maxSubsystems);
    const secondarySubsystems = orderedFixedSubsystems.length > 0
        ? []
        : subsystemEntries.filter(e => !primarySubsystems.some(p => p.subsystem === e.subsystem));
    const concurrency = Math.max(1, options.subsystemSummaryConcurrency || 6);
    console.log(`[AI] 子系统数: ${subsystemEntries.length}，参与AI总结子系统: ${primarySubsystems.length}，子系统总结并发: ${concurrency}`);
    const subsystemPriorities = new Map(primarySubsystems.map(e => [e.subsystem, scoreSubsystemPriority(e.list)]));
    console.log(`[AI] 子系统优先级: ${primarySubsystems
        .map(e => `${e.subsystem}=${subsystemPriorities.get(e.subsystem)}`)
        .join(', ')}`);
    // 给总览模型一份规则算出的候选清单：光靠子系统摘要里的标签，模型容易漏掉
    // 「perf + bugfix」或标成 other 的驱动框架重构。
    const rankedHints = primarySubsystems
        .flatMap(entry => entry.list.map(a => ({
        subsystem: entry.subsystem,
        title: a.patchData?.title || a.gitCommitData?.title || a.title,
        ...analyzeArticlePriority(a),
    })))
        .sort((a, b) => b.score - a.score);
    // 具体设备驱动不进总览，也不放进候选清单；整天的条目都是具体驱动时才退回完整列表
    const nonSpecificHints = rankedHints.filter(h => h.driverScope !== 'specific');
    const priorityHints = (nonSpecificHints.length > 0 ? nonSpecificHints : rankedHints).slice(0, 8);
    const subsystemSummaries = await mapWithConcurrency(primarySubsystems, concurrency, async (entry) => {
        const summary = await summarizeSubsystem(entry.subsystem, entry.list, options.subsystemPrompt || options.summaryPrompt, options.subsystemMaxItems);
        return {
            subsystem: entry.subsystem,
            summary,
            articleCount: entry.list.length,
            priority: subsystemPriorities.get(entry.subsystem) ?? 0,
        };
    });
    const overall = await summarizeOverall(subsystemSummaries, options.overallPrompt, options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS, priorityHints);
    const parts = [];
    parts.push(`# 今日社区动态（${model} | ${dateRange || '未知'}）`);
    parts.push('');
    parts.push(overall || `今日共收集到 ${articles.length} 条记录。`);
    // 详情区按优先级排序，而不是固定的 config 顺序或当天活跃度：
    // arm64/x86、性能/功能重构、驱动框架改动排前面；具体驱动堆满的子系统即使条目多也靠后。
    // 同优先级再按条目数，读者先看到重点板块。
    const orderedSummaries = [...subsystemSummaries].sort((a, b) => b.priority - a.priority || b.articleCount - a.articleCount);
    for (const s of orderedSummaries) {
        const body = s.summary.trim();
        if (!body)
            continue;
        parts.push('');
        parts.push(`## ${s.subsystem}`);
        parts.push(body);
    }
    if (secondarySubsystems.length > 0) {
        const total = secondarySubsystems.reduce((sum, e) => sum + e.list.length, 0);
        const totals = { feature: 0, bugfix: 0, other: 0, perf: 0 };
        for (const e of secondarySubsystems) {
            for (const a of e.list) {
                const t = getArticleType(a);
                totals[t]++;
                const title = a.patchData?.title || a.gitCommitData?.title || a.title;
                const content = a.patchData?.content || a.gitCommitData?.content || a.content || '';
                if (detectPerfRelated(patchSignalText(title, content)))
                    totals.perf++;
            }
        }
        const topNames = secondarySubsystems
            .slice(0, 6)
            .map(e => e.subsystem)
            .join('、');
        parts.push('');
        parts.push('## 其他子系统（聚合）');
        parts.push(`其余 ${secondarySubsystems.length} 个子系统共 ${total} 条改动，整体以 \`bugfix\` 与 \`other\` 为主，包含少量 \`feature\` 与 \`perf\` 相关更新。`);
        parts.push(`标签统计：\`feature\` ${totals.feature} / \`bugfix\` ${totals.bugfix} / \`other\` ${totals.other} / \`perf\` ${totals.perf}。`);
        if (topNames) {
            parts.push(`主要分布在：${topNames} 等子系统。`);
        }
    }
    if (unmatched.length > 0) {
        const totals = { feature: 0, bugfix: 0, other: 0, perf: 0 };
        for (const a of unmatched) {
            const t = getArticleType(a);
            totals[t]++;
            const title = a.patchData?.title || a.gitCommitData?.title || a.title;
            const content = a.patchData?.content || a.gitCommitData?.content || a.content || '';
            if (detectPerfRelated(patchSignalText(title, content)))
                totals.perf++;
        }
        parts.push('');
        parts.push('## Other');
        const localScope = summarizeUnmatchedScopeLocally(unmatched);
        let aiScope = '';
        try {
            aiScope = await summarizeUnmatchedScopeAI(localScope);
        }
        catch {
            aiScope = '';
        }
        if (aiScope)
            parts.push(aiScope);
        parts.push(`Unmatched by fixed subsystem rules: ${unmatched.length} items. Consider extending directory rules to improve classification.`);
        parts.push(`标签统计：\`feature\` ${totals.feature} / \`bugfix\` ${totals.bugfix} / \`other\` ${totals.other} / \`perf\` ${totals.perf}。`);
    }
    return parts.join('\n').trim();
}
// 标题形如 "wifi: iwlwifi: mvm: fix a deadlock"：先剥掉 [PATCH v2 3/5] 这类标签，再剥掉
// 任意层数的 "子系统:" 前缀，剩下的才是真正的动作描述。原先只剥一层前缀，多段前缀的补丁
// （wifi: iwlwifi: mvm: fix ...）判不出 bugfix，只能落到正文启发式，于是被误标成 feature。
function stripSubjectPrefixes(title) {
    const t = (title || '').replace(/^\s*(?:\[[^\]]*\]\s*)+/, '').trim();
    return t.replace(/^(?:[A-Za-z0-9_.+\/&-]+\s*:\s*)+/, '').trim();
}
// 正文只取首段：后面的 changelog、Signed-off-by、评审讨论里满是 add/support/enable，
// 拿它们判 feature 会把大量修复误标成新特性。
function firstParagraph(text) {
    const t = (text || '').replace(/\r/g, '').trim();
    if (!t)
        return '';
    const idx = t.search(/\n\s*\n/);
    return (idx >= 0 ? t.slice(0, idx) : t).slice(0, 800);
}
function inferPatchTypeRuleBased(title, body) {
    const subject = stripSubjectPrefixes(title);
    const lead = firstParagraph(body);
    const leadLower = lead.toLowerCase();
    const bugfixInSubject = /\b(fix|fixes|fixup|revert)\b/i.test(subject);
    // 正文里的 "fix" 出现得太泛（changelog、评审答复、后续补丁说明都会带），
    // 用它判 bugfix 会把大量新特性/整理误标，所以正文只认高置信的缺陷信号。
    const bugfixInText = /\b(fixes:|fixes\s+[0-9a-f]{7,})/.test(leadLower) ||
        /\b(data\s+race|race\s+condition|kcsan)\b/.test(leadLower) ||
        /\b(leak|memory\s+leak|refcount)\b/.test(leadLower) ||
        /\b(crash|oops|panic|null\s*deref|null\s*pointer|use[-\s]after[-\s]free|\buaf\b)\b/.test(leadLower) ||
        /\b(overflow|underflow|deadlock|hang)\b/.test(leadLower) ||
        /\b(syzbot|regression)\b/.test(leadLower);
    const featureInSubject = 
    // 剥掉前缀后只需看动作词开头，兼容：
    // 1) "[PATCH] subsys: Add ..."（带 "subsys:" 前缀）
    // 2) "[PATCH 0/N] Add support for ..."（不带前缀，尤其 cover letter 常见）
    // 3) "wifi: iwlwifi: mvm: add ..."（多段前缀）
    /^(add|adds|implement|introduce|support|enable)\b/i.test(subject) ||
        /^\s*\[patch[^\]]*\]\s*(add|adds|implement|introduce|support|enable)\b/i.test(title);
    const featureInText = 
    // 常见 feature 表述（只扫正文首段）
    /\b(add(s|ed|ing)?|introduce(s|d)?|implement(s|ed|ing)?|enable(s|d)?|support(s|ed|ing)?)\b/.test(leadLower) ||
        /\b(add(s|ing)?\s+support(\s+for)?|support\s+for)\b/.test(leadLower) ||
        /\b(expose(s|d)?|export(s|ed|ing)?|provide(s|d)?|allow(s|ed|ing)?|permit(s|ted|ting)?)\b/.test(leadLower) ||
        /\b(extend(s|ed|ing)?|expand(s|ed|ing)?|generaliz(e|es|ed|ing))\b/.test(leadLower) ||
        /\b(plumb(s|ed|ing)?|wire(s|d)?\s+up|hook(s|ed|ing)?\s+up)\b/.test(leadLower) ||
        /\b(new|initial)\s+(api|abi|interface|feature|support|infrastructure|framework|mechanism)\b/.test(leadLower);
    // 按约定的优先级：
    // 1) 动作词在标题里最可信，先判 feature 再判 bugfix
    //    （避免标题是 "Add support ..."、正文 changelog 里提到 "Fix ..." 被倒挂）
    // 2) 标题判不出时才看正文首段：先判 bugfix 再判 feature
    //    —— 正文里 "add" 的出现频率远高于 "fix"，先判 feature 会大量吞掉修复
    // 3) 都不命中才是 other
    if (featureInSubject)
        return 'feature';
    if (bugfixInSubject)
        return 'bugfix';
    if (bugfixInText)
        return 'bugfix';
    if (featureInText)
        return 'feature';
    return 'other';
}
