import type { InjectionKey, Ref } from 'vue'

export const sidebarKey: InjectionKey<Ref<boolean>> = Symbol('sidebar')
