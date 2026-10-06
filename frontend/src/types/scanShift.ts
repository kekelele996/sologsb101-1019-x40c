/**
 * 台班（ScanShift）数据模型
 * 影像室按台班登记：哪台扫描仪、哪天、哪个班次扫了哪几册、谁当班。
 * 一个台班能容纳的册数由该扫描仪的 capacityPerShift 决定。
 */

/** 班次：早班 / 中班 / 晚班 */
export type ShiftSlot = 'morning' | 'afternoon' | 'evening';

/** 台班状态：登记中（容量未满，仍可排入）/ 已满（容量到顶，后来者排队）/ 已收班 */
export type ShiftState = 'open' | 'full' | 'closed';

export interface ScanShift {
  id: string;
  /** 扫描仪 id */
  scannerId: string;
  /** 台班日期 yyyy-MM-dd */
  workDate: string;
  /** 班次 */
  slot: ShiftSlot;
  /** 当班影像室人员 */
  operator: string;
  /** 该台班容量（取自扫描仪，冗余存档，设备改容量不影响旧台班） */
  capacity: number;
  /** 台班状态 */
  state: ShiftState;
  /** 备注（非接触式扫描台等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ScanShiftDraft = Omit<ScanShift, 'id' | 'createdAt' | 'updatedAt'>;

export const SHIFT_SLOT_LABEL: Record<ShiftSlot, string> = {
  morning: '早班',
  afternoon: '中班',
  evening: '晚班',
};

export const SHIFT_SLOT_OPTIONS: ReadonlyArray<{ value: ShiftSlot; label: string }> = [
  { value: 'morning', label: '早班' },
  { value: 'afternoon', label: '中班' },
  { value: 'evening', label: '晚班' },
];

export const SHIFT_STATE_LABEL: Record<ShiftState, string> = {
  open: '登记中',
  full: '已满排队',
  closed: '已收班',
};

export const SHIFT_STATE_COLOR: Record<ShiftState, string> = {
  open: '#1e8449',
  full: '#d68910',
  closed: '#8c8c8c',
};

export const SHIFT_STATE_OPTIONS: ReadonlyArray<{ value: ShiftState; label: string }> = [
  { value: 'open', label: '登记中' },
  { value: 'full', label: '已满排队' },
  { value: 'closed', label: '已收班' },
];

export function createEmptyScanShiftDraft(scannerId: string, capacity: number): ScanShiftDraft {
  return {
    scannerId,
    workDate: new Date().toISOString().slice(0, 10),
    slot: 'morning',
    operator: '',
    capacity,
    state: 'open',
    note: '',
  };
}

/** 台班标题：日期 + 班次 + 当班人 */
export function shiftTitle(shift: Pick<ScanShift, 'workDate' | 'slot' | 'operator'>): string {
  return `${shift.workDate} ${SHIFT_SLOT_LABEL[shift.slot]}${shift.operator ? ` · ${shift.operator}当班` : ''}`;
}
