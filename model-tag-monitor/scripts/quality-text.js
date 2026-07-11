'use strict';

const TECHNICAL_TOKEN_PATTERNS = [
  { token: 'conditionUv', pattern: /\bconditionUv\b/g },
  { token: 'jkuv', pattern: /\bjkuv\b/g },
  { token: 'evaUv', pattern: /\bevaUv\b/g },
  { token: 'orderUv', pattern: /\borderUv\b/g },
  { token: 'shipCnt', pattern: /\bshipCnt\b/g },
  { token: 'dealCnt', pattern: /\bdealCnt\b/g },
  { token: 'gmv', pattern: /\bgmv\b/g },
  { token: 'evaRate', pattern: /\bevaRate\b/g },
  { token: 'orderRate', pattern: /\borderRate\b/g },
  { token: 'shipRate', pattern: /\bshipRate\b/g },
  { token: 'dealRate', pattern: /\bdealRate\b/g },
  { token: 'returnRate', pattern: /\breturnRate\b/g },
  { token: 'deltaPct', pattern: /\bdeltaPct\b/g },
  { token: 'pct', pattern: /(?:^|[^A-Za-z])pct\b/gi },
  { token: 'pp', pattern: /(?:^|[^A-Za-z])pp\b/gi },
];

function findTechnicalTokens(text) {
  const value = String(text || '');
  const hits = [];
  for (const { token, pattern } of TECHNICAL_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) hits.push(token);
  }
  return [...new Set(hits)];
}

function collectStringFindings(value, options = {}) {
  const findings = [];
  const maxSnippet = options.maxSnippet || 120;
  const ignorePath = typeof options.ignorePath === 'function' ? options.ignorePath : () => false;

  function visit(node, path) {
    if (ignorePath(path, node)) return;
    if (typeof node === 'string') {
      const tokens = findTechnicalTokens(node);
      if (tokens.length) {
        const compact = node.replace(/\s+/g, ' ').trim();
        findings.push({
          path,
          tokens,
          snippet: compact.length > maxSnippet ? `${compact.slice(0, maxSnippet - 1)}…` : compact,
        });
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  }

  visit(value, options.rootPath || '$');
  return findings;
}

module.exports = {
  TECHNICAL_TOKEN_PATTERNS,
  collectStringFindings,
  findTechnicalTokens,
};
