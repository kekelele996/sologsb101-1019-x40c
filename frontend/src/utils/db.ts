/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：修后影像存档（影像室）新增 scanners / scanShifts / scanJobs / imageRecords，
 *           并为已扫册次补录历史影像；缺册号的旧影像作为无主记录只读留着等人认领
 * - 十张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { Scanner } from '@/types/scanner'
import type { ScanShift } from '@/types/scanShift'
import type { ScanJob } from '@/types/scanJob'
import type { ImageRecord } from '@/types/imageRecord'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
  lastScannerId: string | null
  lastShiftId: string | null
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastBookId: null,
  lastVolumeId: null,
  repairSort: 'manual',
  lastScannerId: null,
  lastShiftId: null
}

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual',
      lastScannerId: typeof parsed.lastScannerId === 'string' ? parsed.lastScannerId : null,
      lastShiftId: typeof parsed.lastShiftId === 'string' ? parsed.lastShiftId : null
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  scanners!: Table<Scanner, string>
  scanShifts!: Table<ScanShift, string>
  scanJobs!: Table<ScanJob, string>
  imageRecords!: Table<ImageRecord, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：修后影像存档（影像室）。给已扫册次（已装订/已归档）补录历史影像与台班，
    // 另补两张缺册号的无主影像，只读等人认领。
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        scanners: 'id, code, status, capacityPerShift, updatedAt',
        scanShifts: 'id, scannerId, workDate, slot, state, updatedAt',
        scanJobs: 'id, volumeId, shiftId, queueNo, state, updatedAt',
        imageRecords: 'id, volumeId, leafNo, state, source, shiftId, updatedAt'
      })
      .upgrade(async (tx) => {
        await backfillLegacyImaging(tx)
      })
  }
}

/**
 * v2 → v3 历史影像补录：
 * 旧数据里在修的册没有影像归属，这里只按「已扫的册次」（已装订 / 已归档）补一批历史影像；
 * 缺册号的旧影像 volumeId 留空，作为无主记录只读等人认领。
 */
async function backfillLegacyImaging(tx: Transaction): Promise<void> {
  const now = Date.now()
  const scanner: Scanner = {
    id: 'scan_legacy01',
    code: 'IS-01',
    name: '非接触式古籍扫描台（历史设备）',
    capacityPerShift: 3,
    status: 'active',
    note: '升级时为历史影像补录',
    createdAt: now,
    updatedAt: now
  }
  await tx.table<Scanner>('scanners').put(scanner)

  const volumes = await tx.table<Volume>('volumes').toArray()
  // 已扫的册次：已装订 / 已归档视为已经过影像室扫描
  const scanned = volumes.filter((volume: Volume) => volume.state === 'bound' || volume.state === 'archived')

  const shiftByKey = new Map<string, ScanShift>()
  const legacyImages: ImageRecord[] = []
  let jobSeq = 0

  for (const volume of scanned) {
    const workDate = new Date(volume.updatedAt || now).toISOString().slice(0, 10)
    const key = `${scanner.id}|${workDate}|morning`
    let shift = shiftByKey.get(key)
    if (!shift) {
      shift = {
        id: `shift_legacy_${workDate}`,
        scannerId: scanner.id,
        workDate,
        slot: 'morning',
        operator: '影像室（历史补录）',
        capacity: scanner.capacityPerShift,
        state: 'closed',
        note: '升级补录的历史台班',
        createdAt: now,
        updatedAt: now
      }
      shiftByKey.set(key, shift)
    }
    jobSeq += 1
    const job: ScanJob = {
      id: `job_legacy_${volume.id}`,
      volumeId: volume.id,
      shiftId: shift.id,
      queueNo: jobSeq,
      state: 'done',
      note: '升级时按已扫册次补录',
      createdAt: now,
      updatedAt: now
    }
    await tx.table<ScanJob>('scanJobs').put(job)

    // 每个已扫册次按其登记叶数补齐合格历史影像
    for (let leafNo = 1; leafNo <= Math.max(1, volume.leafCount); leafNo += 1) {
      legacyImages.push({
        id: `img_legacy_${volume.id}_${leafNo}`,
        volumeId: volume.id,
        leafNo,
        frameNo: `L-${volume.volumeNo}-${String(leafNo).padStart(3, '0')}`,
        retakeRound: 0,
        state: 'ok',
        source: 'legacy',
        shiftId: shift.id,
        operator: '影像室（历史补录）',
        legacyVolumeNo: '',
        note: '升级时按已扫册次补录',
        createdAt: now,
        updatedAt: now
      })
    }
  }

  for (const shift of shiftByKey.values()) {
    await tx.table<ScanShift>('scanShifts').put(shift)
  }
  await tx.table<ImageRecord>('imageRecords').bulkPut(legacyImages)

  // 缺册号的旧影像：volumeId 留空，只读等人认领
  const orphans: ImageRecord[] = [
    {
      id: 'img_orphan_01',
      volumeId: '',
      leafNo: 1,
      frameNo: 'OLD-X-001',
      retakeRound: 0,
      state: 'ok',
      source: 'legacy',
      shiftId: '',
      operator: '影像室（历史补录）',
      legacyVolumeNo: '旧册号 亥-37',
      note: '旧数据缺册号，待修复室认领',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'img_orphan_02',
      volumeId: '',
      leafNo: 2,
      frameNo: 'OLD-X-002',
      retakeRound: 0,
      state: 'ok',
      source: 'legacy',
      shiftId: '',
      operator: '影像室（历史补录）',
      legacyVolumeNo: '旧册号 亥-37',
      note: '旧数据缺册号，待修复室认领',
      createdAt: now,
      updatedAt: now
    }
  ]
  await tx.table<ImageRecord>('imageRecords').bulkPut(orphans)
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  /* ------------------------ 影像室：扫描仪 / 台班 / 任务 / 影像 ------------------------ */
  const scanners: Scanner[] = [
    { id: 'scan_01', code: 'IS-01', name: '非接触式古籍扫描台', capacityPerShift: 3, status: 'active', note: '主用，A2 幅面', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'scan_02', code: 'IS-02', name: '高拍仪（带压稿玻璃）', capacityPerShift: 5, status: 'active', note: '薄册优先', createdAt: now - day * 28, updatedAt: now - day * 2 }
  ]

  // IS-01 今日早班（在扫 vol_0101）、中班（满，vol_0102 排队等下一班的场景）
  const today = new Date(now).toISOString().slice(0, 10)
  const scanShifts: ScanShift[] = [
    { id: 'shift_01', scannerId: 'scan_01', workDate: today, slot: 'morning', operator: '顾临', capacity: 3, state: 'open', note: '', createdAt: now - day, updatedAt: now - day },
    { id: 'shift_02', scannerId: 'scan_01', workDate: today, slot: 'afternoon', operator: '顾临', capacity: 3, state: 'open', note: '', createdAt: now - day, updatedAt: now - day },
    { id: 'shift_03', scannerId: 'scan_02', workDate: '2026-03-03', slot: 'morning', operator: '卫阑', capacity: 5, state: 'closed', note: '梦溪笔谈已扫毕', createdAt: now - day * 4, updatedAt: now - day * 2 },
    { id: 'shift_04', scannerId: 'scan_01', workDate: '2026-02-18', slot: 'morning', operator: '顾临', capacity: 3, state: 'closed', note: '巢氏诸病源候已扫毕', createdAt: now - day * 9, updatedAt: now - day * 5 }
  ]

  // vol_0101 正在扫（受保护，不被后来的挤掉）；vol_0102 排队等中班；vol_0201 / vol_0301 历史扫毕
  const scanJobs: ScanJob[] = [
    { id: 'job_0101', volumeId: 'vol_0101', shiftId: 'shift_01', queueNo: 1, state: 'scanning', note: '逐叶出片中', createdAt: now - day, updatedAt: now },
    { id: 'job_0102', volumeId: 'vol_0102', shiftId: 'shift_02', queueNo: 1, state: 'queued', note: '早班容量到顶，排入中班', createdAt: now, updatedAt: now },
    { id: 'job_0201', volumeId: 'vol_0201', shiftId: 'shift_03', queueNo: 1, state: 'done', note: '', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'job_0301', volumeId: 'vol_0301', shiftId: 'shift_04', queueNo: 1, state: 'done', note: '', createdAt: now - day * 9, updatedAt: now - day * 5 }
  ]

  // vol_0201（30 叶）、vol_0301（12 叶）历史齐套；vol_0101（24 叶）在扫：第 3 叶拍糊待重拍，其余尚漏扫
  const imageRecords: ImageRecord[] = []
  const pushLegacy = (volumeId: string, prefix: string, shiftId: string, leafCount: number, operator: string, at: number): void => {
    for (let leafNo = 1; leafNo <= leafCount; leafNo += 1) {
      imageRecords.push({
        id: `img_${volumeId}_${String(leafNo).padStart(2, '0')}`,
        volumeId,
        leafNo,
        frameNo: `${prefix}-${String(leafNo).padStart(3, '0')}`,
        retakeRound: 0,
        state: 'ok',
        source: 'shift',
        shiftId,
        operator,
        legacyVolumeNo: '',
        note: '',
        createdAt: at,
        updatedAt: at
      })
    }
  }
  pushLegacy('vol_0201', 'IS02-0201', 'shift_03', 30, '卫阑', now - day * 3)
  pushLegacy('vol_0301', 'IS01-0301', 'shift_04', 12, '顾临', now - day * 8)
  imageRecords.push(
    {
      id: 'img_0101_03',
      volumeId: 'vol_0101',
      leafNo: 3,
      frameNo: 'IS01-0101-003',
      retakeRound: 1,
      state: 'retake',
      source: 'shift',
      shiftId: 'shift_01',
      operator: '顾临',
      legacyVolumeNo: '',
      note: '对焦不实拍糊，只重出这一张',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'img_0101_01',
      volumeId: 'vol_0101',
      leafNo: 1,
      frameNo: 'IS01-0101-001',
      retakeRound: 0,
      state: 'ok',
      source: 'shift',
      shiftId: 'shift_01',
      operator: '顾临',
      legacyVolumeNo: '',
      note: '',
      createdAt: now,
      updatedAt: now
    },
    // 缺册号的历史影像：只读等人认领
    {
      id: 'img_orphan_01',
      volumeId: '',
      leafNo: 1,
      frameNo: 'OLD-X-001',
      retakeRound: 0,
      state: 'ok',
      source: 'legacy',
      shiftId: '',
      operator: '影像室（历史补录）',
      legacyVolumeNo: '旧册号 亥-37',
      note: '旧数据缺册号，待修复室认领',
      createdAt: now - day * 20,
      updatedAt: now - day * 20
    }
  )

  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.scanners,
      db.scanShifts,
      db.scanJobs,
      db.imageRecords
    ],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.scanners.bulkPut(scanners)
      await db.scanShifts.bulkPut(scanShifts)
      await db.scanJobs.bulkPut(scanJobs)
      await db.imageRecords.bulkPut(imageRecords)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  scanners: Scanner[]
  scanShifts: ScanShift[]
  scanJobs: ScanJob[]
  imageRecords: ImageRecord[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, scanners, scanShifts, scanJobs, imageRecords] =
    await Promise.all([
      db.books.toArray(),
      db.volumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.scanners.toArray(),
      db.scanShifts.toArray(),
      db.scanJobs.toArray(),
      db.imageRecords.toArray()
    ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    scanners,
    scanShifts,
    scanJobs,
    imageRecords
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  const keys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'repairOrders',
    'bindings'
  ]
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

/** 影像室四表为 v3 新增；旧备份缺失时按空集合处理，不阻断导入 */
function snapshotImagingRows(snapshot: Partial<RestoreSnapshot>) {
  return {
    scanners: Array.isArray(snapshot.scanners) ? snapshot.scanners : [],
    scanShifts: Array.isArray(snapshot.scanShifts) ? snapshot.scanShifts : [],
    scanJobs: Array.isArray(snapshot.scanJobs) ? snapshot.scanJobs : [],
    imageRecords: Array.isArray(snapshot.imageRecords) ? snapshot.imageRecords : []
  }
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  const imaging = snapshotImagingRows(snapshot)
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.scanners,
      db.scanShifts,
      db.scanJobs,
      db.imageRecords
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.scanners.clear(),
        db.scanShifts.clear(),
        db.scanJobs.clear(),
        db.imageRecords.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      if (imaging.scanners.length) await db.scanners.bulkPut(imaging.scanners)
      if (imaging.scanShifts.length) await db.scanShifts.bulkPut(imaging.scanShifts)
      if (imaging.scanJobs.length) await db.scanJobs.bulkPut(imaging.scanJobs)
      if (imaging.imageRecords.length) await db.imageRecords.bulkPut(imaging.imageRecords)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.scanners,
      db.scanShifts,
      db.scanJobs,
      db.imageRecords
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.scanners.clear(),
        db.scanShifts.clear(),
        db.scanJobs.clear(),
        db.imageRecords.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, scanners, scanShifts, scanJobs, imageRecords] =
    await Promise.all([
      db.books.count(),
      db.volumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.scanners.count(),
      db.scanShifts.count(),
      db.scanJobs.count(),
      db.imageRecords.count()
    ])
  return { books, volumes, leaves, papers, repairOrders, bindings, scanners, scanShifts, scanJobs, imageRecords }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 影像室任务与在册影像 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [
      db.books,
      db.volumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.scanJobs,
      db.imageRecords
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
        // 影像室侧：删除在册扫描任务与在册影像；缺册号的无主历史影像保留等人认领
        await db.scanJobs.where('volumeId').anyOf(volumeIds).delete()
        await db.imageRecords.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 影像室任务与在册影像 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.scanJobs, db.imageRecords],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.scanJobs.where('volumeId').equals(volumeId).delete()
      // 仅删在册影像；无主历史影像（volumeId 为空）保留
      await db.imageRecords.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
