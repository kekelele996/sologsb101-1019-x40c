/**
 * 册次影像任务（ScanTask）数据模型
 * 影像室逐册登记：排在哪个台班、应出 / 已出多少张影像、漏扫拍糊与补拍。
 * 与修复室的册次 / 书叶 / 工序记录各自独立（两边各记各的），互不回写。
 */

/** 任务状态：排队中 / 扫描中 / 已完成 */
export type ScanTaskState = 'queued' | 'scanning' | 'done';

/** 缺陷原因：漏扫 / 拍糊 */
export type ScanDefectReason = 'missed' | 'blurred' | '';

/** 任务来源：影像室登记 / 升级补录 */
export type ScanTaskOrigin = 'manual' | 'legacy';

export interface ScanTask {
  id: string;
  /** 所属台班 id */
  shiftId: string;
  /** 所属册次 id；null 表示缺册号的历史记录，只读、等人认领 */
  volumeId: string | null;
  /** 缺册号记录的人工线索（如旧影像袋编号），认领前展示用 */
  volumeLabel: string;
  /** 应出影像张数（默认按册叶数 × 2，正反两面） */
  expectedCount: number;
  /** 实际出片张数 */
  imageCount: number;
  /** 任务状态 */
  state: ScanTaskState;
  /** 漏扫 / 拍糊张数（补拍完成后清零） */
  defectCount: number;
  /** 缺陷原因 */
  defectReason: ScanDefectReason;
  /** 补拍任务指向原任务 id；初扫为 null */
  retakeOf: string | null;
  /** 来源 */
  origin: ScanTaskOrigin;
  createdAt: number;
  updatedAt: number;
}

export const SCAN_TASK_STATE_LABEL: Record<ScanTaskState, string> = {
  queued: '排队中',
  scanning: '扫描中',
  done: '已完成',
};

export const SCAN_TASK_STATE_COLOR: Record<ScanTaskState, string> = {
  queued: '#8c8c8c',
  scanning: '#d68910',
  done: '#1e8449',
};

export const SCAN_TASK_STATE_OPTIONS: ReadonlyArray<{ value: ScanTaskState; label: string }> = [
  { value: 'queued', label: '排队中' },
  { value: 'scanning', label: '扫描中' },
  { value: 'done', label: '已完成' },
];

export const DEFECT_REASON_LABEL: Record<Exclude<ScanDefectReason, ''>, string> = {
  missed: '漏扫',
  blurred: '拍糊',
};

export const DEFECT_REASON_OPTIONS: ReadonlyArray<{ value: Exclude<ScanDefectReason, ''>; label: string }> = [
  { value: 'missed', label: '漏扫' },
  { value: 'blurred', label: '拍糊' },
];

/** 缺册号的历史记录：只读，只能认领，不能改不能删 */
export function isTaskOrphan(task: ScanTask): boolean {
  return task.volumeId === null;
}

/**
 * 一册的影像是否齐：有影像任务、全部完成、漏扫拍糊均已补出。
 * 修复室凭此判定能否放该册进装订。
 */
export function isVolumeImagingReady(tasks: ScanTask[]): boolean {
  if (tasks.length === 0) return false;
  return tasks.every((task) => task.state === 'done') && tasks.every((task) => task.defectCount === 0);
}
