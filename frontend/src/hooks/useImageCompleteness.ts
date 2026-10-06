/**
 * useImageCompleteness：一册修后影像是否「齐」的派生判定
 * 被影像室页面、装订页（影像齐才放进装订）、册次台账消费。
 *
 * 齐套规则（修复室只认册次、书叶）：
 * - 该册登记叶数内的每一叶都至少有一张合格（ok）影像；
 * - 存在漏扫（missing）或待重拍（retake）都不算齐，影像室只重出这几张即可，工序照旧。
 */
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ImageRecord } from '@/types/imageRecord'
import { isOrphanImage } from '@/types/imageRecord'
import type { Volume } from '@/types/volume'

export interface VolumeImageStatus {
  /** 册次叶数（修复室口径） */
  leafCount: number
  /** 已出合格影像覆盖到的不同叶号数 */
  coveredLeaves: number
  /** 待重拍张数 */
  retakeCount: number
  /** 漏扫占位数 */
  missingCount: number
  /** 合格影像张数 */
  okCount: number
  /** 尚缺合格影像的叶号（升序） */
  missingLeafNos: number[]
  /** 是否齐套：每叶一张合格影像，且无待重拍 */
  complete: boolean
}

/** 计算单册影像状态；images 传影像室全量或该册影像均可 */
export function imageStatusOf(
  volume: Pick<Volume, 'leafCount'> | undefined,
  images: ImageRecord[]
): VolumeImageStatus {
  const leafCount = volume?.leafCount ?? 0
  const list = images.filter((image) => !isOrphanImage(image))
  const okLeafSet = new Set<number>()
  let retakeCount = 0
  let missingCount = 0
  let okCount = 0
  list.forEach((image) => {
    if (image.state === 'ok') {
      okCount += 1
      if (image.leafNo >= 1 && image.leafNo <= leafCount) okLeafSet.add(image.leafNo)
    } else if (image.state === 'retake') {
      retakeCount += 1
    } else if (image.state === 'missing') {
      missingCount += 1
    }
  })
  const missingLeafNos: number[] = []
  for (let no = 1; no <= leafCount; no += 1) {
    if (!okLeafSet.has(no)) missingLeafNos.push(no)
  }
  // 待重拍叶也要重出，同样视为未齐
  const retakeLeafSet = new Set(list.filter((i) => i.state === 'retake').map((i) => i.leafNo))
  retakeLeafSet.forEach((no) => {
    if (no >= 1 && no <= leafCount && !missingLeafNos.includes(no)) missingLeafNos.push(no)
  })
  missingLeafNos.sort((a, b) => a - b)
  return {
    leafCount,
    coveredLeaves: okLeafSet.size,
    retakeCount,
    missingCount,
    okCount,
    missingLeafNos,
    complete: leafCount > 0 && missingLeafNos.length === 0
  }
}

export function useImageCompleteness(
  volume: MaybeRefOrGetter<Pick<Volume, 'leafCount'> | undefined>,
  images: MaybeRefOrGetter<ImageRecord[]>
) {
  const status = computed<VolumeImageStatus>(() => imageStatusOf(toValue(volume), toValue(images)))
  const complete = computed(() => status.value.complete)
  return { status, complete }
}
