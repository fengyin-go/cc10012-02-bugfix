<template>
  <section class="page" data-module="query">
    <header class="page-head">
      <div>
        <h2>交互查询管理</h2>
        <p class="page-desc">维护交互查询语句的输入、执行约束与结果记录，为数据查询提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记查询语句</button>
        <button class="btn" type="button" @click="exportRows">导出交互查询清单</button>
        <button class="btn" type="button" @click="exportResultDataset">导出结果数据集</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p v-if="message" class="action-message" :data-tone="messageTone">{{ message }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th v-for="column in resultColumns" :key="column">{{ column }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td data-cell="status">{{ row.status }}</td>
          <td v-for="column in resultColumns" :key="column" :data-cell="column">
            {{ row[column] ?? '—' }}
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              :class="{ 'link-muted': !isAllowed(action, row) }"
              :title="isAllowed(action, row) ? '' : `当前状态「${row.status}」不允许「${action}」`"
              type="button"
              :data-action="action"
              :data-allowed="isAllowed(action, row)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + resultColumns.length + 2" class="empty-state">暂无交互查询数据，可先登记查询语句</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条交互查询记录 · {{ results.length }} 份合法执行结果</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel" data-panel="results">
      <header class="panel-head">
        <h3>查询执行结果数据集</h3>
        <span class="muted-text">只包含当前有效执行链，与列表、导出使用同一份数据</span>
      </header>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>结果编号</th>
            <th>语句编号</th>
            <th>执行编号</th>
            <th>结果状态</th>
            <th>结果字段</th>
            <th>结果行数</th>
            <th>触发动作</th>
            <th>触发依据</th>
            <th>结果时间</th>
            <th>回执</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="result in results" :key="result.resultId">
            <td>{{ result.resultId }}</td>
            <td>{{ result.queryNo }}</td>
            <td>{{ result.executionId }}</td>
            <td>{{ result.status }}</td>
            <td>{{ result.resultFields }}</td>
            <td>{{ result.resultRows }}</td>
            <td>{{ result.action }}</td>
            <td class="basis-cell">{{ result.basis }}</td>
            <td>{{ result.at }}</td>
            <td>{{ result.receipts.length }}</td>
          </tr>
          <tr v-if="!results.length">
            <td colspan="10" class="empty-state">暂无合法查询执行结果，执行或保存结果后会在这里归档</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel" data-panel="receipts">
      <header class="panel-head">
        <h3>执行回执与冲突判定</h3>
        <span class="muted-text">终止与完成回执无论先后都留档，导出只采用其中一条有效执行链</span>
      </header>
      <table class="data-table compact">
        <thead>
          <tr>
            <th>回执编号</th>
            <th>执行编号</th>
            <th>触发动作</th>
            <th>声明状态</th>
            <th>触发依据</th>
            <th>到达顺序</th>
            <th>是否采用</th>
            <th>冲突判定</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="receipt in receipts" :key="receipt.receiptId" :class="{ 'muted-row': !receipt.effective }">
            <td>{{ receipt.receiptId }}</td>
            <td>{{ receipt.executionId }}</td>
            <td>{{ receipt.action }}</td>
            <td>{{ receipt.status }}</td>
            <td class="basis-cell">{{ receipt.basis }}</td>
            <td>{{ receipt.sequence }}</td>
            <td>{{ receipt.effective ? '采用' : '留档' }}</td>
            <td class="basis-cell">{{ receipt.conflict || '—' }}</td>
          </tr>
          <tr v-if="!receipts.length">
            <td colspan="8" class="empty-state">暂无执行回执</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  downloadQueryResults,
  listEntries,
  listQueryReceipts,
  listQueryResults,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, QueryReceipt, QueryResultRecord } from '@/data/types'

const meta = moduleMeta('query')
const columns = ["语句编号", "查询表达式", "目标数据集", "返回字段", "排序条件", "分页大小", "最大行数", "超时秒数"]
const resultColumns = ['执行编号', '结果状态', '结果字段', '结果行数', '结果摘要', '结果时间', '回执数']
const actions = ["提交执行", "启动查询", "终止查询", "保存结果"]
const statuses = ["草稿", "待执行", "执行中", "已完成", "已超时"]

const rows = ref<EntryRow[]>([])
const results = ref<QueryResultRecord[]>([])
const receipts = ref<QueryReceipt[]>([])
const total = ref(0)
const errorMessage = ref('')
const message = ref('')
const messageTone = ref<'success' | 'error'>('success')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '查询语句总数', value: total.value },
  { label: '已完成查询', value: rows.value.filter((row) => String(row.status) === '已完成').length },
  { label: '执行中查询', value: rows.value.filter((row) => String(row.status) === '执行中').length },
])

function isAllowed(action: string, row: EntryRow): boolean {
  return availableActions(meta.key, String(row.status)).includes(action)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportResultDataset() {
  downloadQueryResults()
}

function openCreate() {
  errorMessage.value = '查询语句登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  message.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    message.value = result.message
    messageTone.value = 'error'
    return
  }
  message.value = result.message
  messageTone.value = 'success'
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    results.value = listQueryResults()
    receipts.value = listQueryReceipts()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '交互查询列表读取失败'
  }
}

onMounted(reload)
</script>
