"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
        maxTokens: 4096
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
function reorderAndCollapseSubsystemLines(block) {
    const lines = (block || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    const items = lines.map((l, idx) => {
        const text = l.replace(/^[-*]\s+/, '').trim();
        const tags = extractTags(text);
        return { raw: text, ...tags, links: extractLinks(text), idx };
    });
    const orderType = { feature: 1, bugfix: 2, other: 3 };
    items.sort((a, b) => {
        // 子系统内严格排序：
        // 1) perf 优先
        // 2) 在 perf 组内仍保持 feature -> bugfix -> other 的相对顺序
        // 3) 非 perf 组同样 feature -> bugfix -> other
        // 4) 同组同类型保持原始顺序（稳定）
        const pa = a.hasPerf ? 0 : 1;
        const pb = b.hasPerf ? 0 : 1;
        if (pa !== pb)
            return pa - pb;
        const ta = orderType[a.type];
        const tb = orderType[b.type];
        if (ta !== tb)
            return ta - tb;
        return a.idx - b.idx;
    });
    const otherItems = items.filter(i => i.type === 'other');
    const nonOther = items.filter(i => i.type !== 'other');
    const outLines = [];
    for (const it of nonOther) {
        outLines.push(`- ${it.raw}`);
    }
    if (otherItems.length > 0) {
        const links = otherItems.flatMap(i => i.links).filter(Boolean);
        const uniqLinks = [];
        for (const u of links) {
            if (!uniqLinks.includes(u))
                uniqLinks.push(u);
        }
        const linkText = uniqLinks.map(u => `[↗](${u})`).join(' ');
        outLines.push(`- \`other\` 其他改动多为小修正、清理或配置更新，整体风险较低，详情见：${linkText}`.trim());
    }
    return outLines.join('\n').trim();
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
        const perf = detectPerfRelated(`${title}\n${content}`) ? 'perf' : '';
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
async function summarizeSubsystem(subsystem, subsystemArticles, prompt) {
    const defaultPrompt = '你是 Linux 内核开发专家。现在只分析单个子系统下的补丁/提交动态。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 逐条输出该子系统的具体改动，每条单独一行\n- 每条必须包含：`feature`/`bugfix`/`other` 标记；若为性能优化/性能相关需额外标注 `perf`\n- 每条行末必须包含补丁/提交的原始链接，格式为 [↗](https://...)\n- 不要原样复述 title；改为“做了什么/为什么重要”的描述\n';
    const systemPrompt = (prompt || defaultPrompt).trim();
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: `子系统：${subsystem}\n` +
                `补丁/提交条目如下（每行含 type/tag/link 等字段）：\n\n` +
                buildSubsystemInputLines(subsystemArticles),
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
    const normalized = normalizeOneItemPerLine(normalizeSummaryTagLines(cleanAIResponse(rawContent))).trim();
    return reorderAndCollapseSubsystemLines(normalized).trim();
}
async function summarizeOverall(subsystemSummaries, prompt) {
    const defaultPrompt = '你是 Linux 内核开发专家。你将收到多个子系统的条目式总结。\n\n输出要求：\n- 用中文\n- 不要输出思考过程\n- 不要输出任何 Markdown 标题\n- 输出 1~3 段整体点评：概括主要方向、风险点/回归风险、性能相关动向与后续关注点\n- 不要逐条重复子系统条目\n';
    const systemPrompt = (prompt || defaultPrompt).trim();
    const merged = subsystemSummaries
        .filter(s => s.summary.trim())
        .map(s => `## ${s.subsystem}\n${s.summary.trim()}`)
        .join('\n\n');
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: merged || '（无子系统条目）' },
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
    // Make subsystem names clickable to jump to corresponding detail blocks.
    // Frontend cards use: id="subsystem-${encodeURIComponent(title)}"
    const subsystems = subsystemSummaries.map(s => s.subsystem).filter(Boolean);
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
        // Replace the first matching "<icon> <subsystem>：" or "<subsystem>："
        let replaced = false;
        for (const s of subsystems) {
            const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(^|\\s)(${esc})(\\s*：)`);
            if (re.test(rest)) {
                rest = rest.replace(re, (_all, p1, p2, p3) => `${p1}[${p2}](${toId(s)})${p3}`);
                replaced = true;
                break;
            }
        }
        out.push(`${prefix}${rest}`);
        if (!replaced)
            continue;
    }
    return out.join('\n').trim();
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
            max_tokens: 300,
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
    const subsystemSummaries = await mapWithConcurrency(primarySubsystems, concurrency, async (entry) => {
        const summary = await summarizeSubsystem(entry.subsystem, entry.list, options.subsystemPrompt || options.summaryPrompt);
        return { subsystem: entry.subsystem, summary };
    });
    const overall = await summarizeOverall(subsystemSummaries, options.overallPrompt);
    const parts = [];
    parts.push(`# 今日社区动态（${model} | ${dateRange || '未知'}）`);
    parts.push('');
    parts.push(overall || `今日共收集到 ${articles.length} 条记录。`);
    for (const s of subsystemSummaries) {
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
                if (detectPerfRelated(`${title}\n${content}`))
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
            if (detectPerfRelated(`${title}\n${content}`))
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
function inferPatchTypeRuleBased(title, body) {
    const combined = `${title}\n${body}`;
    const lower = combined.toLowerCase();
    const bugfixInSubject = /\[patch[^\]]*\]\s*[^:]+:\s*(fix|fixes)\b/i.test(title) ||
        /^[^:]+:\s*(fix|fixes)\b/i.test(title.trim());
    const bugfixInText = /\b(fix(es|ed|ing)?|fixes:)\b/.test(lower) ||
        /\b(data\s+race|race\s+condition|kcsan)\b/.test(lower) ||
        /\b(leak|memory\s+leak|refcount)\b/.test(lower) ||
        /\b(crash|oops|panic|null\s*deref|null\s*pointer|use[-\s]after[-\s]free|\buaf\b)\b/.test(lower) ||
        /\b(overflow|underflow|deadlock|hang)\b/.test(lower) ||
        /\b(syzbot|regression)\b/.test(lower);
    const featureInSubject = 
    // 兼容两种常见标题风格：
    // 1) "[PATCH] subsys: Add ..."（带 "subsys:" 前缀）
    // 2) "[PATCH 0/N] Add support for ..."（不带前缀，尤其 cover letter 常见）
    /\[patch[^\]]*\]\s*[^:]+:\s*(add|adds|implement|introduce|support|enable)\b/i.test(title) ||
        /^\s*\[patch[^\]]*\]\s*(add|adds|implement|introduce|support|enable)\b/i.test(title) ||
        /^[^:]+:\s*(add|adds|implement|introduce|support|enable)\b/i.test(title.trim());
    const featureInText = 
    // 常见 feature 表述（更偏 commit message）
    /\b(add(s|ed|ing)?|introduce(s|d)?|implement(s|ed|ing)?|enable(s|d)?|support(s|ed|ing)?)\b/.test(lower) ||
        /\b(add(s|ing)?\s+support(\s+for)?|support\s+for)\b/.test(lower) ||
        /\b(expose(s|d)?|export(s|ed|ing)?|provide(s|d)?|allow(s|ed|ing)?|permit(s|ted|ting)?)\b/.test(lower) ||
        /\b(extend(s|ed|ing)?|expand(s|ed|ing)?|generaliz(e|es|ed|ing))\b/.test(lower) ||
        /\b(plumb(s|ed|ing)?|wire(s|d)?\s+up|hook(s|ed|ing)?\s+up)\b/.test(lower) ||
        /\b(new|initial)\s+(api|abi|interface|feature|support|infrastructure|framework|mechanism)\b/.test(lower);
    // 按约定的优先级：
    // 1) 标题先判 feature，再判 bugfix
    // 2) 标题若为 other，则进入 commit message：先判 feature，再判 bugfix
    // 3) 都不命中才是 other
    //
    // 这样可以避免 cover letter/changelog 里出现 "Fix ..." 但标题是 "Add support ..." 时被误判为 bugfix。
    if (featureInSubject)
        return 'feature';
    if (bugfixInSubject)
        return 'bugfix';
    if (featureInText)
        return 'feature';
    if (bugfixInText)
        return 'bugfix';
    return 'other';
}
