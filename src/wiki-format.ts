import { createHash } from 'node:crypto'

/** Filesystem-safe slug that keeps CJK intact, since research corpora are frequently not Latin. */
export function wikiSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[\\/:*?"<>|#[\]]/g, ' ')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    || 'untitled'
}

export function wikiYamlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\s+/g, ' ').trim()}"`
}

function wikiYamlListValue(value: string): string {
  const plain = /^[A-Za-z0-9_./:-]+$/.test(value)
    && !/^(?:null|true|false|yes|no|on|off|~|[-+]?\d+(?:\.\d+)?)$/i.test(value)
  return plain ? value : JSON.stringify(value)
}

export function wikiYamlList(values: readonly string[]): string {
  return `[${values.map(wikiYamlListValue).join(', ')}]`
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function renderWikiPage(frontmatter: readonly string[], body: string): string {
  return `---\n${frontmatter.join('\n')}\n---\n${body}`
}

export function markdownText(value: string): string {
  return value
    .replace(/([\\`*_[\]{}()#+.!|-])/g, '\\$1')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\s+/g, ' ')
    .trim()
}
