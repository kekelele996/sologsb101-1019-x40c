/**
 * 扫描仪（Scanner）数据模型
 * 影像室的设备台账：台班按「扫描仪 × 日期 × 班次」登记，
 * 容量到顶后新到的册排队等下一班。
 */

/** 设备状态：在用 / 停用 */
export type ScannerStatus = 'active' | 'retired';

export interface Scanner {
  id: string;
  /** 设备编号，如 IS-01 */
  code: string;
  /** 设备名称/型号 */
  name: string;
  /** 单台单班最多能扫的册数（台班容量） */
  capacityPerShift: number;
  /** 当前状态 */
  status: ScannerStatus;
  /** 备注（非接触式扫描台等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ScannerDraft = Omit<Scanner, 'id' | 'createdAt' | 'updatedAt'>;

export const SCANNER_STATUS_LABEL: Record<ScannerStatus, string> = {
  active: '在用',
  retired: '停用',
};

export const SCANNER_STATUS_COLOR: Record<ScannerStatus, string> = {
  active: '#1e8449',
  retired: '#8c8c8c',
};

export const SCANNER_STATUS_OPTIONS: ReadonlyArray<{ value: ScannerStatus; label: string }> = [
  { value: 'active', label: '在用' },
  { value: 'retired', label: '停用' },
];

export function createEmptyScannerDraft(): ScannerDraft {
  return {
    code: '',
    name: '',
    capacityPerShift: 3,
    status: 'active',
    note: '',
  };
}
