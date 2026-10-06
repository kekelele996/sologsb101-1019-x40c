/**
 * 影像（ImageRecord）数据模型
 * 影像室为某册某叶出的修后存档影像。
 * - 漏扫 / 拍糊只重出这一册的那几张：把该张标记 retake（待重拍），重拍合格后回到 ok；
 *   修复室的工序记录照旧，不因此改动。
 * - 一册每叶都有一张合格影像才算「影像齐」，修复室才放它进装订。
 * - 历史升级数据里缺册号的影像没有 volumeId，作为无主记录只读留着等人认领。
 */

/**
 * 影像状态：
 * - ok 合格（有效存档影像）
 * - retake 拍糊/有问题，只重出这一张（待重拍）
 * - missing 漏扫占位：该叶应有但还没出片
 */
export type ImageState = 'ok' | 'retake' | 'missing';

/** 影像来源：日常台班扫描 / 升级时按已扫册次补录的历史影像 */
export type ImageSource = 'shift' | 'legacy';

export interface ImageRecord {
  id: string;
  /** 所属册次 id；历史无主记录为空字符串，只读等人认领 */
  volumeId: string;
  /** 叶号；无主记录里可保留旧编号 */
  leafNo: number;
  /** 出片张数（该叶一次可留一张正片，重拍另记轮次） */
  frameNo: string;
  /** 重拍轮次，首次出片为 0 */
  retakeRound: number;
  /** 影像状态 */
  state: ImageState;
  /** 来源 */
  source: ImageSource;
  /** 出片台班 id；历史补录可能为空 */
  shiftId: string;
  /** 拍摄/操作人（影像室） */
  operator: string;
  /** 无主历史影像上保留的旧册号，认领时供人核对 */
  legacyVolumeNo: string;
  /** 备注（拍糊原因等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ImageRecordDraft = Omit<ImageRecord, 'id' | 'createdAt' | 'updatedAt'>;

export const IMAGE_STATE_LABEL: Record<ImageState, string> = {
  ok: '合格',
  retake: '待重拍',
  missing: '漏扫',
};

export const IMAGE_STATE_COLOR: Record<ImageState, string> = {
  ok: '#1e8449',
  retake: '#d68910',
  missing: '#b03a2e',
};

export const IMAGE_STATE_OPTIONS: ReadonlyArray<{ value: ImageState; label: string }> = [
  { value: 'ok', label: '合格' },
  { value: 'retake', label: '待重拍' },
  { value: 'missing', label: '漏扫' },
];

export const IMAGE_SOURCE_LABEL: Record<ImageSource, string> = {
  shift: '台班扫描',
  legacy: '历史补录',
};

export function createEmptyImageRecordDraft(volumeId: string, leafNo: number, shiftId = ''): ImageRecordDraft {
  return {
    volumeId,
    leafNo,
    frameNo: '',
    retakeRound: 0,
    state: 'ok',
    source: 'shift',
    shiftId,
    operator: '',
    legacyVolumeNo: '',
    note: '',
  };
}

/** 缺册号的历史影像：无主，只读留着等人认领 */
export function isOrphanImage(record: Pick<ImageRecord, 'volumeId' | 'source'>): boolean {
  return record.source === 'legacy' && !record.volumeId;
}

/** 无主记录在认领前只读：不能改内容、不能删 */
export function isImageReadOnly(record: Pick<ImageRecord, 'volumeId' | 'source'>): boolean {
  return isOrphanImage(record);
}

/** 该张是否为有效存档影像（合格计入齐套） */
export function isValidImage(state: ImageState): boolean {
  return state === 'ok';
}
