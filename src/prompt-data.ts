/** Serialize model-authored data without allowing it to close XML-like prompt delimiters. */
export function promptDataJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
