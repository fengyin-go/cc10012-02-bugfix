import { MODULE_BY_KEY } from '@/data/modules'
import {
  allQueryResults,
  allRows,
  listRows,
  resetQueryResults,
  resetRows,
  saveQueryResults,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  QueryReceipt,
  QueryResultRecord,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 交互查询的终态：到了这里就不能再提交执行或重新启动，只能补登迟到的执行回执。
const QUERY_TERMINAL_STATUSES = ['已完成', '已超时']

// 终态下仍可补登的迟到回执：完成/终止两种回执到达顺序不同，但都要留档。
const QUERY_LATE_ACTIONS: Record<string, string[]> = {
  已完成: ['终止查询'],
  已超时: ['保存结果'],
}

// 查询列表附带的只读结果列，列表、回执与导出都从同一份结果记录派生。
const QUERY_RESULT_COLUMNS = ['执行编号', '结果状态', '结果字段', '结果行数', '结果摘要', '结果时间', '回执数']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowIso(): string {
  return new Date().toISOString()
}

function parsePositive(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: (string | number | boolean)[][]): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// ---------------------------------------------------------------------------
// 查询语句与执行结果
// ---------------------------------------------------------------------------

type QuerySnapshot = {
  queryId: number
  queryNo: string
  expression: string
  dataset: string
  outputFields: string
  maxRows: number
  pageSize: number
  timeoutSeconds: number
}

function snapshotOf(row: EntryRow): QuerySnapshot {
  return {
    queryId: Number(row.id),
    queryNo: String(row['语句编号'] ?? `QUERY-${row.id}`),
    expression: String(row['查询表达式'] ?? ''),
    dataset: String(row['目标数据集'] ?? ''),
    outputFields: String(row['返回字段'] ?? ''),
    maxRows: parsePositive(row['最大行数'], 500),
    pageSize: parsePositive(row['分页大小'], 50),
    timeoutSeconds: parsePositive(row['超时秒数'], 30),
  }
}

/** 结果字段只由已执行的结果生成，不再把查询配置里的占位文本直接当成结果。 */
function deriveResult(snapshot: QuerySnapshot): { resultFields: string; resultRows: number; summary: string } {
  const requested = snapshot.outputFields
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const fields = requested.length > 0 ? requested : [`${snapshot.dataset || '结果集'}默认字段`]
  const resultRows = Math.max(1, Math.min(snapshot.pageSize, snapshot.maxRows))
  return {
    resultFields: fields.join('、'),
    resultRows,
    summary: `已执行「${snapshot.expression}」，命中数据集「${snapshot.dataset}」，返回 ${resultRows} 行 / ${fields.length} 个字段`,
  }
}

function resultNo(snapshot: QuerySnapshot, attempt: number): string {
  return `RESULT-${snapshot.queryNo}-${String(attempt).padStart(3, '0')}`
}

function executionNo(snapshot: QuerySnapshot, attempt: number): string {
  return `EXEC-${snapshot.queryNo}-${String(attempt).padStart(3, '0')}`
}

function receiptNo(executionId: string, sequence: number): string {
  return `RCP-${executionId}-${String(sequence).padStart(2, '0')}`
}

function basisText(action: string, fromStatus: string, snapshot: QuerySnapshot, note = ''): string {
  const base = `按状态机，状态「${fromStatus}」允许「${action}」；语句 ${snapshot.queryNo}：${snapshot.expression} → ${snapshot.dataset}`
  return note ? `${base}；${note}` : base
}

function lateBasisText(action: string, fromStatus: string, snapshot: QuerySnapshot, note: string): string {
  return `迟到回执：状态「${fromStatus}」不主动放行「${action}」，凭回执本身登记；语句 ${snapshot.queryNo}：${snapshot.expression} → ${snapshot.dataset}；${note}`
}

function nextAttempt(queryId: number, records: QueryResultRecord[]): number {
  return (
    records
      .filter((item) => item.queryId === queryId)
      .reduce((max, item) => Math.max(max, item.attempt), 0) + 1
  )
}

function activeResults(records: QueryResultRecord[], queryId: number): QueryResultRecord[] {
  return records.filter((item) => item.queryId === queryId && item.effective)
}

function effectiveResult(records: QueryResultRecord[], queryId: number): QueryResultRecord | undefined {
  return records.find((item) => item.queryId === queryId && item.effective)
}

function terminalReceiptAt(record: QueryResultRecord): string {
  const receipt = record.receipts.find((item) => QUERY_TERMINAL_STATUSES.includes(item.status))
  return receipt?.at ?? ''
}

/** 并发重试产生的多条有效记录只保留一条：先到终态的、执行次数早的优先。 */
function compareActiveResults(left: QueryResultRecord, right: QueryResultRecord): number {
  const leftTerminal = QUERY_TERMINAL_STATUSES.includes(left.status)
  const rightTerminal = QUERY_TERMINAL_STATUSES.includes(right.status)
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? -1 : 1
  }
  if (leftTerminal && rightTerminal) {
    const leftAt = terminalReceiptAt(left)
    const rightAt = terminalReceiptAt(right)
    if (leftAt !== rightAt) {
      return leftAt.localeCompare(rightAt)
    }
  }
  if (left.attempt !== right.attempt) {
    return left.attempt - right.attempt
  }
  return left.id - right.id
}

function makeReceipt(
  record: QueryResultRecord,
  input: {
    action: string
    status: string
    basis: string
    effective: boolean
    conflict?: string
    alternativeSummary?: string
    alternativeRows?: number
  },
): QueryReceipt {
  const sequence = record.receipts.length + 1
  return {
    receiptId: receiptNo(record.executionId, sequence),
    executionId: record.executionId,
    action: input.action,
    basis: input.basis,
    status: input.status,
    at: nowIso(),
    sequence,
    effective: input.effective,
    conflict: input.conflict ?? '',
    alternativeSummary: input.alternativeSummary,
    alternativeRows: input.alternativeRows,
  }
}

function makeExecutingResult(
  row: EntryRow,
  records: QueryResultRecord[],
  fromStatus: string,
  withStartReceipt = true,
  basisOverride = '',
): QueryResultRecord {
  const snapshot = snapshotOf(row)
  const attempt = nextAttempt(snapshot.queryId, records)
  const executionId = executionNo(snapshot, attempt)
  const timestamp = nowIso()
  const basis = basisOverride || basisText('启动查询', fromStatus, snapshot)
  const result: QueryResultRecord = {
    id: records.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    resultId: resultNo(snapshot, attempt),
    queryId: snapshot.queryId,
    queryNo: snapshot.queryNo,
    expression: snapshot.expression,
    dataset: snapshot.dataset,
    outputFields: snapshot.outputFields,
    executionId,
    attempt,
    status: '执行中',
    resultFields: '待返回',
    resultRows: 0,
    summary: `查询已启动，表达式「${snapshot.expression}」，等待数据集「${snapshot.dataset}」返回`,
    action: '启动查询',
    basis,
    at: timestamp,
    updatedAt: timestamp,
    sequence: 1,
    effective: true,
    archivedReason: '',
    conflict: '',
    receipts: [],
  }
  if (withStartReceipt) {
    result.receipts.push(
      makeReceipt(result, {
        action: '启动查询',
        status: '执行中',
        basis: result.basis,
        effective: true,
      }),
    )
  }
  return result
}

/** 根据列表当前状态补一条可核查的结果记录，用于修复历史数据里结果缺失的情况。 */
function makeRepairedResult(row: EntryRow, records: QueryResultRecord[]): QueryResultRecord {
  const snapshot = snapshotOf(row)
  const attempt = nextAttempt(snapshot.queryId, records)
  const executionId = executionNo(snapshot, attempt)
  const timestamp = nowIso()
  const status = String(row.status)
  if (status === '执行中') {
    return makeExecutingResult(row, records, status)
  }
  const completed = status === '已完成'
  const derived = deriveResult(snapshot)
  const action = completed ? '保存结果' : '终止查询'
  const result: QueryResultRecord = {
    id: records.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    resultId: resultNo(snapshot, attempt),
    queryId: snapshot.queryId,
    queryNo: snapshot.queryNo,
    expression: snapshot.expression,
    dataset: snapshot.dataset,
    outputFields: snapshot.outputFields,
    executionId,
    attempt,
    status,
    resultFields: completed ? derived.resultFields : '无结果',
    resultRows: completed ? derived.resultRows : 0,
    summary: completed ? derived.summary : '查询已终止，未产出结果',
    action,
    basis: `由列表当前状态「${status}」恢复的结果记录；语句 ${snapshot.queryNo}：${snapshot.expression} → ${snapshot.dataset}`,
    at: timestamp,
    updatedAt: timestamp,
    sequence: 1,
    effective: true,
    archivedReason: '',
    conflict: '',
    receipts: [],
  }
  result.receipts.push(
    makeReceipt(result, {
      action,
      status,
      basis: result.basis,
      effective: true,
    }),
  )
  return result
}

function persistQueryResults(records: QueryResultRecord[]): void {
  saveQueryResults(records)
}

/**
 * 列表/动作前的对账：
 * - 执行中、已完成、已超时的查询必须有一条有效结果记录，缺了就按当前状态恢复；
 * - 草稿、待执行不应该挂着有效结果，旧结果归档但不删除；
 * - 并发重试留下多条有效记录时只保留一条，其余归档；
 * - 结果状态与列表状态不一致时保留已经产出的结果，把列表状态推进/对齐到结果状态，
 *   避免状态回退把有效结果冲掉。
 */
export function ensureQueryResults(): QueryResultRecord[] {
  const records = allQueryResults().map(clone)
  const rows = listRows('query')
  const rowUpdates = new Map<number, EntryRow>()
  let changed = false

  for (const row of rows) {
    const queryId = Number(row.id)
    const status = String(row.status)
    const owned = records.filter((item) => item.queryId === queryId)

    if (status === '草稿' || status === '待执行') {
      for (const item of owned) {
        if (item.effective) {
          item.effective = false
          item.archivedReason = `当前状态「${status}」不接受执行结果，旧结果已归档`
          changed = true
        }
      }
      continue
    }

    if (owned.length === 0) {
      records.push(makeRepairedResult(row, records))
      changed = true
      continue
    }

    let active = activeResults(records, queryId)
    if (active.length === 0) {
      const reusable = [...owned]
        .sort((left, right) => right.attempt - left.attempt || right.id - left.id)
        .find((item) => item.status === status)
      if (reusable) {
        reusable.effective = true
        reusable.archivedReason = ''
        changed = true
        active = [reusable]
      } else {
        records.push(makeRepairedResult(row, records))
        changed = true
        continue
      }
    }

    if (active.length > 1) {
      const [keep, ...duplicates] = [...active].sort(compareActiveResults)
      for (const item of duplicates) {
        item.effective = false
        item.archivedReason = '并发重试产生重复结果，仅保留一份有效结果记录'
        item.conflict = item.conflict || `与 ${keep.resultId} 重复，已归档`
        changed = true
      }
      active = [keep]
    }

    const current = active[0]
    if (status === '执行中' && QUERY_TERMINAL_STATUSES.includes(current.status)) {
      // 列表状态被回退，但结果已经跑完：保留结果，把状态推进回结果状态，避免结果丢失。
      rowUpdates.set(queryId, {
        ...row,
        status: current.status,
        pending: false,
        abnormal: current.status === '已超时',
      })
      changed = true
    } else if (status !== '执行中' && current.status === '执行中') {
      // 列表已经是终态，但结果还停在执行中：归档未完成结果，再按终态补一条。
      current.effective = false
      current.archivedReason = `结果仍为「执行中」与当前状态「${status}」不一致，已归档`
      records.push(makeRepairedResult(row, records))
      changed = true
    } else if (status !== '执行中' && current.status !== status) {
      // 两种终态冲突（例如状态回退后又被改成另一个终态）：结果已经产生，保留原有效链，
      // 只把列表状态对齐到结果，避免把合法结果冲掉。
      rowUpdates.set(queryId, {
        ...row,
        status: current.status,
        pending: false,
        abnormal: current.status === '已超时',
      })
      changed = true
    }
  }

  if (rowUpdates.size > 0) {
    saveRows(
      'query',
      rows.map((row) => rowUpdates.get(Number(row.id)) ?? row),
    )
  }
  if (changed) {
    persistQueryResults(records)
  }
  return records
}

/** 合法查询执行结果数据集：只包含当前有效执行链。 */
export function listQueryResults(queryId?: number): QueryResultRecord[] {
  const records = ensureQueryResults().filter((item) => item.effective)
  return (queryId === undefined ? records : records.filter((item) => item.queryId === queryId))
    .sort((left, right) => left.queryId - right.queryId || right.attempt - left.attempt)
    .map(clone)
}

/** 全部回执（含冲突留档），用于页面回执区与审计。 */
export function listQueryReceipts(queryId?: number): QueryReceipt[] {
  const records = ensureQueryResults().filter(
    (item) => queryId === undefined || item.queryId === queryId,
  )
  return records
    .flatMap((item) => item.receipts.map((receipt) => ({ ...receipt, resultId: item.resultId, queryNo: item.queryNo })))
    .sort((left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence)
}

/** 查询列表附带当前有效结果，列表、回执与导出共用同一份数据集。 */
function attachQueryResults(rows: EntryRow[], results: QueryResultRecord[]): EntryRow[] {
  const byQuery = new Map<number, QueryResultRecord>()
  for (const result of results) {
    if (result.effective) {
      byQuery.set(result.queryId, result)
    }
  }
  return rows.map((row) => {
    const result = byQuery.get(Number(row.id))
    if (!result) {
      return row
    }
    return {
      ...row,
      执行编号: result.executionId,
      结果状态: result.status,
      结果字段: result.resultFields,
      结果行数: result.resultRows,
      结果摘要: result.summary,
      结果时间: result.at,
      回执数: result.receipts.length,
    }
  })
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === 'query') {
    const results = listQueryResults()
    const matched = filterRows(attachQueryResults(listRows('query'), results), filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length, results }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 当前状态下允许发起的动作，页面不再把所有动作都摊在每一行上。 */
export function availableActions(key: string, status: string): string[] {
  const meta = moduleMeta(key)
  return meta.actions.filter((action) => {
    const allowed = meta.transitions?.[action]
    if (allowed) {
      if (allowed.includes(status)) {
        return true
      }
      // 交互查询的终态允许补登反方向的迟到回执，但仍然只留档、不推进状态。
      return key === 'query' && (QUERY_LATE_ACTIONS[status] ?? []).includes(action)
    }
    return meta.actionTargets[action] !== status
  })
}

function saveQueryRow(rows: EntryRow[], index: number, status: string): EntryRow {
  const updated: EntryRow = {
    ...rows[index],
    status,
    pending: status === '草稿' || status === '待执行',
    abnormal: status === '已超时',
  }
  const next = [...rows]
  next[index] = updated
  saveRows('query', next)
  return updated
}

function archiveOtherResults(
  records: QueryResultRecord[],
  queryId: number,
  keep: QueryResultRecord | undefined,
  reason: string,
): void {
  for (const item of records) {
    if (item.queryId === queryId && item !== keep && item.effective) {
      item.effective = false
      item.archivedReason = reason
    }
  }
}

function runQueryAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
): ActionResult {
  const row = rows[index]
  const current = String(row.status)
  const allowed = meta.transitions?.[action] ?? []
  const records = allQueryResults().map(clone)
  const queryId = Number(row.id)
  const snapshot = snapshotOf(row)

  // 迟到回执：完成回执与终止回执可能以任意先后到达。先到的终态构成有效执行链，
  // 后到的只留档并写明各自触发依据，不回退状态、不进入导出。
  if (current === '已完成' && action === '终止查询') {
    const result = effectiveResult(records, queryId)
    if (!result) {
      return { ok: false, message: '没有找到可挂接的查询结果记录，无法登记迟到的终止回执' }
    }
    const basis = lateBasisText('终止查询', current, snapshot, '完成回执先到达，终止回执后到达')
    const conflict = `冲突：先到达的「${result.action}」回执（${result.basis}）判定为有效执行链；后到达的「终止查询」回执（${basis}）仅留档，不改变结果状态与导出数据`
    const receipt = makeReceipt(result, {
      action: '终止查询',
      status: '已超时',
      basis,
      effective: false,
      conflict,
      alternativeSummary: `终止回执声称查询已终止，未产出结果（对照：有效链返回 ${result.resultRows} 行 / ${result.resultFields}）`,
      alternativeRows: 0,
    })
    result.receipts.push(receipt)
    result.conflict = conflict
    result.sequence = receipt.sequence
    result.updatedAt = receipt.at
    persistQueryResults(records)
    return {
      ok: true,
      message: `查询已完成，迟到的终止回执已留档；当前状态保持「${current}」`,
      receipt: clone(receipt),
      result: clone(result),
    }
  }

  if (current === '已超时' && action === '保存结果') {
    const result = effectiveResult(records, queryId)
    if (!result) {
      return { ok: false, message: '没有找到可挂接的查询结果记录，无法登记迟到的完成回执' }
    }
    const derived = deriveResult(snapshot)
    const basis = lateBasisText('保存结果', current, snapshot, '终止回执先到达，完成回执后到达')
    const conflict = `冲突：先到达的「${result.action}」回执（${result.basis}）判定为有效执行链；后到达的「保存结果」回执（${basis}）仅留档，不改变结果状态与导出数据`
    const receipt = makeReceipt(result, {
      action: '保存结果',
      status: '已完成',
      basis,
      effective: false,
      conflict,
      alternativeSummary: `完成回执声称返回 ${derived.resultRows} 行 / ${derived.resultFields}（对照：有效链为终止，未产出结果）`,
      alternativeRows: derived.resultRows,
    })
    result.receipts.push(receipt)
    result.conflict = conflict
    result.sequence = receipt.sequence
    result.updatedAt = receipt.at
    persistQueryResults(records)
    return {
      ok: true,
      message: `查询已超时，迟到的完成回执已留档；当前状态保持「${current}」`,
      receipt: clone(receipt),
      result: clone(result),
    }
  }

  if (!allowed.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前状态「${current}」不允许「${action}」（允许来源状态：${allowed.join('、') || '无'}）`,
    }
  }

  if (action === '提交执行') {
    saveQueryRow(rows, index, '待执行')
    return { ok: true, message: `${meta.entity}已提交执行，当前状态「待执行」` }
  }

  if (action === '启动查询') {
    if (current === '执行中') {
      const active = effectiveResult(records, queryId)
      if (active) {
        // 重复启动/竞态重试：状态不再推进，结果也只保留这一份。
        return {
          ok: true,
          deduped: true,
          message: '查询已在执行中，重复启动已合并，仅保留一份结果记录',
          result: clone(active),
        }
      }
      const repaired = makeExecutingResult(row, records, current)
      archiveOtherResults(records, queryId, repaired, '重复启动合并，旧结果归档')
      records.push(repaired)
      persistQueryResults(records)
      return {
        ok: true,
        message: '查询已在执行中，已补齐唯一结果记录',
        result: clone(repaired),
      }
    }

    // 待执行 → 执行中。若此前有回退遗留的结果，归档旧链，只保留这一份新链。
    const result = makeExecutingResult(row, records, current)
    archiveOtherResults(records, queryId, result, '重新启动查询，旧执行链归档')
    records.push(result)
    persistQueryResults(records)
    saveQueryRow(rows, index, '执行中')
    return {
      ok: true,
      message: `${meta.entity}已启动查询，当前状态「执行中」`,
      result: clone(result),
    }
  }

  if (action === '保存结果') {
    const existing = effectiveResult(records, queryId)
    const derived = deriveResult(snapshot)
    const basis = basisText(
      '保存结果',
      current,
      snapshot,
      `结果字段：${derived.resultFields}；返回 ${derived.resultRows} 行`,
    )
    const result = existing ?? makeExecutingResult(row, records, current, false, basis)
    if (!existing) {
      records.push(result)
    }
    result.status = '已完成'
    result.resultFields = derived.resultFields
    result.resultRows = derived.resultRows
    result.summary = derived.summary
    result.action = '保存结果'
    result.basis = basis
    result.at = nowIso()
    result.updatedAt = result.at
    result.effective = true
    result.archivedReason = ''
    const receipt = makeReceipt(result, {
      action: '保存结果',
      status: '已完成',
      basis,
      effective: true,
    })
    result.receipts.push(receipt)
    result.sequence = receipt.sequence
    persistQueryResults(records)
    saveQueryRow(rows, index, '已完成')
    return {
      ok: true,
      message: `${meta.entity}已保存结果，当前状态「已完成」`,
      receipt: clone(receipt),
      result: clone(result),
    }
  }

  if (action === '终止查询') {
    const existing = effectiveResult(records, queryId)
    const basis = basisText('终止查询', current, snapshot, '终止回执先到达，作为有效执行链')
    const result = existing ?? makeExecutingResult(row, records, current, false, basis)
    if (!existing) {
      records.push(result)
    }
    result.status = '已超时'
    result.resultFields = '无结果'
    result.resultRows = 0
    result.summary = '查询已终止，未产出结果'
    result.action = '终止查询'
    result.basis = basis
    result.at = nowIso()
    result.updatedAt = result.at
    result.effective = true
    result.archivedReason = ''
    const receipt = makeReceipt(result, {
      action: '终止查询',
      status: '已超时',
      basis,
      effective: true,
    })
    result.receipts.push(receipt)
    result.sequence = receipt.sequence
    persistQueryResults(records)
    saveQueryRow(rows, index, '已超时')
    return {
      ok: true,
      message: `${meta.entity}已终止查询，当前状态「已超时」`,
      receipt: clone(receipt),
      result: clone(result),
    }
  }

  return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === 'query') {
    ensureQueryResults()
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)

  if (key === 'query') {
    return runQueryAction(meta, rows, index, action)
  }

  const allowed = meta.transitions?.[action]
  if (allowed && !allowed.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前状态「${current}」不允许「${action}」（允许来源状态：${allowed.join('、')}）`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'query') {
    resetQueryResults()
    ensureQueryResults()
  }
  return listEntries(key)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === 'query') {
    const rows = attachQueryResults(listRows('query'), listQueryResults())
    const header = ['编号', ...meta.fields, '当前状态', ...QUERY_RESULT_COLUMNS]
    const lines: (string | number | boolean)[][] = [header]
    for (const row of rows) {
      lines.push([
        row.id,
        ...meta.fields.map((field) => row[field] ?? ''),
        row.status,
        ...QUERY_RESULT_COLUMNS.map((field) => row[field] ?? ''),
      ])
    }
    return { filename: `${meta.name}-清单.csv`, content: toCsv(lines) }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines: (string | number | boolean)[][] = [header]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status])
  }
  return { filename: `${meta.name}-清单.csv`, content: toCsv(lines) }
}

/** 合法查询执行结果数据集导出：一条记录对应一条可核查的有效执行链。 */
export function exportQueryResults(): { filename: string; content: string } {
  const results = listQueryResults()
  const header = [
    '结果编号',
    '执行编号',
    '尝试次数',
    '语句编号',
    '查询表达式',
    '目标数据集',
    '返回字段',
    '结果状态',
    '结果字段',
    '结果行数',
    '结果摘要',
    '触发动作',
    '触发依据',
    '结果时间',
    '回执数',
    '冲突说明',
  ]
  const lines: (string | number | boolean)[][] = [header]
  for (const result of results) {
    lines.push([
      result.resultId,
      result.executionId,
      result.attempt,
      result.queryNo,
      result.expression,
      result.dataset,
      result.outputFields,
      result.status,
      result.resultFields,
      result.resultRows,
      result.summary,
      result.action,
      result.basis,
      result.at,
      result.receipts.length,
      result.conflict,
    ])
  }
  return { filename: '交互查询-结果数据集.csv', content: toCsv(lines) }
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  download(filename, content)
}

export function downloadQueryResults(): void {
  const { filename, content } = exportQueryResults()
  download(filename, content)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
