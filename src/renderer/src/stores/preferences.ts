import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/contracts'
import { applyColorMode } from '@/utils/appearance'

export const usePreferencesStore = defineStore('preferences', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_APP_SETTINGS })
  const loaded = ref(false)
  let loading: Promise<void> | undefined
  function apply(value: AppSettings): void {
    settings.value = value
    document.documentElement.dataset.motion = value.motion
    document.documentElement.dataset.density = value.density
    document.documentElement.style.setProperty('--ui-zoom', String(value.uiScale / 100))
    applyColorMode(value.colorMode)
  }
  function load(force = false): Promise<void> {
    if (loaded.value && !force) return Promise.resolve()
    return loading ??= api.getAppSettings().then((value) => { apply(value); loaded.value = true }).finally(() => { loading = undefined })
  }
  async function save(value: AppSettings): Promise<AppSettings> {
    const saved = await api.saveAppSettings(value)
    apply(saved)
    return saved
  }
  return { settings, loaded, load, save }
})
