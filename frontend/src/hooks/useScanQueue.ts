/**
 * useScanQueue：台班容量与排队编排（影像室侧规则）
 *
 * 规则（题目口径）：
 * - 一个台班的容量 = 该扫描仪 capacityPerShift（冗余在 ScanShift.capacity）；
 * - 容量按「在册名额」计：排队 + 在扫占位，扫毕 / 退回不占新名额；
 * - 正在扫的那册不被后来的挤掉：任务一经排入，queueNo 固定，只往后不插队；
 * - 台班容量到顶后，新到的册排队等下一班。
 */
import { computed, type MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'
import type { ScanJob } from '@/types/scanJob'
import { isJobOccupying, isJobProtected } from '@/types/scanJob'
import type { ScanShift } from '@/types/scanShift'

/** 该台班当前占用名额数 */
export function occupiedCount(jobs: ScanJob[], shiftId: string): number {
  return jobs.filter((job) => job.shiftId === shiftId && isJobOccupying(job.state)).length
}

/** 台班剩余名额 */
export function freeSlots(shift: Pick<ScanShift, 'id' | 'capacity'>, jobs: ScanJob[]): number {
  return Math.max(0, shift.capacity - occupiedCount(jobs, shift.id))
}

export interface ShiftCapacity {
  occupied: number
  free: number
  full: boolean
  /** 在扫册数（受保护名额） */
  scanning: number
  /** 排队册数 */
  queued: number
}

export function shiftCapacity(shift: Pick<ScanShift, 'id' | 'capacity'>, jobs: ScanJob[]): ShiftCapacity {
  const inShift = jobs.filter((job) => job.shiftId === shift.id)
  const occupied = inShift.filter((job) => isJobOccupying(job.state)).length
  const scanning = inShift.filter((job) => job.state === 'scanning').length
  const queued = inShift.filter((job) => job.state === 'queued').length
  return { occupied, free: Math.max(0, shift.capacity - occupied), full: occupied >= shift.capacity, scanning, queued }
}

/**
 * 为新登记的册选择排入台班：
 * 优先当前选中台班（容量未满），否则找该扫描仪最近一个有名额的开放台班，都满则返回 null（需开下一班）。
 * 不重排已有任务，保证正在扫的册不被挤掉。
 */
export function pickShiftForNewJob(
  jobs: ScanJob[],
  shifts: ScanShift[],
  preferredShiftId: string | null,
  scannerId: string
): ScanShift | null {
  const candidates = shifts
    .filter((shift) => shift.scannerId === scannerId && shift.state !== 'closed')
    .sort((a, b) => (a.workDate === b.workDate ? a.slot.localeCompare(b.slot) : a.workDate.localeCompare(b.workDate)))
  const preferred = preferredShiftId ? candidates.find((shift) => shift.id === preferredShiftId) : undefined
  if (preferred && freeSlots(preferred, jobs) > 0) return preferred
  return candidates.find((shift) => freeSlots(shift, jobs) > 0) ?? null
}

/** 新任务在某台班的排队序号：接在现有最大序号之后（绝不插到在扫册前面） */
export function nextQueueNo(jobs: ScanJob[], shiftId: string): number {
  const nos = jobs.filter((job) => job.shiftId === shiftId).map((job) => job.queueNo)
  return nos.length === 0 ? 1 : Math.max(...nos) + 1
}

/**
 * 排队任务可否开始扫描：必须是队列最前的一册。
 * 排队 → 在扫只是状态前移、仍占同一个名额，不额外消耗容量。
 */
export function canStartScanning(jobs: ScanJob[], shiftId: string, job: ScanJob): boolean {
  if (job.shiftId !== shiftId || job.state !== 'queued') return false
  const ahead = jobs
    .filter((item) => item.shiftId === shiftId && item.state === 'queued')
    .sort((a, b) => a.queueNo - b.queueNo)
  return ahead[0]?.id === job.id
}

export function useScanQueue(
  shifts: MaybeRefOrGetter<ScanShift[]>,
  jobs: MaybeRefOrGetter<ScanJob[]>
) {
  const capacityOf = (shiftId: string): ShiftCapacity => {
    const shift = toValue(shifts).find((item) => item.id === shiftId)
    if (!shift) return { occupied: 0, free: 0, full: true, scanning: 0, queued: 0 }
    return shiftCapacity(shift, toValue(jobs))
  }
  const protectedJobs = computed(() => toValue(jobs).filter((job) => isJobProtected(job.state)))
  return { capacityOf, occupiedCount, freeSlots, protectedJobs }
}
