// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit performed, in order: {old, new}. */
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file's lines under SPEC.md section 3. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
const leadingWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const trailingWs = (s: string): string => s.match(/[ \t]*$/)?.[0] ?? '';
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.slice(0, s.length - trailingWs(s).length);
  return s.slice(leadingWs(s).length, s.length - trailingWs(s).length);
}
/** Positions where O matches fileLines at one tier (section 5). */
function occAt(fileLines: string[], O: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== nO[j]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}
/** First tier at which O occurs, with its positions at or after `from`. */
function findTier(fileLines: string[], O: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occAt(fileLines, O, t).filter((i) => i >= from);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}
/** First line at or after `from` equal to `line` at the first tier where one is (single-line match). */
function findSingle(fileLines: string[], line: string, strict: boolean, from = 0): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(line, t);
    for (let i = from; i < fileLines.length; i++) {
      if (normLine(fileLines[i]!, t) === want) return i;
    }
  }
  return -1;
}
interface OLine {
  text: string;
  ctx: boolean;
}
/** N with context lines taken from the file's own matched lines and tier-2 re-indentation (section 5). */
function buildNew(O: OLine[], N: OLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const oCtx: number[] = [];
  O.forEach((o, idx) => { if (o.ctx) oCtx.push(idx); });
  let k = 0;
  const F = tier === 2 && O.length > 0 ? leadingWs(fileLines[at] ?? '') : '';
  const P = tier === 2 && O.length > 0 ? leadingWs(O[0]!.text) : '';
  for (const item of N) {
    if (item.ctx) {
      out.push(fileLines[at + oCtx[k]!]!);
      k += 1;
    } else if (tier === 2) {
      const t = item.text;
      out.push(t !== '' && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** A unified hunk body, parsed into old lines O and new lines N (section 6). */
interface Hunk {
  a: number;
  O: OLine[];
  N: OLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  lastPlusNoEol: boolean;
}
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function parseHunk(a: number, body: string[]): Hunk {
  const O: OLine[] = [];
  const N: OLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      O.push({ text: t, ctx: true });
      N.push({ text: t, ctx: true });
      lastCtxPlus = idx;
    } else if (l.startsWith('-')) {
      O.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: false });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
    // `\` lines are skipped: they refer to the body line before them.
  });
  const noEol = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  const lastPlusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { a, O, N, noEol, lastPlusNoEol };
}

function applyUniHunk(content: string, h: Hunk, d: number, strict: boolean, path: string): string {
  const f = splitFile(content);
  if (h.O.length === 0) {
    const origLen = f.lines.length;
    let at = h.a + d;
    if (at < 0) at = 0;
    if (at > origLen) at = origLen;
    const add = h.N.map((x) => x.text);
    f.lines.splice(at, 0, ...add);
    if (at === origLen) f.final = !h.noEol;
    return joinFile(f);
  }
  const found = findTier(f.lines, h.O.map((o) => o.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const add = buildNew(h.O, h.N, f.lines, best, found.tier);
  const runsToEnd = best + h.O.length === f.lines.length;
  f.lines.splice(best, h.O.length, ...add);
  if (runsToEnd) f.final = !h.noEol;
  return joinFile(f);
}

interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  diffOld?: string;
  diffNew?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.diffOld;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.diffNew;
  const isCreate = s.isCreate || oldPath === null;
  const isDelete = !isCreate && (s.isDelete || newPath === null);
  if (isCreate) {
    const p = newPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const item of h.N) if (!item.ctx) plus.push(item.text);
      let noEol = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.N.some((x) => !x.ctx)) { noEol = h.lastPlusNoEol; break; }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  const oldP = oldPath ?? '';
  if (isDelete) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  const newP = newPath ?? '';
  const isMove = oldP !== newP;
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let content = before;
    let d = 0;
    for (const h of s.hunks) {
      content = applyUniHunk(content, h, d, strict, oldP);
      d += h.N.length - h.O.length;
    }
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, content);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, content);
    }
  };
}

/** Unified diffs (section 6): parse the patch into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let body: string[] | null = null;
  let bodyA = 0;
  const flushBody = (): void => {
    if (body !== null && cur !== null) {
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunk(bodyA, body));
    }
    body = null;
  };
  const headerPath = (line: string): string | null => {
    const rest = line.slice(4);
    const tab = rest.indexOf('\t');
    const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
    if (p === '/dev/null') return null;
    return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (body !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushBody();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        body.push(line);
        i += 1;
        continue;
      }
      flushBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { isCreate: false, isDelete: false, hunks: [], diffOld: m[1], diffNew: m[2] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
      } else {
        cur = { isCreate: false, isDelete: false, hunks: [], pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!) };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      body = [];
      bodyA = Number(m[1]);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
    }
    i += 1;
  }
  flushBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** SEARCH/REPLACE blocks (section 7): parse the patch into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (sep === -1) {
        if (lines[j]!.trimEnd() === '=======') sep = j;
      } else if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const out = buildNew(
        oldLines.map((t) => ({ text: t, ctx: false })),
        newLines.map((t) => ({ text: t, ctx: false })),
        f.lines, at, found.tier,
      );
      f.lines.splice(at, oldLines.length, ...out);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: OLine[];
  N: OLine[];
}

function applyVChunk(content: string, ch: VChunk, cursor: number, strict: boolean, path: string): { content: string; cursor: number } {
  const f = splitFile(content);
  let cur = cursor;
  if (ch.anchor !== null) {
    const at = findSingle(f.lines, ch.anchor, strict, cur);
    if (at === -1) throw new Fail('no-match', path);
    cur = at + 1;
  }
  if (ch.O.length === 0) {
    const at = ch.eof ? f.lines.length : cur;
    const add = ch.N.map((x) => x.text);
    f.lines.splice(at, 0, ...add);
    return { content: joinFile(f), cursor: at + add.length };
  }
  const oText = ch.O.map((o) => o.text);
  const tiers = strict ? [0] : [0, 1, 2];
  let found: { tier: number; at: number } | null = null;
  for (const t of tiers) {
    const occ = occAt(f.lines, oText, t).filter((idx) => idx >= cur);
    const ok = ch.eof ? occ.filter((idx) => idx + oText.length === f.lines.length) : occ;
    if (ok.length > 0) { found = { tier: t, at: ok[0]! }; break; }
  }
  if (found === null) throw new Fail('no-match', path);
  const add = buildNew(ch.O, ch.N, f.lines, found.at, found.tier);
  f.lines.splice(found.at, ch.O.length, ...add);
  return { content: joinFile(f), cursor: found.at + add.length };
}

/** V4A patches (section 8): parse the patch into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    start: number;
    raw: string[];
    rawIdx: number[];
  }
  const secs: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File:')) {
      cur = { kind: 'add', path: line.slice(13).trim(), start: i + 1, raw: [], rawIdx: [] };
      secs.push(cur);
    } else if (line.startsWith('*** Delete File:')) {
      cur = { kind: 'delete', path: line.slice(16).trim(), start: i + 1, raw: [], rawIdx: [] };
      secs.push(cur);
    } else if (line.startsWith('*** Update File:')) {
      cur = { kind: 'update', path: line.slice(16).trim(), start: i + 1, raw: [], rawIdx: [] };
      secs.push(cur);
    } else if (blank(line) && cur === null) {
      // blank lines before the first section are ignored
    } else if (cur === null) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.raw.push(line);
      cur.rawIdx.push(i + 1);
    }
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!)) { s.raw.pop(); s.rawIdx.pop(); }
    if (s.kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < s.raw.length; k++) {
        const l = s.raw[k]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${s.rawIdx[k]}`);
      }
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : `${addLines.join('\n')}\n`);
      });
    } else if (s.kind === 'delete') {
      for (let k = 0; k < s.raw.length; k++) {
        if (!blank(s.raw[k]!)) throw new Exit2(`error: parse ${s.rawIdx[k]}`);
      }
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (s.raw.length > 0 && s.raw[0]!.startsWith('*** Move to:')) {
        moveTo = s.raw[0]!.slice(12).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let started = false;
      for (; idx < s.raw.length; idx++) {
        const l = s.raw[idx]!;
        const ln = s.rawIdx[idx]!;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, O: [], N: [] };
          chunks.push(chunk);
          started = true;
        } else if (l === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, O: [], N: [] };
            chunks.push(chunk);
            started = true;
          } else {
            chunk.eof = true;
          }
          chunk = null;
        } else if (l === '') {
          if (chunk !== null) {
            chunk.O.push({ text: '', ctx: true });
            chunk.N.push({ text: '', ctx: true });
          } else if (!started) {
            chunk = { anchor: null, eof: false, O: [{ text: '', ctx: true }], N: [{ text: '', ctx: true }] };
            chunks.push(chunk);
            started = true;
          }
          // a blank line after a closed chunk is ignored
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            if (started) throw new Exit2(`error: parse ${ln}`);
            chunk = { anchor: null, eof: false, O: [], N: [] };
            chunks.push(chunk);
            started = true;
          }
          if (l.startsWith(' ')) {
            const t = l.slice(1);
            chunk.O.push({ text: t, ctx: true });
            chunk.N.push({ text: t, ctx: true });
          } else if (l.startsWith('-')) {
            chunk.O.push({ text: l.slice(1), ctx: false });
          } else {
            chunk.N.push({ text: l.slice(1), ctx: false });
          }
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.start}`);
      const p = s.path;
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        let content = before;
        let cursor = 0;
        for (const ch of chunks) {
          const r = applyVChunk(content, ch, cursor, strict, p);
          content = r.content;
          cursor = r.cursor;
        }
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, content);
          tree.moves.push({ old: p, new: mt });
        } else {
          tree.now.set(p, content);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const rows: { key: string; text: string }[] = changed.map((c) => ({
    key: c.p,
    text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}`,
  }));
  for (const m of tree.moves) {
    const oi = rows.findIndex((r) => r.key === m.old && r.text.startsWith('D '));
    const ni = rows.findIndex((r) => r.key === m.new && r.text.startsWith('A '));
    if (oi >= 0 && ni >= 0) {
      rows.splice(Math.max(oi, ni), 1);
      rows.splice(Math.min(oi, ni), 1);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
