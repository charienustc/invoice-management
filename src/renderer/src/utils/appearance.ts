import type { AppSettings } from '@shared/contracts'
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
let colorMode: AppSettings['colorMode'] = 'system'
function updateTheme(): void {
  const dark = colorMode === 'dark' || (colorMode === 'system' && systemTheme.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
systemTheme.addEventListener('change', updateTheme)
updateTheme()
export function applyColorMode(mode: AppSettings['colorMode']): void { colorMode = mode; updateTheme() }
