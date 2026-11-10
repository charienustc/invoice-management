import { describe, it, expect } from 'vitest'
import { matchesRendererUrl } from '../../src/main/services/ipc-security'
import { checkPdfDimensions } from '../../src/shared/pdf-limits'
describe('受信页面边界', () => {
  it('仅允许精确 renderer 路径及 hash 路由', () => {
    const root = 'file:///C:/Example/out/renderer/index.html'
    expect(matchesRendererUrl(`${root}#/settings`, root)).toBe(true)
    for (const url of ['https://example.com/', 'file:///C:/Other/index.html', `${root}?override=true`, 'about:blank', 'not a URL']) expect(matchesRendererUrl(url, root)).toBe(false)
    expect(matchesRendererUrl('http://localhost:5173/#/invoices', 'http://localhost:5173/')).toBe(true)
    expect(matchesRendererUrl('http://localhost:5173/evil', 'http://localhost:5173/')).toBe(false)
  })
  it('渲染前拒绝无穷、负值、过长边和过多像素', () => {
    for (const [width, height] of [[Infinity, 1], [1, NaN], [0, 1], [-1, 1], [1000, 1e6], [8000, 8000]]) expect(() => checkPdfDimensions(width, height)).toThrow()
    expect(() => checkPdfDimensions(2200, 3200)).not.toThrow()
  })
})
