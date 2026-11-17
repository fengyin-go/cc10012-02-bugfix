import { SEED_ROWS } from './seed'
import type { EntryRow, QueryResultRecord } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-explore-studio:entries'
// 查询执行结果单独存放：语句快照、结果字段、回执与有效执行链都随结果归档。
const QUERY_RESULT_KEY = 'data-explore-studio:query-results'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 每次都从 localStorage 读最新数据：并发重试/多标签页写入后，读到的必须是同一份，
// 不能在内存里缓存一份旧快照把别人刚写入的结果盖掉。
export function allRows(): Record<string, EntryRow[]> {
  return readStorage()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function queryResultStorageKey(): string {
  return QUERY_RESULT_KEY
}

/** 读取全部查询执行结果记录（含已归档执行链），始终以持久化数据为准。 */
export function allQueryResults(): QueryResultRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(QUERY_RESULT_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as QueryResultRecord[]) : []
  } catch {
    return []
  }
}

/** 覆盖写入查询执行结果记录。 */
export function saveQueryResults(records: QueryResultRecord[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(QUERY_RESULT_KEY, JSON.stringify(records))
  }
}

/** 重置查询执行结果记录。 */
export function resetQueryResults(): void {
  saveQueryResults([])
}
