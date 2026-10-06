<script setup lang="ts">
/**
 * /imaging 修后影像台班
 * 影像室按台班登记：哪台扫描仪、当天扫哪几册、出多少张、谁当班；
 * 漏扫拍糊只重出该册那几张，缺册号的历史记录只读待认领。
 * 与修复室的工序记录各自独立（两边各记各的），只向装订环节输出「影像是否齐」。
 * 消费 ScanShift、ScanTask、Volume；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Camera, CircleCheck, Connection, Delete, Plus, VideoPlay, WarningFilled } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useImagingStore } from '@/stores/imagingStore'
import { createEmptyShiftDraft, SCANNER_OPTIONS, LEGACY_SHIFT_ID, type ScanShift, type ScanShiftDraft } from '@/types/scanShift'
import {
  DEFECT_REASON_LABEL,
  DEFECT_REASON_OPTIONS,
  SCAN_TASK_STATE_COLOR,
  SCAN_TASK_STATE_LABEL,
  isTaskOrphan,
  type ScanTask
} from '@/types/scanTask'
import { VOLUME_STATE_LABEL, isVolumeLocked } from '@/types/volume'

const bookStore = useBookStore()
const imagingStore = useImagingStore()

function volumeName(volumeId: string | null): string {
  if (!volumeId) return ''
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

function taskTitle(task: ScanTask): string {
  return task.volumeId ? volumeName(task.volumeId) : task.volumeLabel || '缺册号影像'
}

function defectLabel(task: ScanTask): string {
  if (task.defectCount === 0 || task.defectReason === '') return ''
  return `${DEFECT_REASON_LABEL[task.defectReason]} ${task.defectCount} 张待补`
}

/* ----------------------------- 台班登记 ----------------------------- */
const shiftDialog = ref(false)
const shiftForm = reactive<ScanShiftDraft>(createEmptyShiftDraft())

function openShiftCreate(): void {
  Object.assign(shiftForm, createEmptyShiftDraft())
  shiftDialog.value = true
}

async function submitShift(): Promise<void> {
  if (!shiftForm.scanner.trim() || !shiftForm.operator.trim()) {
    ElMessage.warning('请填写扫描仪与当班人')
    return
  }
  await imagingStore.createShift({ ...shiftForm })
  ElMessage.success(`已登记 ${shiftForm.date} 台班（容量 ${shiftForm.capacity} 册）`)
  shiftDialog.value = false
}

async function removeShift(shift: ScanShift): Promise<void> {
  try {
    await ElMessageBox.confirm('仅空台班可删除，删除后不可恢复。', '删除台班', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await imagingStore.removeShift(shift.id)
  if (!result.ok) ElMessage.warning(result.reason)
  else ElMessage.success('已删除台班')
}

/* ----------------------------- 排册入班 ----------------------------- */
const enqueueDialog = ref(false)
const enqueueVolumeId = ref('')

/** 可排队的册：未锁定、从未送拍（有缺陷待补的册走原任务补拍，不重复排队） */
const enqueueCandidates = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore
      .volumesOfBook(book.id)
      .filter((volume) => !isVolumeLocked(volume.state))
      .filter((volume) => imagingStore.tasksOfVolume(volume.id).length === 0)
      .map((volume) => ({
        value: volume.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · ${VOLUME_STATE_LABEL[volume.state]} · ${volume.leafCount} 叶`
      }))
  )
)

/** 排入目标：日期最近且还有容量的台班；到顶则提示登记下一班 */
const targetShift = computed(() => imagingStore.firstAvailableShift())

function openEnqueue(): void {
  if (enqueueCandidates.value.length === 0) {
    ElMessage.warning('当前没有待送拍的册次')
    return
  }
  enqueueVolumeId.value = enqueueCandidates.value[0]?.value ?? ''
  enqueueDialog.value = true
}

async function submitEnqueue(): Promise<void> {
  const volume = bookStore.volumeById(enqueueVolumeId.value)
  if (!volume) {
    ElMessage.warning('请选择要排队的册次')
    return
  }
  const result = await imagingStore.enqueueVolume(volume)
  if (!result.ok) {
    ElMessage.warning(result.reason)
    return
  }
  ElMessage.success(
    `已排入 ${result.shift?.date} · ${result.shift?.scanner}，应出 ${result.task?.expectedCount} 张（叶数 × 2）`
  )
  enqueueDialog.value = false
}

/* ----------------------------- 扫描推进 ----------------------------- */
async function start(task: ScanTask): Promise<void> {
  const result = await imagingStore.startScan(task.id)
  if (!result.ok) {
    ElMessage.warning(result.reason)
    return
  }
  ElMessage.success(`开始扫描：${taskTitle(task)}`)
}

const completeDialog = ref(false)
const completeTask = ref<ScanTask | null>(null)
const completeCount = ref(0)

function openComplete(task: ScanTask): void {
  completeTask.value = task
  completeCount.value = task.expectedCount
  completeDialog.value = true
}

async function submitComplete(): Promise<void> {
  if (!completeTask.value) return
  const result = await imagingStore.completeScan(completeTask.value.id, completeCount.value)
  if (!result.ok) {
    ElMessage.warning(result.reason)
    return
  }
  ElMessage.success(
    completeTask.value.retakeOf
      ? `补拍完成，原任务的漏扫拍糊已核销（出片 ${completeCount.value} 张）`
      : `扫描完成，登记出片 ${completeCount.value} 张`
  )
  completeDialog.value = false
}

/* ----------------------------- 漏扫 / 拍糊 ----------------------------- */
const defectDialog = ref(false)
const defectTask = ref<ScanTask | null>(null)
const defectCount = ref(1)
const defectReason = ref<'missed' | 'blurred'>('missed')

function openDefect(task: ScanTask): void {
  defectTask.value = task
  defectCount.value = 1
  defectReason.value = 'missed'
  defectDialog.value = true
}

async function submitDefect(): Promise<void> {
  if (!defectTask.value) return
  const result = await imagingStore.reportDefect(defectTask.value.id, defectCount.value, defectReason.value)
  if (!result.ok) {
    ElMessage.warning(result.reason)
    return
  }
  ElMessage.success(`已生成补拍任务：只重出该册 ${defectCount.value} 张，修复室工序记录照旧`)
  defectDialog.value = false
}

async function removeTask(task: ScanTask): Promise<void> {
  try {
    await ElMessageBox.confirm('仅排队中的任务可移除，移除后释放台班容量。', '移除影像任务', {
      type: 'warning',
      confirmButtonText: '确认移除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await imagingStore.removeTask(task.id)
  if (!result.ok) ElMessage.warning(result.reason)
  else ElMessage.success('已移除')
}

/* ----------------------------- 缺册号认领 ----------------------------- */
const claimDialog = ref(false)
const claimTaskRow = ref<ScanTask | null>(null)
const claimVolumeId = ref('')

const claimCandidates = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${VOLUME_STATE_LABEL[volume.state]}`
    }))
  )
)

function openClaim(task: ScanTask): void {
  claimTaskRow.value = task
  claimVolumeId.value = claimCandidates.value[0]?.value ?? ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claimTaskRow.value) return
  if (!claimVolumeId.value) {
    ElMessage.warning('请选择归属册次')
    return
  }
  const result = await imagingStore.claimTask(claimTaskRow.value.id, claimVolumeId.value)
  if (!result.ok) {
    ElMessage.warning(result.reason)
    return
  }
  ElMessage.success('已认领，该批影像归属到所选册次')
  claimDialog.value = false
}

/* ----------------------------- 册次影像进度 ----------------------------- */
const volumeRows = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => {
      const taskList = imagingStore.tasksOfVolume(volume.id)
      const progress = imagingStore.imagingProgressOf(volume.id)
      const ready = imagingStore.imagingReadyOf(volume.id)
      const status = taskList.length === 0 ? 'untouched' : ready ? 'ready' : 'working'
      return { book, volume, progress, ready, status }
    })
  )
)

const VOLUME_IMAGING_LABEL: Record<string, string> = {
  untouched: '未送拍',
  working: '影像不齐',
  ready: '已齐'
}

const VOLUME_IMAGING_COLOR: Record<string, string> = {
  untouched: '#8c8c8c',
  working: '#d68910',
  ready: '#1e8449'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修后影像台班</h2>
        <p>影像室按台班登记扫描仪、册次、出片张数与当班人；影像齐了修复室才放该册进装订，漏扫拍糊只重出那几张。</p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Plus" @click="openShiftCreate">登记台班</el-button>
        <el-button type="primary" :icon="Camera" @click="openEnqueue">排册入班</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="台班" :value="imagingStore.shifts.length" suffix="个" tone="primary" />
      <StatBadge label="累计出片" :value="imagingStore.producedTotal" suffix="张" tone="success" />
      <StatBadge label="排队中" :value="imagingStore.queuedCount" suffix="册" tone="info" />
      <StatBadge label="扫描中" :value="imagingStore.scanningCount" suffix="册" tone="warning" />
      <StatBadge label="待补拍" :value="imagingStore.defectPendingCount" suffix="册" tone="danger" />
      <StatBadge label="待认领" :value="imagingStore.orphanTasks.length" suffix="条" />
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="14">
        <EmptyPanel
          v-if="imagingStore.sortedShifts.length === 0"
          title="还没有台班"
          description="先登记台班（日期、扫描仪、当班人、容量），再把修完的册排进来。"
          action-text="登记台班"
          @action="openShiftCreate"
        />

        <el-card v-for="shift in imagingStore.sortedShifts" :key="shift.id" shadow="never" style="margin-bottom: 14px">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
              <div class="gb-toolbar">
                <strong>{{ shift.date }}</strong>
                <el-tag effect="plain" round>{{ shift.scanner }}</el-tag>
                <span class="gb-muted">当班 {{ shift.operator || '未填' }}</span>
                <el-tag v-if="shift.id === LEGACY_SHIFT_ID" type="info" effect="plain" round>历史补录班</el-tag>
                <el-tag v-else-if="imagingStore.isShiftFull(shift)" type="danger" effect="plain" round>已满员</el-tag>
              </div>
              <div class="gb-toolbar">
                <span class="gb-muted">
                  容量 {{ imagingStore.occupiedOf(shift.id) }}/{{ shift.capacity > 0 ? shift.capacity : '—' }}
                </span>
                <el-button
                  v-if="imagingStore.occupiedOf(shift.id) === 0 && shift.id !== LEGACY_SHIFT_ID"
                  size="small"
                  text
                  type="danger"
                  :icon="Delete"
                  @click="removeShift(shift)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </template>

          <p v-if="shift.note" class="gb-muted" style="margin: 0 0 10px">{{ shift.note }}</p>

          <EmptyPanel
            v-if="imagingStore.tasksOfShift(shift.id).length === 0"
            title="本班还没有安排册次"
            description="用右上角「排册入班」把修完的册排进来；容量到顶后自动等下一班。"
            size="small"
          />

          <div v-else>
            <div v-for="task in imagingStore.tasksOfShift(shift.id)" :key="task.id" class="gb-step-row">
              <el-tag v-if="task.retakeOf" type="warning" effect="plain" round>补拍</el-tag>
              <strong>{{ taskTitle(task) }}</strong>
              <el-tag v-if="isTaskOrphan(task)" type="info" effect="plain" round>缺册号·只读</el-tag>
              <el-tag
                :style="{ color: SCAN_TASK_STATE_COLOR[task.state], borderColor: `${SCAN_TASK_STATE_COLOR[task.state]}66` }"
                effect="plain"
                round
              >
                {{ SCAN_TASK_STATE_LABEL[task.state] }}
              </el-tag>
              <span class="gb-muted">
                {{ task.state === 'done' ? `已出 ${task.imageCount} 张` : `应出 ${task.expectedCount} 张` }}
              </span>
              <el-tag v-if="defectLabel(task)" type="danger" effect="plain" round>{{ defectLabel(task) }}</el-tag>
              <el-tag v-if="task.origin === 'legacy'" type="info" effect="plain" round>历史补录</el-tag>
              <div style="margin-left: auto; display: flex; gap: 4px">
                <el-button v-if="task.state === 'queued' && !isTaskOrphan(task)" size="small" text type="primary" :icon="VideoPlay" @click="start(task)">
                  开始扫描
                </el-button>
                <el-button v-if="task.state === 'scanning'" size="small" text type="success" :icon="CircleCheck" @click="openComplete(task)">
                  完成扫描
                </el-button>
                <el-button v-if="task.state === 'done' && !isTaskOrphan(task)" size="small" text type="warning" :icon="WarningFilled" @click="openDefect(task)">
                  登记问题
                </el-button>
                <el-button v-if="task.state === 'queued' && !isTaskOrphan(task)" size="small" text type="danger" :icon="Delete" @click="removeTask(task)">
                  移除
                </el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <span>缺册号历史影像（只读，等人认领）</span>
          </template>
          <EmptyPanel
            v-if="imagingStore.orphanTasks.length === 0"
            title="没有待认领的影像"
            description="升级补录时缺册号的记录会列在这里，认领前保持只读。"
            size="small"
          />
          <div v-else>
            <div v-for="task in imagingStore.orphanTasks" :key="task.id" class="gb-step-row">
              <el-icon color="#a8623a"><Connection /></el-icon>
              <div>
                <div>{{ task.volumeLabel || '缺册号影像' }}</div>
                <div class="gb-muted">{{ task.imageCount }} 张 · 只读待认领</div>
              </div>
              <el-button size="small" text type="primary" style="margin-left: auto" @click="openClaim(task)">认领</el-button>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <span>册次影像进度（齐了才放进装订）</span>
          </template>
          <el-table :data="volumeRows" size="small" border>
            <el-table-column label="册次" min-width="150">
              <template #default="{ row }">《{{ row.book.title }}》第 {{ row.volume.volumeNo }} 册</template>
            </el-table-column>
            <el-table-column label="出片" width="110">
              <template #default="{ row }">
                <span v-if="row.status === 'untouched'" class="gb-muted">—</span>
                <span v-else>{{ row.progress.produced }}/{{ row.progress.planned }} 张</span>
              </template>
            </el-table-column>
            <el-table-column label="影像" width="90">
              <template #default="{ row }">
                <el-tag :style="{ color: VOLUME_IMAGING_COLOR[row.status], borderColor: `${VOLUME_IMAGING_COLOR[row.status]}66` }" effect="plain" round>
                  {{ VOLUME_IMAGING_LABEL[row.status] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="装订放行" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.ready" type="success" effect="plain" round>可进装订</el-tag>
                <el-tag v-else type="warning" effect="plain" round>暂不放行</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="shiftDialog" title="登记台班" width="520px">
      <el-form label-width="100px">
        <el-form-item label="台班日期" required>
          <el-input v-model="shiftForm.date" type="date" />
        </el-form-item>
        <el-form-item label="扫描仪" required>
          <el-select v-model="shiftForm.scanner" filterable allow-create default-first-option style="width: 100%">
            <el-option v-for="item in SCANNER_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="当班人" required>
          <el-input v-model="shiftForm.operator" placeholder="如：季岚" />
        </el-form-item>
        <el-form-item label="容量（册）" required>
          <el-input-number v-model="shiftForm.capacity" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="shiftForm.note" placeholder="如：上午班" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shiftDialog = false">取消</el-button>
        <el-button type="primary" @click="submitShift">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="enqueueDialog" title="排册入班" width="520px">
      <el-form label-width="100px">
        <el-form-item label="册次" required>
          <el-select v-model="enqueueVolumeId" filterable style="width: 100%">
            <el-option v-for="item in enqueueCandidates" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="targetShift"
        type="info"
        show-icon
        :closable="false"
        :title="`将排入 ${targetShift.date} · ${targetShift.scanner}（当班 ${targetShift.operator || '未填'}）`"
        description="台班容量到顶后自动顺延到下一班；正在扫的那册不被后来的挤掉。"
      />
      <el-alert
        v-else
        type="warning"
        show-icon
        :closable="false"
        title="台班容量已到顶"
        description="请先「登记台班」开下一班，再排册入队。"
      />
      <template #footer>
        <el-button @click="enqueueDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!targetShift" @click="submitEnqueue">排入台班</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="completeDialog" title="完成扫描" width="480px">
      <el-form label-width="100px">
        <el-form-item label="册次">
          <span>{{ completeTask ? taskTitle(completeTask) : '' }}</span>
        </el-form-item>
        <el-form-item label="出片张数" required>
          <el-input-number v-model="completeCount" :min="0" :max="9999" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="completeTask?.retakeOf"
        type="success"
        show-icon
        :closable="false"
        title="这是补拍任务"
        description="完成后原任务的漏扫拍糊张数即核销；修复室记的工序照旧，不受影响。"
      />
      <template #footer>
        <el-button @click="completeDialog = false">取消</el-button>
        <el-button type="primary" @click="submitComplete">登记出片</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="defectDialog" title="登记漏扫 / 拍糊" width="480px">
      <el-form label-width="100px">
        <el-form-item label="册次">
          <span>{{ defectTask ? taskTitle(defectTask) : '' }}</span>
        </el-form-item>
        <el-form-item label="缺陷原因" required>
          <el-radio-group v-model="defectReason">
            <el-radio-button v-for="item in DEFECT_REASON_OPTIONS" :key="item.value" :value="item.value">
              {{ item.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="缺陷张数" required>
          <el-input-number v-model="defectCount" :min="1" :max="9999" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="只重出这一册的这几张"
        description="确认后自动生成补拍任务并排进还有容量的台班；修复室记的工序照旧，不回写。"
      />
      <template #footer>
        <el-button @click="defectDialog = false">取消</el-button>
        <el-button type="primary" @click="submitDefect">生成补拍任务</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="claimDialog" title="认领缺册号影像" width="520px">
      <el-form label-width="100px">
        <el-form-item label="影像记录">
          <span>{{ claimTaskRow?.volumeLabel || '缺册号影像' }}（{{ claimTaskRow?.imageCount ?? 0 }} 张）</span>
        </el-form-item>
        <el-form-item label="归属册次" required>
          <el-select v-model="claimVolumeId" filterable style="width: 100%">
            <el-option v-for="item in claimCandidates" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="认领只补册次归属"
        description="历史记录其余字段保持原样；认领后按正常影像记录对待。"
      />
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" @click="submitClaim">确认认领</el-button>
      </template>
    </el-dialog>
  </div>
</template>
