<template>
  <el-form label-position="top" class="invoice-form" @focusin="focusField" @click="focusField">
    <div class="form-section-title">基础信息</div>
    <el-row :gutter="14">
      <el-col :span="12"><el-form-item data-field="invoiceType" label="发票类型"><el-select :model-value="model.invoiceType" filterable allow-create default-first-option placeholder="选择或输入" @update:model-value="update('invoiceType', $event)"><el-option v-for="type in invoiceTypes" :key="type" :label="type" :value="type" /></el-select></el-form-item></el-col>
      <el-col :span="12"><el-form-item data-field="invoiceDate" label="开票日期"><el-date-picker :model-value="model.invoiceDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" @update:model-value="update('invoiceDate', $event ?? '')" /></el-form-item></el-col>
      <el-col :span="12"><el-form-item data-field="invoiceCode" label="发票代码"><el-input :model-value="model.invoiceCode" placeholder="全电发票可为空" @update:model-value="update('invoiceCode', $event)" /></el-form-item></el-col>
      <el-col :span="12"><el-form-item data-field="invoiceNumber" label="发票号码"><el-input :model-value="model.invoiceNumber" placeholder="请输入发票号码" @update:model-value="update('invoiceNumber', $event)" /><el-tooltip v-if="evidenceText('invoiceNumber')" :content="evidenceText('invoiceNumber')" placement="top"><span class="evidence" tabindex="0">来自 OCR 识别</span></el-tooltip></el-form-item></el-col>
    </el-row>
    <el-divider />
    <div class="form-section-title">购买方</div>
    <el-form-item data-field="buyerName" label="名称"><el-input :model-value="model.buyerName" @update:model-value="update('buyerName', $event)" /></el-form-item>
    <el-form-item data-field="buyerTaxId" label="统一社会信用代码 / 纳税人识别号"><el-input :model-value="model.buyerTaxId" @update:model-value="update('buyerTaxId', $event)" /></el-form-item>
    <div class="form-section-title party-title">销售方</div>
    <el-form-item data-field="sellerName" label="名称"><el-input :model-value="model.sellerName" @update:model-value="update('sellerName', $event)" /></el-form-item>
    <el-form-item data-field="sellerTaxId" label="统一社会信用代码 / 纳税人识别号"><el-input :model-value="model.sellerTaxId" @update:model-value="update('sellerTaxId', $event)" /></el-form-item>
    <el-divider />
    <div class="form-section-title">金额信息 <span>单位：元</span></div>
    <el-row :gutter="14">
      <el-col :span="12"><el-form-item data-field="amountExcludingTax" label="不含税金额"><el-input-number v-model="amountYuan" :precision="2" :controls="false" :min="0" placeholder="0.00" /></el-form-item></el-col>
      <el-col :span="12"><el-form-item data-field="taxAmount" label="税额"><el-input-number v-model="taxYuan" :precision="2" :controls="false" :min="0" placeholder="0.00" /></el-form-item></el-col>
      <el-col :span="24"><el-form-item data-field="totalAmount" label="价税合计"><el-input-number v-model="totalYuan" class="total-input" :precision="2" :controls="false" :min="0" placeholder="0.00" /></el-form-item></el-col>
    </el-row>
    <el-form-item data-field="remark" label="备注"><el-input :model-value="model.remark" type="textarea" :rows="3" maxlength="2000" show-word-limit @update:model-value="update('remark', $event)" /></el-form-item>
  </el-form>
</template>

<script setup lang="ts">
import { computed, type ComputedRef } from 'vue'
import type { InvoiceFields, OcrFieldEvidence } from '@shared/contracts'

const props = defineProps<{ evidence: Partial<Record<keyof InvoiceFields, OcrFieldEvidence>> }>()
const emit = defineEmits<{ 'focus-field': [field: keyof InvoiceFields] }>()
function focusField(event: Event): void {
  const field = (event.target as HTMLElement).closest<HTMLElement>('[data-field]')?.dataset.field
  if (field) emit('focus-field', field as keyof InvoiceFields)
}
const model = defineModel<InvoiceFields>({ required: true })
const invoiceTypes = ['增值税专用发票', '增值税普通发票', '电子发票（普通发票）', '电子发票（铁路电子客票）', '电子发票（航空运输电子客票行程单）', '航空运输电子客票行程单', '电子发票', '其他发票']
function update<K extends keyof InvoiceFields>(key: K, value: InvoiceFields[K]): void { model.value = { ...model.value, [key]: value } }
function moneyModel(key: 'amountExcludingTax' | 'taxAmount' | 'totalAmount'): ComputedRef<number | undefined> {
  return computed({ get: () => model.value[key] === null ? undefined : model.value[key]! / 100, set: (value) => update(key, value === undefined ? null : Math.round(value * 100)) })
}
const amountYuan = moneyModel('amountExcludingTax')
const taxYuan = moneyModel('taxAmount')
const totalYuan = moneyModel('totalAmount')
function evidenceText(key: keyof InvoiceFields): string {
  const evidence = props.evidence[key]
  return evidence ? `OCR 证据行 ${evidence.lineId ?? '—'} · ${evidence.rule}` : ''
}
</script>

<style scoped>
.invoice-form :deep(.el-form-item) { margin-bottom: 16px; }
.invoice-form :deep(.el-form-item__label) { margin-bottom: 6px; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.4; }
.invoice-form :deep(.el-select), .invoice-form :deep(.el-date-editor), .invoice-form :deep(.el-input-number) { width: 100%; }
.form-section-title { margin-bottom: 14px; color: var(--el-text-color-primary); font-size: 14px; font-weight: 600; }
.form-section-title > span { margin-left: 8px; color: var(--muted); font-size: 11px; font-weight: 400; }
.party-title { margin-top: 22px; }
.evidence { display: inline-block; margin-top: 4px; color: var(--muted); font-size: 10px; cursor: help; }
.total-input :deep(input) { color: var(--primary); font-size: 18px; font-weight: 600; }
</style>
