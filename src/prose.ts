/**
 * Prose Layout: the canonical line shape of a Raven Artifact.
 *
 * An agent that edits writing paragraph-by-paragraph rewrites a whole paragraph
 * to change one clause, so every diff is coarse, every review re-reads unchanged
 * text, and a regression hides inside a block that "changed". Putting one
 * sentence on one line makes the line the smallest edit unit: a diff then names
 * the sentences that actually changed.
 *
 * This module owns that transform and nothing else. It is pure, total, and
 * idempotent — `layoutProse(layoutProse(x)) === layoutProse(x)` — because Raven
 * hashes the laid-out bytes and later requires Completion to carry exactly those
 * bytes back.
 *
 * The transform is Markdown-structure-aware by default. Reflowing a fenced code
 * block, a table row, or a heading would corrupt the document, so those regions
 * are copied through untouched and only genuine prose is re-laid.
 * @module
 */

export const PROSE_LAYOUTS = ['sentence-per-line', 'as-written'] as const

export type ProseLayout = typeof PROSE_LAYOUTS[number]

export const PROSE_FORMATS = ['markdown', 'plain'] as const

export type ProseFormat = typeof PROSE_FORMATS[number]

export interface ProseLayoutOptions {
  readonly layout: ProseLayout
  readonly format: ProseFormat
}

/**
 * Terminators that end a sentence on their own, with no following space. CJK
 * punctuation is already full-width, so the next sentence starts immediately;
 * requiring whitespace after them — the Latin rule — would merge every CJK
 * sentence in the document onto one line.
 */
const WIDE_TERMINATORS = new Set(['。', '！', '？', '‼', '⁇', '⁈', '⁉'])

const NARROW_TERMINATORS = new Set(['.', '!', '?'])

/** Closing marks that belong to the sentence they follow, not to the next one. */
const TRAILING_MARKS = new Set([
  '"', "'", ')', ']', '}', '\u00BB', '\u201D', '\u2019', '\u203A',
  '\u300D', '\u300F', '\uFF09', '\u3011', '\u3009', '\u300B', '\u3015', '\uFF5D',
])

/**
 * Abbreviations whose period is not a sentence end. Kept deliberately short and
 * conservative: a missing entry merges two sentences onto one line, which is a
 * readable degradation, while an over-eager split corrupts a citation.
 */
const ABBREVIATIONS = new Set([
  'al', 'approx', 'apr', 'aug', 'ca', 'cf', 'chap', 'col', 'dec', 'dept', 'dr',
  'e.g', 'ed', 'eds', 'eq', 'esp', 'est', 'et', 'etc', 'feb', 'fig', 'figs',
  'i.e', 'inc', 'jan', 'jr', 'jul', 'jun', 'ltd', 'mar', 'mr', 'mrs', 'ms',
  'no', 'nos', 'nov', 'oct', 'p', 'pp', 'prof', 'pt', 'rev', 'sec', 'sep',
  'sept', 'sr', 'st', 'tbl', 'univ', 'vol', 'vols', 'vs', 'v',
])

const CJK_PATTERN = /[\u1100-\u11FF\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u

function isWide(character: string): boolean {
  return CJK_PATTERN.test(character)
}

/**
 * Whether `character` can open a sentence. Refusing a lowercase opener is what
 * keeps `et al. reported` and `vs. the control` on one line when the preceding
 * token is not in {@link ABBREVIATIONS}; the cost is that a genuinely
 * lowercase-initial sentence stays joined, which reads correctly either way.
 */
function opensSentence(character: string): boolean {
  if (character === '') return false
  if (isWide(character)) return true
  if (/[A-Z0-9]/.test(character)) return true
  return '"\'\u201C\u2018([{*_`\u00AB-#>'.includes(character)
}

/** The token immediately before a period, lowercased and stripped of punctuation. */
function precedingToken(text: string, periodIndex: number): string {
  let start = periodIndex
  while (start > 0 && /[^\s]/.test(text[start - 1] ?? '')) start -= 1
  return text.slice(start, periodIndex).toLowerCase().replaceAll(/[^a-z.]/g, '')
}

/**
 * Split one already-joined paragraph into sentences.
 *
 * Inline code spans, link destinations, and bracketed spans suppress splitting:
 * a period inside `` `Fig. 1` ``, inside `](https://x/a.b)`, or inside
 * `[see Fig. 2]` is not a sentence end, and breaking there would break the
 * Markdown construct as well as the sentence.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  let backtickRun = 0
  let bracketDepth = 0
  let parenDepth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? ''
    if (character === '`') {
      let run = 0
      while (text[index + run] === '`') run += 1
      if (backtickRun === 0) backtickRun = run
      else if (backtickRun === run) backtickRun = 0
      index += run - 1
      continue
    }
    if (backtickRun > 0) continue
    if (character === '[') bracketDepth += 1
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (character === '(') parenDepth += 1
    else if (character === ')') parenDepth = Math.max(0, parenDepth - 1)
    if (bracketDepth > 0 || parenDepth > 0) continue

    const wide = WIDE_TERMINATORS.has(character)
    if (!wide && !NARROW_TERMINATORS.has(character)) continue
    if (!wide && character === '.' && ABBREVIATIONS.has(precedingToken(text, index))) continue
    // A single capital before a period is an initial (`J. R. R. Tolkien`), never
    // a sentence end, and the opener test cannot see the difference.
    if (!wide && character === '.' && /(^|\s)[A-Za-z]$/.test(text.slice(Math.max(0, index - 2), index))) continue

    let end = index + 1
    while (end < text.length
      && (WIDE_TERMINATORS.has(text[end] ?? '') || NARROW_TERMINATORS.has(text[end] ?? ''))) end += 1
    while (end < text.length && TRAILING_MARKS.has(text[end] ?? '')) end += 1
    // A footnote or numeric citation marker is part of the sentence that cites it.
    const marker = /^\[\^?[\w.-]+\]/.exec(text.slice(end))
    if (marker !== null) end += marker[0].length

    let next = end
    if (!wide) {
      if (next < text.length && !/\s/.test(text[next] ?? '')) continue
      while (next < text.length && /\s/.test(text[next] ?? '')) next += 1
      if (next < text.length && !opensSentence(text[next] ?? '')) continue
    } else {
      while (next < text.length && /\s/.test(text[next] ?? '')) next += 1
    }
    const sentence = text.slice(start, end).trim()
    if (sentence.length > 0) sentences.push(sentence)
    start = next
    index = next - 1
  }
  const tail = text.slice(start).trim()
  if (tail.length > 0) sentences.push(tail)
  return sentences
}

/**
 * Join wrapped prose lines back into one paragraph before re-splitting. A space
 * is inserted at every seam except between two wide characters, where the source
 * wrap carried no space and inserting one would alter the text.
 */
function joinLines(lines: readonly string[]): string {
  let joined = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (joined.length === 0) {
      joined = trimmed
      continue
    }
    const left = joined.at(-1) ?? ''
    const right = trimmed[0] ?? ''
    joined += isWide(left) && isWide(right) ? trimmed : ` ${trimmed}`
  }
  return joined
}

interface Paragraph {
  /** Prefix printed before the first sentence: a list marker or nothing. */
  readonly opener: string
  /** Prefix printed before every later sentence, keeping the block's structure valid. */
  readonly continuation: string
  readonly lines: string[]
}

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})/
const HEADING_PATTERN = /^\s{0,3}#{1,6}(\s|$)/
const THEMATIC_BREAK_PATTERN = /^\s{0,3}([*\-_])(\s*\1){2,}\s*$/
const TABLE_PATTERN = /^\s*\|/
const HTML_PATTERN = /^\s{0,3}<[!/a-zA-Z]/
const LINK_DEFINITION_PATTERN = /^\s{0,3}\[[^\]]+\]:/
const MATH_FENCE_PATTERN = /^\s*\$\$/
const SETEXT_PATTERN = /^\s{0,3}(=+|-{2,})\s*$/
const BLOCKQUOTE_PATTERN = /^(\s{0,3}(?:>\s?)+)(.*)$/
const LIST_ITEM_PATTERN = /^(\s*)([*+-]|\d{1,9}[.)])(\s+)(.*)$/
/** A trailing hard break is an authored line boundary; reflowing across it would delete it. */
const HARD_BREAK_PATTERN = /(\s{2,}|\\)$/

/** Spaces as wide as `marker`, so a continuation line stays inside its list item. */
function continuationIndent(marker: string): string {
  return ' '.repeat(marker.length)
}

function layoutMarkdownLines(lines: readonly string[]): string[] {
  const output: string[] = []
  let paragraph: Paragraph | undefined
  let fence: string | undefined
  let inMath = false
  let inFrontmatter = false

  const flush = (): void => {
    const pending = paragraph
    if (pending === undefined) return
    const joined = joinLines(pending.lines)
    const sentences = splitSentences(joined)
    const emitted = sentences.length === 0 ? [joined] : sentences
    emitted.forEach((sentence, index) => {
      output.push(`${index === 0 ? pending.opener : pending.continuation}${sentence}`)
    })
    paragraph = undefined
  }
  const verbatim = (line: string): void => {
    flush()
    output.push(line)
  }

  for (const [index, line] of lines.entries()) {
    if (index === 0 && /^-{3,}\s*$/.test(line)) {
      inFrontmatter = true
      output.push(line)
      continue
    }
    if (inFrontmatter) {
      output.push(line)
      if (/^-{3,}\s*$/.test(line)) inFrontmatter = false
      continue
    }
    if (fence !== undefined) {
      output.push(line)
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch !== null) {
      flush()
      fence = fenceMatch[2] ?? '```'
      output.push(line)
      continue
    }
    if (MATH_FENCE_PATTERN.test(line)) {
      verbatim(line)
      inMath = !inMath
      continue
    }
    if (inMath) {
      output.push(line)
      continue
    }
    if (line.trim().length === 0) {
      flush()
      output.push(line)
      continue
    }
    if (HEADING_PATTERN.test(line)
      || THEMATIC_BREAK_PATTERN.test(line)
      || TABLE_PATTERN.test(line)
      || HTML_PATTERN.test(line)
      || LINK_DEFINITION_PATTERN.test(line)
      // A setext underline only means "heading" while a paragraph is open above it.
      || (paragraph !== undefined && SETEXT_PATTERN.test(line))) {
      verbatim(line)
      continue
    }

    const quoted = BLOCKQUOTE_PATTERN.exec(line)
    if (quoted !== null) {
      // Recursing on the stripped body keeps nested quotes, lists inside quotes,
      // and fences inside quotes working without a second implementation.
      const marker = quoted[1] ?? '> '
      flush()
      for (const inner of layoutMarkdownLines([quoted[2] ?? ''])) output.push(`${marker}${inner}`)
      continue
    }

    if (HARD_BREAK_PATTERN.test(line)) {
      verbatim(line)
      continue
    }

    const item = LIST_ITEM_PATTERN.exec(line)
    if (item !== null) {
      flush()
      const opener = `${item[1] ?? ''}${item[2] ?? ''}${item[3] ?? ''}`
      paragraph = { opener, continuation: continuationIndent(opener), lines: [item[4] ?? ''] }
      continue
    }

    if (paragraph === undefined) {
      const indent = /^\s*/.exec(line)?.[0] ?? ''
      paragraph = { opener: indent, continuation: indent, lines: [line] }
      continue
    }
    paragraph.lines.push(line)
  }
  flush()
  return output
}

function layoutPlainText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(block => splitSentences(joinLines(block.split('\n'))).join('\n'))
    .join('\n\n')
}

/**
 * Lay `text` out under `options`. `as-written` returns the input unchanged, so a
 * deployment that turns the feature off pays nothing and stores exactly what the
 * agent wrote.
 */
export function layoutProse(text: string, options: ProseLayoutOptions): string {
  if (options.layout === 'as-written') return text
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (options.format === 'plain') return layoutPlainText(normalized)
  return layoutMarkdownLines(normalized.split('\n')).join('\n')
}

/**
 * What the layout did to `text`, reported back to the agent as feedback.
 *
 * Deliberately compares the input against the laid-out result rather than
 * re-scanning the result for crowded lines: the result is by construction
 * already split as far as the splitter will go, so a checker that re-scanned it
 * could never report anything and would only look like a check.
 */
export interface ProseLayoutReport {
  /** True when the stored Artifact bytes differ from what the agent submitted. */
  readonly changed: boolean
  readonly sourceLines: number
  readonly laidOutLines: number
}

export function proseLayoutReport(text: string, options: ProseLayoutOptions): ProseLayoutReport {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const laid = layoutProse(text, options)
  return {
    changed: laid !== normalized,
    sourceLines: normalized.split('\n').length,
    laidOutLines: laid.split('\n').length,
  }
}
