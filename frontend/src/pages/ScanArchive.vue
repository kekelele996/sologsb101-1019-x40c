<script setup lang="ts">
/**
 * /scans 修后影像存档（影像室）
 * 影像室按台班登记：哪台扫描仪当天扫了哪几册、出了多少张影像、谁当班。
 * - 台班容量到顶就排队等下一班；正在扫的册不被后来的挤掉（queueNo 固定，只往后排）。
 * - 漏扫 / 拍糊只重出这一册的那几张，修复室记的工序照旧。
 * - 缺册号的历史影像只读留着，等人补册号认领。
 * 消费 Scanner / ScanShift / ScanJob / ImageRecord，并通过 volumeId 关联修复室册次。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Camera, CirclePlus, Clock, Picture, RefreshRight, Select, VideoCamera } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import ImageStatusTag from '@/components/common/ImageStatusTag.vue'
import { useScanStore } from '@/stores/scanStore'
import { useBookStore } from '@/stores/bookStore'
import { imageStatusOf } from '@/hooks/useImageCompleteness'
import { canStartScanning, shiftCapacity } from '@/hooks/useScanQueue'
import {
  createEmptyScannerDraft,
  SCANNER_STATUS_LABEL,
  SCANNER_STATUS_OPTIONS,
  type Scanner,
  type ScannerDraft
} from '@/types/scanner'
import {
  createEmptyScanShiftDraft,
  SHIFT_SLOT_LABEL,
  SHIFT_SLOT_OPTIONS,
  SHIFT_STATE_COLOR,
  SHIFT_STATE_LABEL,
  type ScanShift,
  type ScanShiftDraft
} from '@/types/scanShift'
import {
  SCAN_JOB_STATE_COLOR,
  SCAN_JOB_STATE_LABEL,
  type ScanJob,
  type ScanJobState
} from '@/types/scanJob'
import {
  IMAGE_SOURCE_LABEL,
  IMAGE_STATE_COLOR,
  IMAGE_STATE_LABEL,
  type ImageRecord,
  type ImageSource,
  type ImageState
} from '@/types/imageRecord'
import { BINDING_TYPE_LABEL } from '@/types/volume'

const scanStore = useScanStore()
const bookStore = useBookStore()

/* ------------------------------ 顶部筛选 ------------------------------ */
const currentScannerId = ref<string>('')
const currentShiftId = ref<string>('')

const scanners = computed(() => scanStore.scanners)
const activeScanners = computed(() => scanStore.activeScanners)

// 初次进入默认选第一台在用扫描仪与其第一个台班
if (!currentScannerId.value && activeScanners.value.length > 0) {
  currentScannerId.value = activeScanners.value[0].id
}

const shiftsOfScanner = computed(() => {
  return scanStore.shifts
    .filter((shift) => shift.scannerId === currentScannerId.value)
    .sort((a, b) => {
      if (a.workDate === b.workDate) return a.slot.localeCompare(b.slot)
      return b.workDate.localeCompare(a.workDate)
    })
})

if (!currentShiftId.value && shiftsOfScanner.value.length > 0) {
  currentShiftId.value = shiftsOfScanner.value[0].id
}

const currentShift = computed<ScanShift | undefined>(() =>
  scanStore.shifts.find((shift) => shift.id === currentShiftId.value)
)
const currentScanner = computed<Scanner | undefined>(() =>
  scanStore.scanners.find((item) => item.id === currentScannerId.value)
)

function onScannerChange(): void {
  const first = shiftsOfScanner.value[0]
  currentShiftId.value = first ? first.id : ''
}

function selectShift(id: string): void {
  currentShiftId.value = id
}

const jobsInShift = computed<ScanJob[]>(() =>
  currentShiftId.value ? scanStore.jobsOfShift(currentShiftId.value) : []
)
const capacity = computed(() =>
  currentShift.value ? shiftCapacity(currentShift.value, scanStore.jobs) : { occupied: 0, free: 0, full: true, scanning: 0, queued: 0 }
)

/* ------------------------------ 统计 ------------------------------ */
const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return {
    scanners: activeScanners.value.length,
    shiftsToday: scanStore.shifts.filter((s) => s.workDate === today).length,
    scanning: scanStore.jobs.filter((j) => j.state === 'scanning').length,
    queued: scanStore.jobs.filter((j) => j.state === 'queued').length,
    retake: scanStore.images.filter((i) => i.state === 'retake').length,
    orphans: scanStore.orphanImages.length
  }
})

/* ------------------------------ 名称回显 ------------------------------ */
function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除/对不上'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]} · ${volume.leafCount} 叶`
}

function volumeImageStatus(volumeId: string) {
  const volume = bookStore.volumeById(volumeId)
  return imageStatusOf(volume, scanStore.imagesOfVolume(volumeId))
}

/* ------------------------------ 扫描仪登记 ------------------------------ */
const scannerDialog = ref(false)
const scannerForm = reactive<ScannerDraft>(createEmptyScannerDraft())

function openScannerDialog(): void {
  Object.assign(scannerForm, createEmptyScannerDraft())
  scannerDialog.value = true
}

async function submitScanner(): Promise<void> {
  if (!scannerForm.code.trim()) {
    ElMessage.warning('请填设备编号')
    return
  }
  await scanStore.createScanner({ ...scannerForm, code: scannerForm.code.trim() })
  ElMessage.success('已登记扫描仪')
  currentScannerId.value = scanStore.scanners[scanStore.scanners.length - 1]?.id ?? currentScannerId.value
  scannerDialog.value = false
}

/* ------------------------------ 台班登记 ------------------------------ */
const shiftDialog = ref(false)
const shiftForm = reactive<ScanShiftDraft>(createEmptyScanShiftDraft('', 3))

function openShiftDialog(): void {
  const scannerId = currentScannerId.value || activeScanners.value[0]?.id || ''
  const cap = scanStore.scannerById(scannerId)?.capacityPerShift ?? 3
  Object.assign(shiftForm, createEmptyScanShiftDraft(scannerId, cap))
  shiftDialog.value = true
}

async function submitShift(): Promise<void> {
  if (!shiftForm.scannerId) {
    ElMessage.warning('请先选择扫描仪')
    return
  }
  const row = await scanStore.createShift({ ...shiftForm })
  currentScannerId.value = shiftForm.scannerId
  currentShiftId.value = row.id
  ElMessage.success('台班已登记，可往本班排入册次')
  shiftDialog.value = false
}

async function closeShift(): Promise<void> {
  if (!currentShift.value) return
  await scanStore.updateShift(currentShift.value.id, { state: 'closed' })
  ElMessage.success('该台班已收班')
}

/* ------------------------------ 册次进班（排队） ------------------------------ */
const enqueueDialog = ref(false)
const enqueueVolumeId = ref('')

/** 可排入的册次：没有处于排队/在扫的在册任务 */
const enqueueOptions = computed(() =>
  bookStore.volumes
    .filter((volume) => !scanStore.jobs.some((job) => job.volumeId === volume.id && (job.state === 'queued' || job.state === 'scanning')))
    .map((volume) => ({ value: volume.id, label: volumeLabel(volume.id) }))
)

function openEnqueue(): void {
  if (!currentShift.value) {
    ElMessage.warning('请先选择或登记一个台班')
    return
  }
  enqueueVolumeId.value = enqueueOptions.value[0]?.value ?? ''
  enqueueDialog.value = true
}

async function submitEnqueue(): Promise<void> {
  if (!enqueueVolumeId.value) {
    ElMessage.warning('请选择要送扫的册次')
    return
  }
  const result = await scanStore.enqueueVolume(enqueueVolumeId.value, currentScannerId.value, currentShiftId.value)
  if (!result.ok) {
    ElMessage.warning(result.message)
    return
  }
  if (result.job) currentShiftId.value = result.job.shiftId
  ElMessage.success(`已排入台班（队列第 ${result.job?.queueNo} 位）`)
  enqueueDialog.value = false
}

async function advanceJob(job: ScanJob): Promise<void> {
  if (job.state === 'queued') {
    if (!canStartScanning(scanStore.jobs, job.shiftId, job)) {
      ElMessage.warning('前面还有在扫/排队的册，请按队列顺序开始，正在扫的册不被后来的挤掉')
      return
    }
    await scanStore.setJobState(job.id, 'scanning')
    ElMessage.success('该册开始扫描')
  } else if (job.state === 'scanning') {
    await scanStore.setJobState(job.id, 'done')
    ElMessage.success('该册扫描任务已扫毕；影像是否齐套见下方影像清单')
  }
}

async function returnJob(job: ScanJob): Promise<void> {
  await scanStore.setJobState(job.id, 'returned')
  ElMessage.info('已退回修复室核对')
}

async function removeJob(job: ScanJob): Promise<void> {
  try {
    await scanStore.removeJob(job.id)
    ElMessage.success('已移出本班')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

function jobActionText(state: ScanJobState): string {
  if (state === 'queued') return '开始扫描'
  if (state === 'scanning') return '扫毕'
  return ''
}

/* ------------------------------ 该册影像清单 ------------------------------ */
const imageVolumeId = ref<string>('')
const imageDialog = ref(false)
const newFrameNo = ref('')
const newLeafNo = ref<number>(1)
const newOperator = ref('')

const imageVolume = computed(() => bookStore.volumeById(imageVolumeId.value))
const volumeImages = computed<ImageRecord[]>(() =>
  imageVolumeId.value ? scanStore.imagesOfVolume(imageVolumeId.value) : []
)
const imageStatus = computed(() => imageStatusOf(imageVolume.value, volumeImages.value))

/** 每叶取轮次最高（最新）的一张作为该叶有效影像 */
const leafRows = computed(() => {
  const total = imageVolume.value?.leafCount ?? 0
  const rows: Array<{ leafNo: number; image?: ImageRecord }> = []
  for (let no = 1; no <= total; no += 1) {
    const list = volumeImages.value.filter((image) => image.leafNo === no)
    rows.push({ leafNo: no, image: list.sort((a, b) => b.retakeRound - a.retakeRound)[0] })
  }
  return rows
})

function openImages(job: ScanJob): void {
  imageVolumeId.value = job.volumeId
  newOperator.value = currentShift.value?.operator ?? ''
  newLeafNo.value = imageStatusOf(bookStore.volumeById(job.volumeId), scanStore.imagesOfVolume(job.volumeId)).missingLeafNos[0] ?? 1
  newFrameNo.value = ''
  imageDialog.value = true
}

async function addImage(): Promise<void> {
  if (!imageVolume.value) return
  if (!newFrameNo.value.trim()) {
    ElMessage.warning('请填写影像帧号/文件名')
    return
  }
  const list = volumeImages.value.filter((image) => image.leafNo === newLeafNo.value)
  const nextRound = list.length === 0 ? 0 : Math.max(...list.map((i) => i.retakeRound))
  await scanStore.createImage({
    volumeId: imageVolumeId.value,
    leafNo: newLeafNo.value,
    frameNo: newFrameNo.value.trim(),
    retakeRound: nextRound,
    state: 'ok',
    source: 'shift',
    shiftId: currentShiftId.value,
    operator: newOperator.value || (currentShift.value?.operator ?? ''),
    legacyVolumeNo: '',
    note: ''
  })
  ElMessage.success(`已登记第 ${newLeafNo.value} 叶影像`)
  newFrameNo.value = ''
}

async function retake(image: ImageRecord): Promise<void> {
  try {
    await scanStore.markRetake(image.id, '拍糊/漏扫，只重出这一张')
    ElMessage.success(`已标记第 ${image.leafNo} 叶待重拍，修复室工序不变`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

async function approve(image: ImageRecord): Promise<void> {
  try {
    await scanStore.markImageOk(image.id)
    ElMessage.success(`第 ${image.leafNo} 叶重拍合格，该册其余影像与工序照旧`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

/* ------------------------------ 无主历史影像认领 ------------------------------ */
const claimDialog = ref(false)
const claimImageId = ref('')
const claimVolumeId = ref('')
const claiming = ref<ImageRecord | null>(null)

const claimOptions = computed(() =>
  bookStore.volumes.map((volume) => ({ value: volume.id, label: volumeLabel(volume.id) }))
)

function openClaim(image: ImageRecord): void {
  claiming.value = image
  claimImageId.value = image.id
  claimVolumeId.value = ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claimVolumeId.value) {
    ElMessage.warning('请选择该旧影像对应的在册册次')
    return
  }
  try {
    await ElMessageBox.confirm(
      `认领后该历史影像将归入「${volumeLabel(claimVolumeId.value)}」，请确认旧册号 ${claiming.value?.legacyVolumeNo || '—'} 与之一致。`,
      '认领无主历史影像',
      { type: 'warning', confirmButtonText: '确认认领', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await scanStore.claimOrphanImage(claimImageId.value, claimVolumeId.value)
  ElMessage.success('认领成功，该影像已归入在册册次')
  claimDialog.value = false
}

function jobTagColor(state: ScanJobState): string {
  return SCAN_JOB_STATE_COLOR[state]
}
function jobTagLabel(state: ScanJobState): string {
  return SCAN_JOB_STATE_LABEL[state]
}

function sourceLabel(source: ImageSource): string {
  return IMAGE_SOURCE_LABEL[source] ?? source
}
function stateLabel(state: ImageState): string {
  return IMAGE_STATE_LABEL[state] ?? state
}
function stateColor(state: ImageState): string {
  return IMAGE_STATE_COLOR[state] ?? '#8c8c8c'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修后影像存档 · 影像室台班</h2>
        <p>影像室按台班登记扫描仪、册次、影像张数与当班人；与修复室各记各的，仅按册次关联。</p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="VideoCamera" @click="openScannerDialog">登记扫描仪</el-button>
        <el-button type="primary" :icon="Clock" @click="openShiftDialog">登记台班</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在用扫描仪" :value="stats.scanners" suffix="台" tone="primary" icon="Odometer" />
      <StatBadge label="今日台班" :value="stats.shiftsToday" suffix="个" tone="info" icon="Calendar" />
      <StatBadge label="正在扫" :value="stats.scanning" suffix="册" tone="warning" icon="Camera" />
      <StatBadge label="排队等候" :value="stats.queued" suffix="册" tone="default" icon="Clock" />
      <StatBadge label="待重拍" :value="stats.retake" suffix="张" tone="danger" icon="Picture" />
      <StatBadge label="无主历史影像" :value="stats.orphans" suffix="张" tone="info" icon="QuestionFilled" />
    </div>

    <!-- 扫描仪 + 台班切换 -->
    <el-card shadow="never" class="gb-panel">
      <div class="scanner-bar">
        <div class="scanner-bar__group">
          <span class="gb-muted">扫描仪</span>
          <el-select v-model="currentScannerId" style="width: 260px" @change="onScannerChange">
            <el-option v-for="scanner in scanners" :key="scanner.id" :value="scanner.id">
              <span>{{ scanner.code }} · {{ scanner.name }}</span>
              <span class="gb-muted" style="float: right">
                {{ SCANNER_STATUS_LABEL[scanner.status] }} · 单班 {{ scanner.capacityPerShift }} 册
              </span>
            </el-option>
          </el-select>
        </div>
        <el-button text type="primary" :icon="CirclePlus" @click="openShiftDialog">新开台班</el-button>
      </div>

      <div v-if="shiftsOfScanner.length === 0" class="shift-empty">
        <EmptyPanel
          title="这台扫描仪还没有台班"
          description="先登记一个台班（日期 / 班次 / 当班人），再把修好的册排进来。"
          action-text="登记台班"
          size="small"
          @action="openShiftDialog"
        />
      </div>
      <div v-else class="shift-chips">
        <button
          v-for="shift in shiftsOfScanner"
          :key="shift.id"
          type="button"
          class="shift-chip"
          :class="{ 'is-active': shift.id === currentShiftId }"
          @click="selectShift(shift.id)"
        >
          <strong>{{ shift.workDate }} {{ SHIFT_SLOT_LABEL[shift.slot] }}</strong>
          <span>{{ shift.operator || '当班人未填' }}</span>
          <em :style="{ color: SHIFT_STATE_COLOR[shift.state] }">{{ SHIFT_STATE_LABEL[shift.state] }}</em>
        </button>
      </div>
    </el-card>

    <el-row :gutter="16" style="margin-top: 16px">
      <!-- 本班在册册次 -->
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span v-if="currentShift">
                {{ currentScanner?.code }} · {{ currentShift.workDate }} {{ SHIFT_SLOT_LABEL[currentShift.slot] }} ·
                {{ currentShift.operator || '当班人未填' }}
              </span>
              <span v-else>请选择台班</span>
              <div class="gb-toolbar">
                <el-tag v-if="currentShift" type="info" effect="plain">
                  容量 {{ capacity.occupied }}/{{ currentShift.capacity }}（在扫 {{ capacity.scanning }} · 排队 {{ capacity.queued }}）
                </el-tag>
                <el-button size="small" type="primary" :icon="CirclePlus" :disabled="!currentShift" @click="openEnqueue">
                  册次进班
                </el-button>
                <el-button size="small" :disabled="!currentShift || currentShift.state === 'closed'" @click="closeShift">
                  收班
                </el-button>
              </div>
            </div>
          </template>

          <el-alert
            v-if="currentShift && capacity.full && currentShift.state !== 'closed'"
            type="warning"
            show-icon
            :closable="false"
            title="本班容量到顶，后来的册请登记下一个台班排队；正在扫的册不被挤掉。"
            style="margin-bottom: 10px"
          />

          <EmptyPanel
            v-if="jobsInShift.length === 0"
            title="本班还没有在册册次"
            description="把修复室修好待存档的册排进本班；容量到顶后排到下一班。"
            action-text="册次进班"
            size="small"
            @action="openEnqueue"
          />
          <el-table v-else :data="jobsInShift" size="small" border>
            <el-table-column label="队列" width="56" align="center">
              <template #default="{ row }">{{ row.queueNo }}</template>
            </el-table-column>
            <el-table-column label="册次" min-width="220">
              <template #default="{ row }">
                <div>{{ volumeLabel(row.volumeId) }}</div>
                <ImageStatusTag
                  size="small"
                  :leaf-count="bookStore.volumeById(row.volumeId)?.leafCount ?? 0"
                  :covered-leaves="volumeImageStatus(row.volumeId).coveredLeaves"
                  :retake-count="volumeImageStatus(row.volumeId).retakeCount"
                />
              </template>
            </el-table-column>
            <el-table-column label="状态" width="96">
              <template #default="{ row }">
                <el-tag :style="{ color: jobTagColor(row.state), borderColor: `${jobTagColor(row.state)}55` }" effect="plain" round size="small">
                  {{ jobTagLabel(row.state) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230">
              <template #default="{ row }">
                <el-button
                  v-if="jobActionText(row.state)"
                  size="small"
                  type="primary"
                  text
                  @click="advanceJob(row)"
                >
                  {{ jobActionText(row.state) }}
                </el-button>
                <el-button size="small" text :icon="Picture" @click="openImages(row)">影像</el-button>
                <el-button v-if="row.state === 'queued' || row.state === 'scanning'" size="small" text type="warning" @click="returnJob(row)">
                  退回
                </el-button>
                <el-button
                  v-if="row.state === 'queued' || row.state === 'returned' || row.state === 'done'"
                  size="small"
                  text
                  type="danger"
                  @click="removeJob(row)"
                >
                  移出
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <!-- 无主历史影像 -->
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>缺册号的历史影像（只读等人认领）</span>
              <el-tag type="info" effect="plain" round size="small">{{ scanStore.orphanImages.length }} 张</el-tag>
            </div>
          </template>
          <EmptyPanel
            v-if="scanStore.orphanImages.length === 0"
            title="没有待认领的无主影像"
            description="升级补录的旧影像若缺册号，会留在这里只读保存，等人补册号认领。"
            size="small"
          />
          <el-table v-else :data="scanStore.orphanImages" size="small" border>
            <el-table-column label="旧册号 / 帧号" min-width="150">
              <template #default="{ row }">
                <div>{{ row.legacyVolumeNo || '无旧册号' }}</div>
                <span class="gb-muted">{{ row.frameNo }} · 第 {{ row.leafNo }} 叶</span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button size="small" type="primary" text :icon="Select" @click="openClaim(row)">认领</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-alert
            style="margin-top: 10px"
            type="info"
            show-icon
            :closable="false"
            title="无主影像在认领前只读，不能修改或删除，避免旧数据被误清。"
          />
        </el-card>
      </el-col>
    </el-row>

    <!-- 扫描仪登记 -->
    <el-dialog v-model="scannerDialog" title="登记扫描仪" width="460px">
      <el-form label-width="110px">
        <el-form-item label="设备编号" required>
          <el-input v-model="scannerForm.code" placeholder="如 IS-03" />
        </el-form-item>
        <el-form-item label="名称/型号">
          <el-input v-model="scannerForm.name" placeholder="如 非接触式古籍扫描台" />
        </el-form-item>
        <el-form-item label="单班容量(册)" required>
          <el-input-number v-model="scannerForm.capacityPerShift" :min="1" :max="50" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="scannerForm.status">
            <el-option v-for="opt in SCANNER_STATUS_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="scannerForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="scannerDialog = false">取消</el-button>
        <el-button type="primary" @click="submitScanner">保存</el-button>
      </template>
    </el-dialog>

    <!-- 台班登记 -->
    <el-dialog v-model="shiftDialog" title="登记台班" width="460px">
      <el-form label-width="100px">
        <el-form-item label="扫描仪" required>
          <el-select v-model="shiftForm.scannerId" style="width: 100%">
            <el-option v-for="scanner in activeScanners" :key="scanner.id" :value="scanner.id" :label="`${scanner.code} · ${scanner.name}`" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期" required>
          <el-input v-model="shiftForm.workDate" type="date" />
        </el-form-item>
        <el-form-item label="班次" required>
          <el-radio-group v-model="shiftForm.slot">
            <el-radio-button v-for="opt in SHIFT_SLOT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="当班人">
          <el-input v-model="shiftForm.operator" placeholder="如 顾临" />
        </el-form-item>
        <el-form-item label="本班容量">
          <el-input-number v-model="shiftForm.capacity" :min="1" :max="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shiftDialog = false">取消</el-button>
        <el-button type="primary" @click="submitShift">保存</el-button>
      </template>
    </el-dialog>

    <!-- 册次进班 -->
    <el-dialog v-model="enqueueDialog" title="册次进班（送扫）" width="520px">
      <el-form label-width="90px">
        <el-form-item label="选择册次" required>
          <el-select v-model="enqueueVolumeId" filterable style="width: 100%" placeholder="选择修复室修好待存档的册">
            <el-option v-for="opt in enqueueOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="按队列排入本班：本班容量到顶会自动改排该扫描仪下一个有名额的台班；正在扫的册不被挤掉。"
      />
      <template #footer>
        <el-button @click="enqueueDialog = false">取消</el-button>
        <el-button type="primary" @click="submitEnqueue">排入</el-button>
      </template>
    </el-dialog>

    <!-- 该册影像清单 -->
    <el-dialog v-model="imageDialog" :title="`修后影像 · ${imageVolume ? volumeLabel(imageVolume.id) : ''}`" width="760px" top="6vh">
      <div class="img-summary">
        <ImageStatusTag
          :leaf-count="imageStatus.leafCount"
          :covered-leaves="imageStatus.coveredLeaves"
          :retake-count="imageStatus.retakeCount"
          :missing-count="imageStatus.missingCount"
        />
        <span class="gb-muted">
          合格 {{ imageStatus.okCount }} 张 · 已覆盖 {{ imageStatus.coveredLeaves }}/{{ imageStatus.leafCount }} 叶 ·
          待重拍 {{ imageStatus.retakeCount }} 张
        </span>
        <el-tag v-if="imageStatus.complete" type="success" effect="plain" round size="small">影像齐，可放行进装订</el-tag>
      </div>

      <div class="img-addbar">
        <span class="gb-muted">补/重出片：</span>
        <el-input-number v-model="newLeafNo" :min="1" :max="imageStatus.leafCount || 1" size="small" controls-position="right" style="width: 110px" />
        <el-input v-model="newFrameNo" size="small" placeholder="帧号 / 文件名" style="width: 200px" />
        <el-input v-model="newOperator" size="small" placeholder="操作人" style="width: 120px" />
        <el-button size="small" type="primary" :icon="Camera" @click="addImage">出片登记</el-button>
      </div>

      <el-table :data="leafRows" size="small" border max-height="340">
        <el-table-column label="叶号" width="64" align="center">
          <template #default="{ row }">{{ row.leafNo }}</template>
        </el-table-column>
        <el-table-column label="最新影像" min-width="180">
          <template #default="{ row }">
            <template v-if="row.image">
              <div>{{ row.image.frameNo }} <span class="gb-muted">· 第 {{ row.image.retakeRound }} 轮</span></div>
              <span class="gb-muted">{{ sourceLabel(row.image.source) }} · {{ row.image.operator || '未填操作人' }}</span>
            </template>
            <span class="gb-muted" v-else>尚未出片（漏扫）</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag v-if="row.image" :style="{ color: stateColor(row.image.state), borderColor: `${stateColor(row.image.state)}55` }" effect="plain" round size="small">
              {{ stateLabel(row.image.state) }}
            </el-tag>
            <el-tag v-else type="danger" effect="plain" round size="small">漏扫</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <template v-if="row.image">
              <el-button v-if="row.image.state === 'ok'" size="small" text type="warning" :icon="RefreshRight" @click="retake(row.image)">
                重出此张
              </el-button>
              <el-button v-else size="small" text type="success" @click="approve(row.image)">重拍合格</el-button>
            </template>
            <span v-else class="gb-muted">在上方出片</span>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        style="margin-top: 10px"
        type="info"
        show-icon
        :closable="false"
        title="拍糊或漏扫只重出这一册的那几张，修复室记的工序保持不变；每叶一张合格影像才算齐，修复室才放它进装订。"
      />
      <template #footer>
        <el-button type="primary" @click="imageDialog = false">完成</el-button>
      </template>
    </el-dialog>

    <!-- 无主影像认领 -->
    <el-dialog v-model="claimDialog" title="认领缺册号的历史影像" width="480px">
      <el-descriptions :column="1" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="旧册号">{{ claiming?.legacyVolumeNo || '无旧册号' }}</el-descriptions-item>
        <el-descriptions-item label="帧号 / 叶号">{{ claiming?.frameNo }} · 第 {{ claiming?.leafNo }} 叶</el-descriptions-item>
        <el-descriptions-item label="备注">{{ claiming?.note }}</el-descriptions-item>
      </el-descriptions>
      <el-select v-model="claimVolumeId" filterable style="width: 100%" placeholder="选择对应的在册册次">
        <el-option v-for="opt in claimOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
      </el-select>
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" @click="submitClaim">确认认领</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.scanner-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.scanner-bar__group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shift-empty {
  margin-top: 14px;
}

.shift-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.shift-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 168px;
  padding: 10px 14px;
  text-align: left;
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  background: var(--gb-paper-light);
  cursor: pointer;
  font-family: inherit;
}

.shift-chip span {
  font-size: 12px;
  color: #8c8479;
}

.shift-chip em {
  font-style: normal;
  font-size: 12px;
}

.shift-chip.is-active {
  border-color: var(--gb-indigo);
  box-shadow: 0 0 0 2px rgba(58, 74, 107, 0.18);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.img-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.img-addbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
