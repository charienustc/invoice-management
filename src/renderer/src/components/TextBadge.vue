<template>
  <span class="text-badge" :class="[`badge-${variant}`, `tone-${tone}`]" :title="label">
    <span v-if="variant === 'status'" class="badge-dot" aria-hidden="true" />
    <span class="badge-text">{{ label }}</span>
    <button v-if="removable" type="button" class="badge-remove" :aria-label="`移除${label}`" @click.stop="emit('remove')"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3.5 3.5 5 5m0-5-5 5" /></svg></button>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label: string; variant?: 'tag' | 'status' | 'filter' | 'count'; tone?: 'info' | 'primary' | 'success' | 'warning' | 'danger'; removable?: boolean }>(), { variant: 'tag', tone: 'info', removable: false })
const emit = defineEmits<{ remove: [] }>()
</script>

<style scoped>
.text-badge { --badge-ink: #5c6677; --badge-fill: #f0f2f6; --badge-border: #e4e7ee; display: inline-flex; align-items: center; vertical-align: middle; gap: 5px; min-width: 0; max-width: 100%; height: 22px; padding: 0 7px; border: 1px solid var(--badge-border); border-radius: 6px; color: var(--badge-ink); background: var(--badge-fill); font-size: 11px; font-weight: 500; line-height: 1; white-space: nowrap; }
.badge-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tone-primary { --badge-ink: var(--primary); --badge-fill: var(--el-color-primary-light-9); --badge-border: var(--el-color-primary-light-8); }
.tone-success { --badge-ink: #39765e; --badge-fill: #eef6f1; --badge-border: #e0ece4; }
.tone-warning { --badge-ink: #956c2f; --badge-fill: #faf5e9; --badge-border: #eee5d0; }
.tone-danger { --badge-ink: #b45150; --badge-fill: #fbf0ef; --badge-border: #f1e0df; }
.badge-status { height: 23px; padding: 0 7px; border-color: transparent; font-weight: 400; }
.badge-dot { flex: none; width: 5px; height: 5px; background: currentColor; border-radius: 50%; opacity: .8; }
.badge-count { height: 20px; padding: 0 5px; border-color: transparent; font-size: 10px; font-variant-numeric: tabular-nums; }
.badge-filter { height: 28px; padding: 0 5px 0 9px; gap: 7px; background: light-dark(#f7f9fc, #292a2f); border-color: light-dark(#dfe5ee, #393b43); color: #52667f; font-weight: 400; }
.badge-remove { flex: none; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; color: light-dark(#8a97a8, #b5b6c1); background: transparent; border: 0; border-radius: 4px; cursor: pointer; transition: color 120ms, background 120ms; }
.badge-remove:hover { color: #435a75; background: light-dark(#e5ebf3, #292a2f); }.badge-remove:active { background: light-dark(#dae3ee, #363840); }.badge-remove svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
</style>
