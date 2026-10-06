/**
 * 扫描任务（ScanJob）数据模型
 * 一册在影像室的一条扫描流水：登记进哪个台班、处于排队 / 在扫 / 扫毕 / 退回。
 * 影像室按台班各记各的，只通过 volumeId 引用修复室的册次，不改修复室的工序。
 */

/**
 * 任务状态：
 * - queued 排队等候（台班容量到顶后排队等下一班）
 * - scanning 正在扫（占用台班名额，不被后来的册挤掉）
 * - done 该册影像已扫毕（是否「齐」由影像记录派生，见 useImageCompleteness）
 * - returned 影像室退回（册次信息对不上等），回修复室核对
 */
export type ScanJobState = 'queued' | 'scanning' | 'done' | 'returned';

export interface ScanJob {
  id: string;
  /** 所属册次 id（与修复室松散关联） */
  volumeId: string;
  /** 排入的台班 id */
  shiftId: string;
  /** 排队序号，从 1 开始；在扫册序号靠前且固定，后来者只能往后排 */
  queueNo: number;
  /** 当前状态 */
  state: ScanJobState;
  /** 影像室接单/登记备注（缺册号疑问等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ScanJobDraft = Omit<ScanJob, 'id' | 'createdAt' | 'updatedAt'>;

export const SCAN_JOB_STATE_LABEL: Record<ScanJobState, string> = {
  queued: '排队等候',
  scanning: '正在扫',
  done: '扫毕',
  returned: '退回核对',
};

export const SCAN_JOB_STATE_COLOR: Record<ScanJobState, string> = {
  queued: '#8c8c8c',
  scanning: '#d68910',
  done: '#1e8449',
  returned: '#b03a2e',
};

export const SCAN_JOB_STATE_OPTIONS: ReadonlyArray<{ value: ScanJobState; label: string }> = [
  { value: 'queued', label: '排队等候' },
  { value: 'scanning', label: '正在扫' },
  { value: 'done', label: '扫毕' },
  { value: 'returned', label: '退回核对' },
];

export function createEmptyScanJobDraft(volumeId: string, shiftId: string, queueNo: number): ScanJobDraft {
  return {
    volumeId,
    shiftId,
    queueNo,
    state: 'queued',
    note: '',
  };
}

/** 是否占用台班容量：只有排队 / 在扫占位；扫毕、退回不占新名额 */
export function isJobOccupying(state: ScanJobState): boolean {
  return state === 'queued' || state === 'scanning';
}

/** 正在扫的册受保护，不允许后来的册把它挤掉或插队 */
export function isJobProtected(state: ScanJobState): boolean {
  return state === 'scanning';
}
