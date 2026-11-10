// 作业状态机：queued → running → completed / failed / cancelled / blocked。
// 状态变化唤醒 task_wait 的等待者；作业与日志经 node:sqlite 写穿持久化（M5），
// hub 重启后恢复历史作业（运行中/排队的作业重启后标记 failed——子进程已随 hub 消亡）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Job, JobState } from './types.js'
import { hubLog } from './bus.js'

const DB_FILE =
  process.env.HUB_JOBS_DB ?? join(homedir(), '.synapse-agent-panel', 'hub-jobs.db')

mkdirSync(dirname(DB_FILE), { recursive: true })
const db = new DatabaseSync(DB_FILE)
db.exec(`
  create table if not exists jobs (
    id text primary key,
    client_request_id text,
    role text not null,
    instruction text not null,
    state text not null,
    cwd text,
    worktree_branch text,
    created_at integer not null,
    updated_at integer not null,
    result text,
    error text
  );
  create table if not exists job_lines (
    job_id text not null,
    kind text not null,        -- log | action
    seq integer not null,
    line text not null
  );
  create table if not exists meta (key text primary key, value text);
`)

const jobs = new Map<string, Job>()
const waiters = new Map<string, Set<(j: Job) => void>>()
const byClientRequestId = new Map<string, string>()
let seq = Number(db.prepare('select value from meta where key=?').get('job_seq')?.value ?? 0)

function loadJobRow(r: Record<string, unknown>): Job {
  const lines = db
    .prepare('select kind, line from job_lines where job_id=? order by seq')
    .all(r.id as string) as { kind: string; line: string }[]
  const job: Job = {
    id: r.id as string,
    clientRequestId: (r.client_request_id as string) ?? undefined,
    role: r.role as string,
    instruction: r.instruction as string,
    state: r.state as JobState,
    cwd: (r.cwd as string) ?? undefined,
    worktreeBranch: (r.worktree_branch as string) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    result: (r.result as string) ?? undefined,
    error: (r.error as string) ?? undefined,
    actions: lines.filter((l) => l.kind === 'action').map((l) => l.line),
    log: lines.filter((l) => l.kind === 'log').map((l) => l.line),
  }
  return job
}

// 启动恢复：重启时 running/queued 的作业其子进程已消亡，标记 failed
{
  const stale = db.prepare("select id, state from jobs where state in ('running','queued')").all() as {
    id: string
  }[]
  if (stale.length)
    db
      .prepare("update jobs set state='failed', error=? where state in ('running','queued')")
      .run('hub 重启，作业随进程中断')
  for (const r of db.prepare('select * from jobs order by created_at').all() as Record<string, unknown>[]) {
    const job = loadJobRow(r)
    jobs.set(job.id, job)
    if (job.clientRequestId) byClientRequestId.set(job.clientRequestId, job.id)
  }
  if (stale.length) hubLog('INFO', `SQLite 恢复 ${jobs.size} 个作业（${stale.length} 个中断标记 failed）`)
}

function persistJob(j: Job): void {
  db.prepare(
    `insert into jobs (id, client_request_id, role, instruction, state, cwd, worktree_branch, created_at, updated_at, result, error)
     values (?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set client_request_id=excluded.client_request_id, role=excluded.role,
       instruction=excluded.instruction, state=excluded.state, cwd=excluded.cwd,
       worktree_branch=excluded.worktree_branch, updated_at=excluded.updated_at,
       result=excluded.result, error=excluded.error`,
  ).run(
    j.id,
    j.clientRequestId ?? null,
    j.role,
    j.instruction,
    j.state,
    j.cwd ?? null,
    j.worktreeBranch ?? null,
    j.createdAt,
    j.updatedAt,
    j.result ?? null,
    j.error ?? null,
  )
}

let lineSeq = 0
function persistLine(jobId: string, kind: 'log' | 'action', line: string): void {
  db.prepare('insert into job_lines (job_id, kind, seq, line) values (?,?,?,?)').run(jobId, kind, ++lineSeq, line)
}

export function createJob(role: string, instruction: string, clientRequestId?: string, cwd?: string): Job {
  const id = `job-${++seq}-${role}`
  const job: Job = {
    id,
    clientRequestId,
    role,
    instruction,
    state: 'queued',
    cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    actions: [],
    log: [],
  }
  jobs.set(id, job)
  if (clientRequestId) byClientRequestId.set(clientRequestId, id)
  db.prepare('insert or replace into meta (key, value) values (?, ?)').run('job_seq', String(seq))
  persistJob(job)
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
  persistJob(j)
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
  persistJob(j)
  hubLog('INFO', `job ${id} → ${state}`)
  const ws = waiters.get(id)
  if (ws) for (const fn of ws) fn(j)
  for (const fn of stateListeners) fn(j)
}

export function addJobAction(id: string, action: string): void {
  const j = jobs.get(id)
  if (!j) return
  const line = `${new Date().toISOString().slice(11, 19)} ${action}`
  j.actions.push(line)
  j.updatedAt = Date.now()
  persistLine(id, 'action', line)
}

export function addJobLog(id: string, line: string): void {
  const j = jobs.get(id)
  if (!j) return
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`
  j.log.push(stamped)
  persistLine(id, 'log', stamped)
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
