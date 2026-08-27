import { describe, expect, it } from 'vitest'

import { layoutProse, proseLayoutReport, splitSentences, type ProseLayoutOptions } from '../../src/prose.js'

const markdown: ProseLayoutOptions = { layout: 'sentence-per-line', format: 'markdown' }
const plain: ProseLayoutOptions = { layout: 'sentence-per-line', format: 'plain' }
const off: ProseLayoutOptions = { layout: 'as-written', format: 'markdown' }

describe('splitSentences', () => {
  it('splits Latin sentences on terminal punctuation followed by a sentence opener', () => {
    expect(splitSentences('The first claim holds. The second does not! Does the third?')).toEqual([
      'The first claim holds.',
      'The second does not!',
      'Does the third?',
    ])
  })

  it('splits CJK sentences without requiring whitespace after the terminator', () => {
    expect(splitSentences('第一个结论成立。第二个不成立！第三个呢？')).toEqual([
      '第一个结论成立。',
      '第二个不成立！',
      '第三个呢？',
    ])
  })

  it('keeps abbreviations, initials, and decimals inside their sentence', () => {
    expect(splitSentences('Smith et al. reported 3.14 as the value. J. R. R. Tolkien disagreed.')).toEqual([
      'Smith et al. reported 3.14 as the value.',
      'J. R. R. Tolkien disagreed.',
    ])
  })

  it('keeps a closing quote and a footnote marker with the sentence they close', () => {
    expect(splitSentences('He said "it holds."[^1] The reviewer disagreed.')).toEqual([
      'He said "it holds."[^1]',
      'The reviewer disagreed.',
    ])
  })

  it('attaches markers of every accepted shape', () => {
    expect(splitSentences('A holds.[12] B holds.[^note.a-1] C holds.')).toEqual([
      'A holds.[12]',
      'B holds.[^note.a-1]',
      'C holds.',
    ])
  })

  it('does not attach a bracket that is not a marker', () => {
    expect(splitSentences('A holds.[ 3] B holds.')).toEqual(['A holds.[ 3] B holds.'])
  })

  it('is idempotent: re-splitting each sentence yields that sentence unchanged', () => {
    const input = 'A holds.[^1] B holds.[2] C holds!? D holds.'
    const once = splitSentences(input)
    expect(once.flatMap(sentence => splitSentences(sentence))).toEqual(once)
  })

  it('does not carry sticky regex state between calls', () => {
    const first = splitSentences('A holds.[^1] B holds.')
    const second = splitSentences('A holds.[^1] B holds.')
    expect(second).toEqual(first)
  })

  it('splits a paragraph with many footnote markers correctly at scale', () => {
    const count = 16000
    const text = Array.from({ length: count }, (_, index) => `Sentence ${index} holds.[^${index}]`).join(' ')
    const sentences = splitSentences(text)
    expect(sentences).toHaveLength(count)
    expect(sentences[0]).toBe('Sentence 0 holds.[^0]')
    expect(sentences[count - 1]).toBe(`Sentence ${count - 1} holds.[^${count - 1}]`)
  })

  it('never splits inside an inline code span or a link destination', () => {
    expect(splitSentences('Call `run. now` first. See [Fig. 2](https://x.test/a.b) next.')).toEqual([
      'Call `run. now` first.',
      'See [Fig. 2](https://x.test/a.b) next.',
    ])
  })

  it('does not split before a lowercase opener', () => {
    expect(splitSentences('The value rose vs. the control group.')).toEqual([
      'The value rose vs. the control group.',
    ])
  })
})

describe('layoutProse', () => {
  it('returns the input untouched when the layout is disabled', () => {
    const source = 'One. Two. Three.'
    expect(layoutProse(source, off)).toBe(source)
  })

  it('reflows a wrapped paragraph into one sentence per line', () => {
    const source = 'The first claim\nholds under review. The second\nfails.'
    expect(layoutProse(source, markdown)).toBe('The first claim holds under review.\nThe second fails.')
  })

  it('joins wrapped CJK lines without inserting a space', () => {
    expect(layoutProse('第一个结论\n成立。第二个不成立。', markdown))
      .toBe('第一个结论成立。\n第二个不成立。')
  })

  it('copies a fenced code block through untouched', () => {
    const source = 'Intro. Detail.\n\n```js\nconst a = 1. // not prose. really\n```\n\nAfter. Done.'
    expect(layoutProse(source, markdown)).toBe(
      'Intro.\nDetail.\n\n```js\nconst a = 1. // not prose. really\n```\n\nAfter.\nDone.',
    )
  })

  it('leaves headings, tables, thematic breaks, and link definitions alone', () => {
    const source = [
      '# Title. Subtitle',
      '',
      '| a. b | c. d |',
      '| --- | --- |',
      '',
      '---',
      '',
      '[ref]: https://x.test/a.b "Title. Here"',
    ].join('\n')
    expect(layoutProse(source, markdown)).toBe(source)
  })

  it('indents list-item continuations so the item stays one list item', () => {
    expect(layoutProse('- First point. Second point.', markdown))
      .toBe('- First point.\n  Second point.')
    expect(layoutProse('10. First point. Second point.', markdown))
      .toBe('10. First point.\n    Second point.')
  })

  it('re-prefixes blockquote continuations', () => {
    expect(layoutProse('> First point. Second point.', markdown))
      .toBe('> First point.\n> Second point.')
  })

  it('preserves YAML frontmatter verbatim', () => {
    const source = '---\ntitle: A. B\ntags: [x]\n---\n\nBody one. Body two.'
    expect(layoutProse(source, markdown)).toBe('---\ntitle: A. B\ntags: [x]\n---\n\nBody one.\nBody two.')
  })

  it('preserves a trailing hard line break instead of reflowing across it', () => {
    const source = 'First line.  \nSecond line.'
    expect(layoutProse(source, markdown)).toBe(source)
  })

  it('preserves a math block verbatim', () => {
    const source = 'Intro. Text.\n\n$$\na. b = c. d\n$$\n\nEnd.'
    expect(layoutProse(source, markdown)).toBe('Intro.\nText.\n\n$$\na. b = c. d\n$$\n\nEnd.')
  })

  it('is idempotent for markdown and for plain text', () => {
    const source = [
      '# Heading',
      '',
      'One claim holds. Another does not.',
      '',
      '- Item one. Item two.',
      '',
      '> Quoted one. Quoted two.',
      '',
      '```',
      'code. here',
      '```',
      '',
      '第一个结论成立。第二个不成立。',
    ].join('\n')
    const once = layoutProse(source, markdown)
    expect(layoutProse(once, markdown)).toBe(once)
    const plainOnce = layoutProse(source, plain)
    expect(layoutProse(plainOnce, plain)).toBe(plainOnce)
  })

  it('bounds abbreviation lookbehind on a long unbroken dot-dense token', { timeout: 2_000 }, () => {
    const token = `https://example.test/${'a.'.repeat(20_000)}`
    expect(splitSentences(`${token} End.`)).toEqual([token, 'End.'])
  })

  it('treats every block as prose in plain format', () => {
    expect(layoutProse('# Not a heading. Still prose.', plain))
      .toBe('# Not a heading.\nStill prose.')
  })

  it('normalizes CRLF input', () => {
    expect(layoutProse('One.\r\nTwo.', markdown)).toBe('One.\nTwo.')
  })
})

describe('proseLayoutReport', () => {
  it('reports that nothing changed when the input is already laid out', () => {
    expect(proseLayoutReport('One claim holds.\nAnother does not.', markdown)).toEqual({
      changed: false,
      sourceLines: 2,
      laidOutLines: 2,
    })
  })

  it('reports the reflow when the input packed sentences onto one line', () => {
    expect(proseLayoutReport('One claim holds. Another does not.', markdown)).toEqual({
      changed: true,
      sourceLines: 1,
      laidOutLines: 2,
    })
  })

  it('reports no change when the layout is disabled', () => {
    expect(proseLayoutReport('One. Two. Three.', off)).toEqual({
      changed: false,
      sourceLines: 1,
      laidOutLines: 1,
    })
  })
})
