export function matchesRendererUrl(actual: string, expected: string): boolean {
  try { const source = new URL(actual), trusted = new URL(expected); source.hash = ''; trusted.hash = ''; return source.href === trusted.href }
  catch { return false }
}
