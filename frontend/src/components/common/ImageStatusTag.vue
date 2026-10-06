<script setup lang="ts">
/**
 * <ImageStatusTag> 册次修后影像齐套徽标
 * 被影像室页面、装订归档页、古籍册次台账消费。
 * - 无扫描记录：未送扫
 * - 未齐（缺合格叶 / 有待重拍）：显示缺片数，不可进装订
 * - 齐套：可放行进装订
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 册次叶数 */
    leafCount: number
    /** 已覆盖合格叶数 */
    coveredLeaves: number
    /** 待重拍张数 */
    retakeCount?: number
    /** 漏扫占位数 */
    missingCount?: number
    /** 是否已登记扫描任务（无任务显示「未送扫」） */
    hasJob?: boolean
    size?: 'default' | 'small'
  }>(),
  {
    retakeCount: 0,
    missingCount: 0,
    hasJob: true,
    size: 'default'
  }
)

const view = computed(() => {
  if (!props.hasJob) return { label: '未送扫', color: '#8c8c8c', bg: 'rgba(140,140,140,0.10)' }
  const uncovered = Math.max(0, props.leafCount - props.coveredLeaves)
  if (uncovered === 0 && props.retakeCount === 0) {
    return { label: '影像齐', color: '#1e8449', bg: 'rgba(30,132,73,0.10)' }
  }
  const bits: string[] = []
  if (uncovered > 0) bits.push(`缺 ${uncovered} 叶`)
  if (props.retakeCount > 0) bits.push(`${props.retakeCount} 张待重拍`)
  return { label: `未齐（${bits.join('，')}）`, color: '#d68910', bg: 'rgba(214,137,16,0.10)' }
})
</script>

<template>
  <span class="img-tag" :class="[`is-${size}`]" :style="{ color: view.color, backgroundColor: view.bg, borderColor: `${view.color}55` }">
    {{ view.label }}
  </span>
</template>

<style scoped>
.img-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 12px;
  font-style: normal;
  white-space: nowrap;
}

.img-tag.is-small {
  padding: 1px 8px;
  font-size: 11px;
}
</style>
