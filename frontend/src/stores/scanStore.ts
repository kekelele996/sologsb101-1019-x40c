/**
 * 影像室 store（Pinia setup store）
 * 维护扫描仪、台班、扫描任务、修后影像四张表的本地数据与影像室侧动作。
 * 与修复室各记各的：这里只通过 volumeId 引用册次，绝不改动书叶 / 工序 / 装订。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { Scanner, ScannerDraft } from '@/types/scanner'
import type { ScanShift, ScanShiftDraft } from '@/types/scanShift'
import type { ScanJob, ScanJobState } from '@/types/scanJob'
import { isJobOccupying } from '@/types/scanJob'
import type { ImageRecord, ImageRecordDraft } from '@/types/imageRecord'
import { isOrphanImage } from '@/types/imageRecord'
import { freeSlots, nextQueueNo, pickShiftForNewJob } from '@/hooks/useScanQueue'

export interface EnqueueResult {
  ok: boolean
  message: string
  job?: ScanJob
}

export const useScanStore = defineStore('scan', () => {
  const scanners = ref<Scanner[]>([])
  const shifts = ref<ScanShift[]>([])
  const jobs = ref<ScanJob[]>([])
  const images = ref<ImageRecord[]>([])
  const loading = ref(false)
  const ready = ref(false)

  const activeScanners = computed(() => scanners.value.filter((item) => item.status === 'active'))
  const orphanImages = computed(() => images.value.filter((item) => isOrphanImage(item)))

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [scannerRows, shiftRows, jobRows, imageRows] = await Promise.all([
        db.scanners.toArray(),
        db.scanShifts.toArray(),
        db.scanJobs.toArray(),
        db.imageRecords.toArray()
      ])
      scannerRows.sort((a, b) => a.code.localeCompare(b.code))
      shiftRows.sort((a, b) => (a.workDate === b.workDate ? a.slot.localeCompare(b.slot) : b.workDate.localeCompare(a.workDate)))
      jobRows.sort((a, b) => (a.shiftId === b.shiftId ? a.queueNo - b.queueNo : a.createdAt - b.createdAt))
      imageRows.sort((a, b) => a.leafNo - b.leafNo)
      scanners.value = scannerRows
      shifts.value = shiftRows
      jobs.value = jobRows
      images.value = imageRows
      ready.value = true
    } finally {
      loading.value = false
    }
  }

  function scannerById(id: string): Scanner | undefined {
    return scanners.value.find((item) => item.id === id)
  }

  function shiftById(id: string): ScanShift | undefined {
    return shifts.value.find((item) => item.id === id)
  }

  function jobsOfShift(shiftId: string): ScanJob[] {
    return jobs.value
      .filter((job) => job.shiftId === shiftId)
      .sort((a, b) => a.queueNo - b.queueNo)
  }

  function latestJobOfVolume(volumeId: string): ScanJob | undefined {
    return jobs.value
      .filter((job) => job.volumeId === volumeId)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  function imagesOfVolume(volumeId: string): ImageRecord[] {
    return images.value
      .filter((image) => image.volumeId === volumeId)
      .sort((a, b) => (a.leafNo === b.leafNo ? a.retakeRound - b.retakeRound : a.leafNo - b.leafNo))
  }

  /* ------------------------------ 扫描仪 ------------------------------ */
  async function createScanner(draft: ScannerDraft): Promise<Scanner> {
    const now = Date.now()
    const row: Scanner = { ...draft, id: createId('scan'), createdAt: now, updatedAt: now }
    await db.scanners.put(row)
    await loadAll()
    return row
  }

  async function updateScanner(id: string, patch: Partial<Scanner>): Promise<void> {
    await db.scanners.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  /* ------------------------------ 台班 ------------------------------ */
  async function createShift(draft: ScanShiftDraft): Promise<ScanShift> {
    const now = Date.now()
    const row: ScanShift = { ...draft, id: createId('shift'), createdAt: now, updatedAt: now }
    await db.scanShifts.put(row)
    await loadAll()
    return row
  }

  async function updateShift(id: string, patch: Partial<ScanShift>): Promise<void> {
    await db.scanShifts.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  /* ------------------------------ 扫描任务（排队 / 在扫 / 扫毕） ------------------------------ */

  /**
   * 登记一册进台班：容量未满排入所选台班；容量到顶则尝试该扫描仪下一班，
   * 都满时返回失败提示去开下一班。不重排已有任务，正在扫的册不被挤掉。
   */
  async function enqueueVolume(volumeId: string, scannerId: string, preferredShiftId: string | null): Promise<EnqueueResult> {
    const target = pickShiftForNewJob(jobs.value, shifts.value, preferredShiftId, scannerId)
    if (!target) {
      return { ok: false, message: '该扫描仪各班容量都到顶了，请先登记下一个台班，册次排队等下一班。' }
    }
    const now = Date.now()
    const row: ScanJob = {
      id: createId('job'),
      volumeId,
      shiftId: target.id,
      queueNo: nextQueueNo(jobs.value, target.id),
      state: 'queued',
      note: '',
      createdAt: now,
      updatedAt: now
    }
    await db.scanJobs.put(row)
    // 排入后若恰好到顶，把台班标记为已满排队
    if (freeSlots(target, [...jobs.value, row]) <= 0 && target.state === 'open') {
      await db.scanShifts.update(target.id, { state: 'full', updatedAt: Date.now() } as never)
    }
    await loadAll()
    return { ok: true, message: '', job: row }
  }

  /** 推进任务状态（排队 → 在扫 → 扫毕 / 退回）；在扫册受保护，不允许删除或插队 */
  async function setJobState(jobId: string, state: ScanJobState): Promise<void> {
    await db.scanJobs.update(jobId, { state, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function updateJobNote(jobId: string, note: string): Promise<void> {
    await db.scanJobs.update(jobId, { note, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeJob(jobId: string): Promise<void> {
    const job = jobs.value.find((item) => item.id === jobId)
    if (job && job.state === 'scanning') {
      throw new Error('该册正在扫，不能删除，以免在扫册被后来的挤掉')
    }
    await db.scanJobs.delete(jobId)
    await loadAll()
  }

  /* ------------------------------ 修后影像 ------------------------------ */
  async function createImage(draft: ImageRecordDraft): Promise<ImageRecord> {
    const now = Date.now()
    const row: ImageRecord = { ...draft, id: createId('img'), createdAt: now, updatedAt: now }
    await db.imageRecords.put(row)
    await loadAll()
    return row
  }

  async function updateImage(id: string, patch: Partial<ImageRecord>): Promise<void> {
    const existing = images.value.find((item) => item.id === id)
    if (existing && isOrphanImage(existing)) {
      throw new Error('这是缺册号的历史影像，认领前只读，不能修改')
    }
    await db.imageRecords.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeImage(id: string): Promise<void> {
    const existing = images.value.find((item) => item.id === id)
    if (existing && isOrphanImage(existing)) {
      throw new Error('这是缺册号的历史影像，需保留等人认领，不能删除')
    }
    await db.imageRecords.delete(id)
    await loadAll()
  }

  /**
   * 漏扫 / 拍糊只重出这一册的那一张：
   * 把该张标记待重拍并轮次 +1（保留原片），修复室工序照旧不改动。
   * 重拍合格后调用 markImageOk 回到合格。
   */
  async function markRetake(imageId: string, note = ''): Promise<void> {
    const existing = images.value.find((item) => item.id === imageId)
    if (!existing) return
    if (isOrphanImage(existing)) throw new Error('缺册号的历史影像认领前只读')
    await db.imageRecords.update(imageId, {
      state: 'retake',
      retakeRound: existing.retakeRound + 1,
      note: note || existing.note,
      updatedAt: Date.now()
    } as never)
    await loadAll()
  }

  /** 重拍合格：仅这一张回到合格，其它影像与工序不变 */
  async function markImageOk(imageId: string, operator?: string): Promise<void> {
    const existing = images.value.find((item) => item.id === imageId)
    if (!existing) return
    if (isOrphanImage(existing)) throw new Error('缺册号的历史影像认领前只读')
    await db.imageRecords.update(imageId, {
      state: 'ok',
      operator: operator ?? existing.operator,
      updatedAt: Date.now()
    } as never)
    await loadAll()
  }

  /** 认领无主历史影像：补册号后转为在册（仍标记为历史补录），此后可正常重拍 */
  async function claimOrphanImage(imageId: string, volumeId: string): Promise<void> {
    const existing = images.value.find((item) => item.id === imageId)
    if (!existing || !isOrphanImage(existing)) return
    await db.imageRecords.update(imageId, { volumeId, state: 'ok', updatedAt: Date.now() } as never)
    await loadAll()
  }

  /** 某册各叶的最新有效影像（每叶取轮次最高的合格张），供齐套统计 */
  function validImageLeafSet(volumeId: string): Set<number> {
    const set = new Set<number>()
    imagesOfVolume(volumeId)
      .filter((image) => image.state === 'ok')
      .forEach((image) => set.add(image.leafNo))
    return set
  }

  return {
    scanners,
    shifts,
    jobs,
    images,
    loading,
    ready,
    activeScanners,
    orphanImages,
    loadAll,
    scannerById,
    shiftById,
    jobsOfShift,
    latestJobOfVolume,
    imagesOfVolume,
    createScanner,
    updateScanner,
    createShift,
    updateShift,
    enqueueVolume,
    setJobState,
    updateJobNote,
    removeJob,
    createImage,
    updateImage,
    removeImage,
    markRetake,
    markImageOk,
    claimOrphanImage,
    validImageLeafSet
  }
})

/** 供页面直接引用的占用判定，避免重复导入类型文件 */
export { isJobOccupying }
