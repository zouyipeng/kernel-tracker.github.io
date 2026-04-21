"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inferKernelSubsystem = inferKernelSubsystem;
function inferKernelSubsystem(input) {
    const title = (input.title || '').trim();
    const files = (input.files || []).filter(Boolean).map(f => normalizePath(f));
    const fromTitle = normalizeSubsystemName(extractSubsystemFromTitle(title));
    const fromFiles = normalizeSubsystemName(extractSubsystemFromFiles(files));
    if (fromTitle && fromTitle !== 'other')
        return fromTitle;
    if (fromFiles && fromFiles !== 'other')
        return fromFiles;
    return 'other';
}
function normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
function extractSubsystemFromTitle(title) {
    if (!title)
        return null;
    // 常见格式：
    // - "[PATCH v2] drm/msm: xxx"
    // - "net: xxx"
    // - "mm: xxx"
    const cleaned = title.replace(/^\s*(?:\[[^\]]+\]\s*)+/, '').trim();
    const m = cleaned.match(/^([A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+){0,3})\s*:\s+/);
    if (!m)
        return null;
    const raw = m[1].toLowerCase();
    // 排除明显不是子系统的前缀
    if (/^(revert|fixup|squash|patch|resend|rfcs?|rfc)$/i.test(raw))
        return null;
    return raw;
}
function extractSubsystemFromFiles(files) {
    if (!files.length)
        return null;
    const candidates = [];
    for (const f of files) {
        const c = candidatesFromFile(f);
        candidates.push(...c);
    }
    if (!candidates.length)
        return null;
    // 频次优先，细粒度（层级更深）次之
    const scoreMap = new Map();
    for (const c of candidates) {
        const base = 10;
        const depth = c.split('/').length;
        const bonus = Math.min(depth, 4) * 2;
        scoreMap.set(c, (scoreMap.get(c) || 0) + base + bonus);
    }
    let best = 'other';
    let bestScore = -1;
    scoreMap.forEach((v, k) => {
        if (v > bestScore) {
            bestScore = v;
            best = k;
        }
    });
    return best;
}
function candidatesFromFile(file) {
    const f = normalizePath(file).toLowerCase();
    const parts = f.split('/').filter(Boolean);
    if (!parts.length)
        return [];
    const first = parts[0];
    const second = parts[1];
    const third = parts[2];
    const fourth = parts[3];
    // 特殊映射：DRM 往往更希望看到 drm/<driver>
    if (first === 'drivers' && second === 'gpu' && third === 'drm') {
        if (fourth)
            return [`drm/${fourth}`, 'drm'];
        return ['drm'];
    }
    // net / fs / arch / mm / security 等
    if (first === 'net')
        return second ? [`net/${second}`, 'net'] : ['net'];
    if (first === 'fs')
        return second ? [`fs/${second}`, 'fs'] : ['fs'];
    if (first === 'arch')
        return second ? [`arch/${second}`, 'arch'] : ['arch'];
    if (first === 'mm')
        return ['mm'];
    if (first === 'security')
        return second ? [`security/${second}`, 'security'] : ['security'];
    // kernel/sched 更常见为 sched
    if (first === 'kernel' && second === 'sched')
        return ['sched'];
    // drivers/<class>/<sub> 作为兜底
    if (first === 'drivers') {
        if (second && third)
            return [`drivers/${second}/${third}`, `drivers/${second}`, 'drivers'];
        if (second)
            return [`drivers/${second}`, 'drivers'];
        return ['drivers'];
    }
    // include/linux/netfilter.h 之类：降级到 include/linux 或 include
    if (first === 'include') {
        if (second && third)
            return [`include/${second}/${third}`, `include/${second}`, 'include'];
        if (second)
            return [`include/${second}`, 'include'];
        return ['include'];
    }
    // 顶层目录兜底
    return [first];
}
function normalizeSubsystemName(name) {
    if (!name)
        return 'other';
    let n = name.trim().toLowerCase();
    if (!n)
        return 'other';
    // 去掉一些无意义的前缀
    n = n.replace(/^drivers\//, 'drivers/');
    // 常见别名
    if (n === 'driver')
        return 'drivers';
    if (n === 'drivers/gpu/drm')
        return 'drm';
    // 限制长度，避免异常 title 前缀污染
    if (n.length > 40)
        n = n.slice(0, 40);
    return n;
}
