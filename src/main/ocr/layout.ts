import type { OcrLine } from './response-adapter'

export interface LineBounds { left: number; top: number; centerY: number; height: number }

/** Deskew coordinates for reading order only; original evidence boxes stay intact. */
export function measureLayout(lines: OcrLine[]): Map<OcrLine, LineBounds> {
  const result = new Map<OcrLine, LineBounds>()
  for (const page of new Set(lines.map((line) => line.page ?? 0))) {
    const pageLines = lines.filter((line) => (line.page ?? 0) === page)
    const angles = pageLines.flatMap((line) => {
      const box = line.bbox
      if (!box || box.length < 4) return []
      const dx = box[1][0] - box[0][0], dy = box[1][1] - box[0][1]
      const height = Math.hypot(box[3][0] - box[0][0], box[3][1] - box[0][1])
      const angle = Math.atan2(dy, dx)
      return dx > Math.max(40, height * 2) && Math.abs(angle) < Math.PI / 18 ? [angle] : []
    }).sort((a, b) => a - b)
    const angle = angles.length >= 3 ? angles[Math.floor(angles.length / 2)] : 0
    const cos = Math.cos(angle), sin = Math.sin(angle)
    for (const line of pageLines) {
      if (!line.bbox) continue
      const xs = line.bbox.map(([x, y]) => x * cos + y * sin)
      const ys = line.bbox.map(([x, y]) => y * cos - x * sin)
      const top = Math.min(...ys), bottom = Math.max(...ys)
      result.set(line, { left: Math.min(...xs), top, centerY: (top + bottom) / 2, height: bottom - top })
    }
  }
  return result
}

export function sameRow(a: LineBounds, b: LineBounds): boolean {
  return Math.abs(a.centerY - b.centerY) <= Math.max(3, Math.min(a.height, b.height) * 0.45)
}
