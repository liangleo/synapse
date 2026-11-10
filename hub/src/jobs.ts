// 作业状态机：queued → running → completed / failed / cancelled / blocked。
// 状态变化唤醒 task_wait 的等待者；结果与动作日志存内存（M1），SQLite 为 M5。
import type { Job, JobState } from './types.js'
import { hubLog } from './bus.js'

const jobs = new Map<string, Job>()
const waiters = new Map<string, Set<(j: Job) => void>>()
const byClientRequestId = new Map<string, string>()
let seq = 0

export function createJob(role: string, instruction: string, clientRequestId?: string): Job {
  const id = `job-${++seq}-${role}`
  const job: Job = {
    id,
    clientRequestId,
    role,
    instruction,
    state: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    actions: [],
    log: [],
  }
  jobs.set(id, job)
  if (clientRequestId) byClientRequestId.set(clientRequestId, id)
  return job
}

export function findByClientRequestId(cid: string): Job | undefined {
  const id = byClientRequestId.get(cid)
  return id ? jobs.get(id) : undefined
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function listJobs(role?: string, jobIds?: string[]): Job[] {
  let all = [...jobs.values()]
  if (jobIds?.length) all = jobIds.map((id) => jobs.get(id)).filter((j): j is Job => Boolean(j))
  else if (role) all = all.filter((j) => j.role === role)
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  Object.assign(j, patch, { updatedAt: Date.now() })
  const ws = waiters.get(id)
  if (ws) for (const fn of ws) fn(j)
  return j
}

// 按状态名更新 + 记录动作 + 通知监听者（调度器据此启动排队作业）
const stateListeners = new Set<(j: Job) => void>()
export function onJobStateChange(fn: (j: Job) => void): void {
  stateListeners.add(fn)
}
export function setJobState(id: string, state: JobState, extra?: Partial<Job>): void {
  const j = jobs.get(id)
  if (!j) return
  j.state = state
  if (extra) Object.assign(j, extra)
  j.updatedAt = Date.now()
  hubLog('INFO', `job ${id} → ${state}`)
  const ws = waiters.get(id)
  if (ws) for (const fn of ws) fn(j)
  for (const fn of stateListeners) fn(j)
}

export function addJobAction(id: string, action: string): void {
  const j = jobs.get(id)
  if (!j) return
  j.actions.push(`${new Date().toISOString().slice(11, 19)} ${action}`)
  j.updatedAt = Date.now()
}

export function addJobLog(id: string, line: string): void {
  const j = jobs.get(id)
  if (!j) return
  j.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
}

// 等待某个 job 的下一次状态变化或超时
export function waitFor(id: string, timeoutMs: number): Promise<Job | undefined> {
  const j = jobs.get(id)
  if (!j) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let done = false
    const finish = (result: Job | undefined) => {
      if (done) return
      done = true
      const ws = waiters.get(id)
      if (ws) {
        ws.delete(fn)
        if (!ws.size) waiters.delete(id)
      }
      clearTimeout(timer)
      resolve(result)
    }
    const fn = (updated: Job) => finish(updated)
    if (!waiters.has(id)) waiters.set(id, new Set())
    waiters.get(id)!.add(fn)
    const timer = setTimeout(() => finish(undefined), timeoutMs)
  })
}

// 供 task_result 使用：最终产出（assistant 文本）在 run 结束时写入 job.result
