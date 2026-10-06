/**
 * 修后影像 store（Pinia setup store）
 * 影像室视角：台班登记、册次排队、扫描推进、漏扫拍糊补拍与缺册号认领。
 * 与修复室的册次 / 书叶 / 工序记录各自独立（两边各记各的），
 * 只向装订环节输出「影像是否齐」这一结论。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { ScanShift, ScanShiftDraft } from '@/types/scanShift'
import {
  isVolumeImagingReady,
  type ScanDefectReason,
  type ScanTask
} from '@/types/scanTask'
import type { Volume } from '@/types/volume'

export interface ImagingActionResult {
  ok: boolean
  reason: string
}

export interface EnqueueResult extends ImagingActionResult {
  task: ScanTask | null
  shift: ScanShift | null
}

const ok = (): ImagingActionResult => ({ ok: true, reason: '' })
const fail = (reason: string): ImagingActionResult => ({ ok: false, reason })

export const useImagingStore = defineStore('imaging', () => {
  const shifts = ref<ScanShift[]>([])
  const tasks = ref<ScanTask[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  /** 台班按日期先后排列（同日按登记先后），排队时从前往后找空位 */
  const sortedShifts = computed<ScanShift[]>(() =>
    [...shifts.value].sort((a, b) =>
      a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date)
    )
  )

  /** 缺册号的历史影像记录：只读，等人认领 */
  const orphanTasks = computed<ScanTask[]>(() => tasks.value.filter((task) => task.volumeId === null))

  const queuedCount = computed<number>(() => tasks.value.filter((task) => task.state === 'queued').length)
  const scanningCount = computed<number>(() => tasks.value.filter((task) => task.state === 'scanning').length)
  const producedTotal = computed<number>(() =>
    tasks.value.filter((task) => task.state === 'done').reduce((sum, task) => sum + task.imageCount, 0)
  )
  const defectPendingCount = computed<number>(() => tasks.value.filter((task) => task.defectCount > 0).length)

  async function loadShifts(): Promise<void> {
    const rows = await db.scanShifts.toArray()
    shifts.value = rows
  }

  async function loadTasks(): Promise<void> {
    const rows = await db.scanTasks.toArray()
    tasks.value = rows
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      await Promise.all([loadShifts(), loadTasks()])
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '影像数据读取失败'
    } finally {
      loading.value = false
    }
  }

  function shiftById(id: string): ScanShift | undefined {
    return shifts.value.find((shift) => shift.id === id)
  }

  function tasksOfShift(shiftId: string): ScanTask[] {
    return tasks.value
      .filter((task) => task.shiftId === shiftId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  function tasksOfVolume(volumeId: string): ScanTask[] {
    return tasks.value.filter((task) => task.volumeId === volumeId)
  }

  /** 台班已占用的册次任务数（当天扫了哪几册，扫完也占位） */
  function occupiedOf(shiftId: string): number {
    return tasksOfShift(shiftId).length
  }

  function isShiftFull(shift: ScanShift): boolean {
    return occupiedOf(shift.id) >= shift.capacity
  }

  /** 台班内正在扫的那册（不被后来的挤掉） */
  function scanningOf(shiftId: string): ScanTask | null {
    return tasksOfShift(shiftId).find((task) => task.state === 'scanning') ?? null
  }

  /** 第一个还有容量的台班；容量到顶则顺延到下一班，历史补录班（容量 0）恒满 */
  function firstAvailableShift(): ScanShift | null {
    return sortedShifts.value.find((shift) => !isShiftFull(shift)) ?? null
  }

  /** 一册的影像是否齐：修复室凭此放行进装订 */
  function imagingReadyOf(volumeId: string): boolean {
    return isVolumeImagingReady(tasksOfVolume(volumeId))
  }

  /** 册次影像进度：应出按初扫任务合计，已出含补拍 */
  function imagingProgressOf(volumeId: string): { planned: number; produced: number; percent: number } {
    const list = tasksOfVolume(volumeId)
    const planned = list.filter((task) => task.retakeOf === null).reduce((sum, task) => sum + task.expectedCount, 0)
    const produced = list.filter((task) => task.state === 'done').reduce((sum, task) => sum + task.imageCount, 0)
    return {
      planned,
      produced,
      percent: planned === 0 ? 0 : Math.min(100, Math.round((produced / planned) * 100))
    }
  }

  async function createShift(draft: ScanShiftDraft): Promise<ScanShift> {
    const now = Date.now()
    const row: ScanShift = { ...draft, id: createId('shift'), createdAt: now, updatedAt: now }
    await db.scanShifts.put(row)
    await loadShifts()
    return row
  }

  async function removeShift(id: string): Promise<ImagingActionResult> {
    if (occupiedOf(id) > 0) return fail('台班内已有影像任务，不能删除')
    await db.scanShifts.delete(id)
    await loadShifts()
    return ok()
  }

  /**
   * 把一册排进台班：自动进入日期最近且还有容量的班；
   * 全部到顶则返回失败，提示先登记下一班。
   */
  async function enqueueVolume(volume: Volume): Promise<EnqueueResult> {
    const existing = tasksOfVolume(volume.id)
    if (existing.some((task) => task.state !== 'done')) {
      return { ok: false, reason: '该册已有在途影像任务，不能重复排队', task: null, shift: null }
    }
    if (existing.length > 0 && imagingReadyOf(volume.id)) {
      return { ok: false, reason: '该册影像已齐，无需再排', task: null, shift: null }
    }
    if (existing.length > 0) {
      return { ok: false, reason: '该册有待补的漏扫拍糊，请在原任务上登记补拍', task: null, shift: null }
    }
    const shift = firstAvailableShift()
    if (!shift) {
      return { ok: false, reason: '台班容量已到顶，请先登记下一班', task: null, shift: null }
    }
    const now = Date.now()
    const row: ScanTask = {
      id: createId('task'),
      shiftId: shift.id,
      volumeId: volume.id,
      volumeLabel: '',
      expectedCount: volume.leafCount * 2,
      imageCount: 0,
      state: 'queued',
      defectCount: 0,
      defectReason: '',
      retakeOf: null,
      origin: 'manual',
      createdAt: now,
      updatedAt: now
    }
    await db.scanTasks.put(row)
    await loadTasks()
    return { ok: true, reason: '', task: row, shift }
  }

  /** 开始扫描：同班已有在扫册次时拒绝（正在扫的不被后来的挤掉） */
  async function startScan(taskId: string): Promise<ImagingActionResult> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.state !== 'queued') return fail('任务不在排队中')
    if (scanningOf(task.shiftId)) return fail('本班正在扫的那册不被挤掉：请先完成当前扫描')
    await db.scanTasks.update(taskId, { state: 'scanning', updatedAt: Date.now() } as never)
    await loadTasks()
    return ok()
  }

  /** 完成扫描并登记出片张数；补拍完成时清零原任务的漏扫拍糊（只重出那几张，工序照旧） */
  async function completeScan(taskId: string, imageCount: number): Promise<ImagingActionResult> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.state !== 'scanning') return fail('任务不在扫描中')
    const now = Date.now()
    await db.scanTasks.update(taskId, { state: 'done', imageCount, updatedAt: now } as never)
    if (task.retakeOf) {
      await db.scanTasks.update(task.retakeOf, { defectCount: 0, defectReason: '', updatedAt: now } as never)
    }
    await loadTasks()
    return ok()
  }

  /** 登记漏扫 / 拍糊：只针对这一册的那几张生成补拍任务，排进还有容量的台班 */
  async function reportDefect(taskId: string, count: number, reason: Exclude<ScanDefectReason, ''>): Promise<ImagingActionResult> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.state !== 'done') return fail('只有已完成的任务能登记漏扫拍糊')
    if (task.volumeId === null) return fail('缺册号的历史记录只读，请先认领')
    if (!Number.isFinite(count) || count <= 0) return fail('缺陷张数需大于 0')
    if (tasks.value.some((item) => item.retakeOf === taskId && item.state !== 'done')) {
      return fail('该任务已有在途补拍，待补拍完成后再登记')
    }
    const shift = firstAvailableShift()
    if (!shift) return fail('台班容量已到顶，请先登记下一班再补拍')
    const now = Date.now()
    await db.scanTasks.update(taskId, { defectCount: count, defectReason: reason, updatedAt: now } as never)
    const retake: ScanTask = {
      id: createId('task'),
      shiftId: shift.id,
      volumeId: task.volumeId,
      volumeLabel: task.volumeLabel,
      expectedCount: count,
      imageCount: 0,
      state: 'queued',
      defectCount: 0,
      defectReason: '',
      retakeOf: taskId,
      origin: 'manual',
      createdAt: now,
      updatedAt: now
    }
    await db.scanTasks.put(retake)
    await loadTasks()
    return ok()
  }

  /** 移除任务：仅排队中的登记任务可移除；正在扫的不被挤掉，缺册号的只读 */
  async function removeTask(id: string): Promise<ImagingActionResult> {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) return fail('任务不存在')
    if (task.volumeId === null) return fail('缺册号的历史记录只读，等人认领，不能移除')
    if (task.state === 'scanning') return fail('正在扫的册不被后来的挤掉，不能移除')
    if (task.state === 'done') return fail('已完成的影像登记留档，不能移除')
    await db.scanTasks.delete(id)
    await loadTasks()
    return ok()
  }

  /** 缺册号历史记录认领：只补册次归属，其余字段原样保留 */
  async function claimTask(taskId: string, volumeId: string): Promise<ImagingActionResult> {
    const task = tasks.value.find((item) => item.id === taskId)
    if (!task || task.volumeId !== null) return fail('该记录不在待认领状态')
    await db.scanTasks.update(taskId, { volumeId, updatedAt: Date.now() } as never)
    await loadTasks()
    return ok()
  }

  return {
    shifts,
    tasks,
    loading,
    ready,
    error,
    sortedShifts,
    orphanTasks,
    queuedCount,
    scanningCount,
    producedTotal,
    defectPendingCount,
    loadAll,
    shiftById,
    tasksOfShift,
    tasksOfVolume,
    occupiedOf,
    isShiftFull,
    scanningOf,
    firstAvailableShift,
    imagingReadyOf,
    imagingProgressOf,
    createShift,
    removeShift,
    enqueueVolume,
    startScan,
    completeScan,
    reportDefect,
    removeTask,
    claimTask
  }
})
