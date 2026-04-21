#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fetcher_1 = require("../lib/fetcher");
const ai_1 = require("../lib/ai");
const storage_1 = require("../lib/storage");
const printUsage = () => {
    console.log(`
用法: npm run fetch <command>

命令:
  all       全量抓取所有信息源数据
  summary   为指定信息源重新生成摘要
  compact   批量压缩历史数据为单文件精简结构

示例:
  npm run fetch all
  npm run fetch summary --source "Mailing List"
  npm run fetch summary --source "Mainline" --date 2026-03-25
  npm run fetch compact
`);
};
const parseArgs = () => {
    const args = process.argv.slice(2);
    const command = args[0];
    const options = {};
    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            const value = args[i + 1];
            if (value && !value.startsWith('--')) {
                options[key] = value;
                i++;
            }
        }
    }
    return { command, options };
};
const runSummary = async (options) => {
    const sourceName = options.source;
    const dateStr = options.date || (0, storage_1.getTodayString)();
    if (!sourceName) {
        console.error('错误: 需要指定 --source 参数');
        console.log('示例: npm run fetch summary --source "Mailing List"');
        process.exit(1);
    }
    console.log(`[Summary] 为 ${sourceName} (${dateStr}) 重新生成摘要...`);
    const data = (0, storage_1.loadSourceData)(sourceName, dateStr);
    if (!data) {
        console.error(`错误: 未找到数据文件 ${sourceName}-${dateStr}.json`);
        process.exit(1);
    }
    if (!data.articles || data.articles.length === 0) {
        console.error('错误: 当前数据为精简结构，不包含文章明细，无法重算摘要。请先执行 fetch all 重新抓取。');
        process.exit(1);
    }
    const config = (0, storage_1.loadSourcesConfig)();
    const summary = await (0, ai_1.generateSummary)(data.articles, {
        subsystemPrompt: config.subsystemPrompt,
        overallPrompt: config.overallPrompt,
        subsystemSummaryConcurrency: config.subsystemSummaryConcurrency,
        fixedSubsystemRules: config.fixedSubsystemRules,
    });
    data.summary = summary;
    data.generatedAt = new Date().toISOString();
    (0, storage_1.saveSourceData)(data);
    console.log(`[Summary] 摘要生成完成！`);
};
const sourceNameToFileName = (name) => name.toLowerCase().replace(/\s+/g, '-');
const runCompact = async () => {
    console.log('[Compact] 开始批量压缩历史数据（full -> compact-single-file）...');
    const index = (0, storage_1.loadSourceDatesIndex)();
    const config = (0, storage_1.loadSourcesConfig)();
    const sourceNameMap = new Map(config.sources.map(s => [sourceNameToFileName(s.name), s.name]));
    let converted = 0;
    let skipped = 0;
    for (const [sourceKey, value] of Object.entries(index)) {
        const sourceName = sourceNameMap.get(sourceKey) || sourceKey;
        const dates = value?.dates || [];
        for (const dateStr of dates) {
            const loaded = (0, storage_1.loadSourceData)(sourceName, dateStr) || (0, storage_1.loadSourceData)(sourceKey, dateStr);
            if (!loaded) {
                skipped++;
                console.log(`[Compact] 跳过: ${sourceKey}-${dateStr}.json (未找到)`);
                continue;
            }
            (0, storage_1.saveSourceData)(loaded);
            converted++;
            console.log(`[Compact] 已转换: ${sourceKey}-${dateStr}`);
        }
    }
    console.log(`[Compact] 完成，压缩 ${converted} 个日期数据，跳过 ${skipped} 个`);
};
const main = async () => {
    const { command, options } = parseArgs();
    switch (command) {
        case 'all':
            await (0, fetcher_1.fetchAll)();
            break;
        case 'summary':
            await runSummary(options);
            break;
        case 'compact':
            await runCompact();
            break;
        case 'help':
        case '--help':
        case '-h':
            printUsage();
            break;
        default:
            if (command) {
                console.error(`未知命令: ${command}`);
            }
            printUsage();
            process.exit(command ? 1 : 0);
    }
};
main().catch(console.error);
