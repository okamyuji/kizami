#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const REQUIRED_FEATURE_DESIGN_SECTIONS = [
  '目的と成功条件',
  '対象範囲',
  '意思決定',
  '保存する記録',
  '処理フロー',
  '不変条件',
  '失敗時の動作',
  '移行',
  'セキュリティとプライバシー',
  '性能と観測',
  'テスト戦略',
  '段階的導入',
];

const GUARDED_TERM_RULES = [
  {
    canonical: '整合済み',
    pattern: /(?<![ァ-ヿ一-鿿])クリーン(?![ァ-ヿ一-鿿])/u,
  },
];

function collectMarkdownFiles(inputPaths) {
  const files = [];
  const visit = (inputPath) => {
    const absolute = resolve(inputPath);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) visit(resolve(absolute, entry));
    } else if (stat.isFile() && extname(absolute) === '.md') {
      files.push(absolute);
    }
  };
  for (const inputPath of inputPaths) visit(inputPath);
  return files.sort();
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

function tableColumnCount(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').length;
}

function lintFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const findings = [];
  const headings = new Set();
  let inFence = false;
  let previousHeadingLevel = 0;
  let expectedTableColumns = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      expectedTableColumns = null;
      continue;
    }
    if (inFence) continue;

    const visible = stripInlineCode(line);
    const heading = visible.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      headings.add(heading[2]);
      if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
        findings.push({
          severity: 'Medium',
          line: lineNumber,
          message: `見出しレベルが${previousHeadingLevel}から${level}へ飛んでいます`,
        });
      }
      previousHeadingLevel = level;
    }

    if (/\b(?:TBD|TODO|FIXME)\b/.test(visible)) {
      findings.push({
        severity: 'High',
        line: lineNumber,
        message: '未解決プレースホルダーがあります',
      });
    }

    for (const rule of GUARDED_TERM_RULES) {
      if (rule.pattern.test(visible)) {
        findings.push({
          severity: 'Low',
          line: lineNumber,
          message: `用語を「${rule.canonical}」へ統一してください`,
        });
      }
    }

    const columns = tableColumnCount(line);
    if (columns == null) {
      expectedTableColumns = null;
    } else if (expectedTableColumns == null) {
      expectedTableColumns = columns;
    } else if (columns !== expectedTableColumns) {
      findings.push({
        severity: 'Medium',
        line: lineNumber,
        message: `表の列数が${expectedTableColumns}列ではなく${columns}列です`,
      });
    }
  }

  if (inFence) {
    findings.push({
      severity: 'High',
      line: lines.length,
      message: 'コードフェンスが閉じていません',
    });
  }

  if (filePath.endsWith('verified-error-resolution-design.md')) {
    for (const section of REQUIRED_FEATURE_DESIGN_SECTIONS) {
      if (!headings.has(section)) {
        findings.push({
          severity: 'High',
          line: 1,
          message: `必須見出し「${section}」がありません`,
        });
      }
    }
  }

  return findings;
}

function runSelfTest() {
  const rule = GUARDED_TERM_RULES[0];
  const negatives = ['スクリーン', 'スクリーンリーダー', 'クリーンアップ'];
  const falsePositives = negatives.filter((value) => rule.pattern.test(value));
  if (falsePositives.length > 0 || !rule.pattern.test('状態はクリーンです')) {
    process.stderr.write('doclint self-test failed\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('doclint self-test: guarded term matching passed\n');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const inputPaths = args.filter((arg) => !arg.startsWith('--'));
  const files = collectMarkdownFiles(inputPaths.length > 0 ? inputPaths : ['docs']);
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const file of files) {
    for (const finding of lintFile(file)) {
      counts[finding.severity] += 1;
      process.stdout.write(`[${finding.severity}] ${file}:${finding.line} ${finding.message}\n`);
    }
  }
  process.stdout.write(
    `Critical ${counts.Critical} / High ${counts.High} / Medium ${counts.Medium} / Low ${counts.Low}\n`
  );
  if (Object.values(counts).some((count) => count > 0)) process.exitCode = 1;
}
