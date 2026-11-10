import { BrowserWindow, nativeTheme } from 'electron'
import type { AppSettings } from '@shared/contracts'

export function windowColors() {
  return nativeTheme.shouldUseDarkColors
    ? { background: '#1c1d20', titlebar: '#25262a', symbol: '#dedee4' }
    : { background: '#ffffff', titlebar: '#f5f5f7', symbol: '#65656d' }
}
export function applyNativeAppearance(mode: AppSettings['colorMode']): void {
  nativeTheme.themeSource = mode
  updateWindows()
}
function updateWindows(): void {
  for (const window of BrowserWindow.getAllWindows()) applyWindowAppearance(window)
}
export function applyWindowAppearance(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const colors = windowColors()
  window.setBackgroundColor(colors.background)
  if (process.platform === 'win32') window.setTitleBarOverlay({ color: colors.titlebar, symbolColor: colors.symbol, height: 38 })
}
nativeTheme.on('updated', updateWindows)
