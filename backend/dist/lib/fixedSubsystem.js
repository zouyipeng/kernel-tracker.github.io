"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inferFixedSubsystemFromFiles = inferFixedSubsystemFromFiles;
function normalizePath(p) {
    return (p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function patternToRegex(pattern) {
    const p = normalizePath(pattern).trim();
    if (!p)
        return /^$/;
    // prefix match by default for directory-like patterns
    const isGlob = p.includes('*') || p.includes('?');
    if (!isGlob) {
        return new RegExp(`^${escapeRegex(p)}`, 'i');
    }
    // simple glob to regex: * => .*, ? => .
    const re = '^' + escapeRegex(p).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    return new RegExp(re, 'i');
}
function inferFixedSubsystemFromFiles(files, rules) {
    if (!rules)
        return '';
    const normalizedFiles = (files || []).map(normalizePath).filter(Boolean);
    if (!normalizedFiles.length)
        return '';
    // Score each subsystem by matched patterns count and specificity
    const scores = {};
    for (const [subsystem, patterns] of Object.entries(rules)) {
        if (!patterns?.length)
            continue;
        for (const pat of patterns) {
            const rx = patternToRegex(pat);
            for (const f of normalizedFiles) {
                if (rx.test(f)) {
                    const specificity = Math.min(normalizePath(pat).length, 60);
                    scores[subsystem] = (scores[subsystem] || 0) + 10 + Math.floor(specificity / 10);
                    break;
                }
            }
        }
    }
    let best = '';
    let bestScore = -1;
    for (const [k, v] of Object.entries(scores)) {
        if (v > bestScore) {
            bestScore = v;
            best = k;
        }
    }
    return best || '';
}
