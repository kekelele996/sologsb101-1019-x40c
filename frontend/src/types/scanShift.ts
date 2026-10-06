/**
 * 扫描台班（ScanShift）数据模型
 * 影像室按台班登记：哪天、哪台扫描仪、谁当班、本班最多扫几册。
 * 容量到顶后新册排队等下一班；历史补录台班容量为 0，不参与日常排队。
 */

export interface ScanShift {
  id: string;
  /** 台班日期 yyyy-MM-dd */
  date: string;
  /** 扫描仪名称 */
  scanner: string;
  /** 当班人 */
  operator: string;
  /** 本班容量（可安排的册次任务数，到顶即满） */
  capacity: number;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ScanShiftDraft = Omit<ScanShift, 'id' | 'createdAt' | 'updatedAt'>;

/** 馆内常用扫描仪，表单可自选也可自填 */
export const SCANNER_OPTIONS: readonly string[] = [
  '赛数 OS15000',
  '成者 Aura ET18',
  '柯达 i3450',
];

/** 历史补录台班的固定 id（升级迁移与播种共用） */
export const LEGACY_SHIFT_ID = 'shift_legacy';

export function createEmptyShiftDraft(): ScanShiftDraft {
  return {
    date: new Date().toISOString().slice(0, 10),
    scanner: SCANNER_OPTIONS[0] as string,
    operator: '',
    capacity: 2,
    note: '',
  };
}
