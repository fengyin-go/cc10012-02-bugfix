/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /**
   * 状态机：动作 -> 允许的来源状态。没有登记 transitions 的模块沿用原来的宽松流转，
   * 登记过的模块（交互查询）只允许从这些状态发起动作。
   */
  transitions?: Record<string, string[]>
  metrics: string[]
}

/**
 * 查询执行回执。终止回执与完成回执可能乱序到达，因此每条回执都单独留存触发依据、
 * 到达顺序和是否被采用，不能相互覆盖。
 */
export type QueryReceipt = {
  /** 回执编号 */
  receiptId: string
  /** 对应的执行编号 */
  executionId: string
  /** 触发动作：启动查询 / 终止查询 / 保存结果 */
  action: string
  /** 触发依据（人可读的说明） */
  basis: string
  /** 该回执声明的结果状态 */
  status: string
  /** 到达时间（ISO 字符串） */
  at: string
  /** 到达顺序，从 1 开始 */
  sequence: number
  /** 是否被最终结果采用 */
  effective: boolean
  /** 冲突说明；没有冲突时为空字符串 */
  conflict: string
  /** 备选结果摘要（例如终止后迟到的完成回执），用于审计，不直接进入导出 */
  alternativeSummary?: string
  /** 备选结果行数 */
  alternativeRows?: number
  /** 回执所属结果编号（回执列表回填） */
  resultId?: string
  /** 回执所属语句编号（回执列表回填） */
  queryNo?: string
}

/**
 * 一条合法的查询执行结果记录。查询语句的快照（语句编号/表达式/目标数据集/返回字段）
 * 与执行结果一起归档，刷新后仍可回查。
 */
export type QueryResultRecord = {
  id: number
  /** 结果编号 */
  resultId: string
  queryId: number
  /** 语句编号（查询语句快照） */
  queryNo: string
  /** 查询表达式（查询语句快照） */
  expression: string
  /** 目标数据集（查询语句快照） */
  dataset: string
  /** 返回字段（查询语句快照） */
  outputFields: string
  /** 执行编号 */
  executionId: string
  /** 第几次执行，用于识别重试/回退 */
  attempt: number
  /** 结果状态：执行中 / 已完成 / 已超时 */
  status: string
  /** 结果字段 */
  resultFields: string
  /** 结果行数 */
  resultRows: number
  /** 结果摘要 */
  summary: string
  /** 最终采用的触发动作 */
  action: string
  /** 最终采用的触发依据 */
  basis: string
  /** 结果时间（ISO 字符串） */
  at: string
  /** 最近更新时间（ISO 字符串） */
  updatedAt: string
  /** 到达顺序（最后一条回执的序号） */
  sequence: number
  /** 是否是当前有效执行链 */
  effective: boolean
  /** 归档原因（被新执行链替换时写入） */
  archivedReason: string
  /** 冲突说明 */
  conflict: string
  /** 全部回执（含冲突回执） */
  receipts: QueryReceipt[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  /** 交互查询模块同时返回合法结果数据集，方便列表和回执共用同一份数据 */
  results?: QueryResultRecord[]
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 本次动作产生的/命中的回执 */
  receipt?: QueryReceipt
  /** 本次动作对应的合法结果记录 */
  result?: QueryResultRecord
  /** 是否命中幂等（重复启动/重复保存等重试） */
  deduped?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
