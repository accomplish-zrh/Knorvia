/**
 * 导演台机位 → Knorvia 分镜 camera 字段的宽容映射。
 *
 * `project.get` 的机位对象由导演台自行演进，因此这里不做严格 schema 假设：

 * 从常见字段中提取人类可读名称和运镜词，并保存完整原文供以后精确回放。
 */
import type { DirectorCamera } from './protocol'
export type { DirectorCamera, DirectorProjectResponse } from './protocol'

const LABEL_FIELDS = [
  'name',
  'label',
  'title',
  'id',
  'cameraType',
  'type',
  'kind',
  'motion',
  'movement',
  'shotType',
]

const MOTION_FIELDS = [
  'motion',
  'movement',
  'cameraMotion',
  'move',
  'cameraType',
  'type',
  'kind',
  'name',
  'label',
  'title',
]

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstText(camera: DirectorCamera, fields: string[]): string {
  for (const field of fields) {
    const value = text((camera as Record<string, unknown>)[field])
    if (value) return value
  }
  return ''
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle)
}

/** 人类可读的机位名；缺省回退到机位 id。 */
export function directorCameraLabel(camera: DirectorCamera): string {
  return firstText(camera, LABEL_FIELDS) || camera.id || 'Director camera'
}

/**
 * 把机位描述折叠为 Knorvia 已有的短运镜词（CAMERA_VALUE_LABELS 的键）。
 * 无法识别时返回 `custom`，完整机位对象仍保存在 `director_camera_json`。
 */
export function directorCameraMotion(camera: DirectorCamera): string {
  const haystack = normalize(
    MOTION_FIELDS.map(field => text((camera as Record<string, unknown>)[field]))
      .filter(Boolean)
      .join(' ')
  )
  if (!haystack) return 'custom'
  if (contains(haystack, '左摇') || contains(haystack, '左移')) return 'pan-left'
  if (contains(haystack, '右摇') || contains(haystack, '右移')) return 'pan-right'
  if (contains(haystack, '推')) return 'push'
  if (contains(haystack, '拉')) return 'pull'
  if (contains(haystack, '环绕')) return 'orbit'
  if (contains(haystack, '跟随')) return 'follow'
  if (contains(haystack, '固定') || contains(haystack, '静止')) return 'fixed'
  if (contains(haystack, '缩放') || contains(haystack, '变焦')) return 'zoom'
  if (contains(haystack, 'panleft') || contains(haystack, 'leftpan')) return 'pan-left'
  if (contains(haystack, 'panright') || contains(haystack, 'rightpan')) return 'pan-right'
  if (contains(haystack, 'tiltup') || contains(haystack, 'uptilt')) return 'tilt-up'
  if (contains(haystack, 'tiltdown') || contains(haystack, 'downtilt')) return 'tilt-down'
  if (contains(haystack, 'zoomin') || contains(haystack, 'dollyin') || contains(haystack, 'movein')) return 'push'
  if (contains(haystack, 'zoomout') || contains(haystack, 'dollyout') || contains(haystack, 'moveout')) return 'pull'
  if (contains(haystack, 'push')) return 'push'
  if (contains(haystack, 'pull')) return 'pull'
  if (contains(haystack, 'orbit')) return 'orbit'
  if (contains(haystack, 'follow')) return 'follow'
  if (contains(haystack, 'roll')) return 'roll'
  if (contains(haystack, 'pan')) return 'pan'
  if (contains(haystack, 'tilt')) return 'tilt'
  if (contains(haystack, 'zoom')) return 'zoom'
  if (contains(haystack, 'fixed') || contains(haystack, 'static')) return 'fixed'
  return 'custom'
}

export interface DirectorCameraShotPatch {
  camera: string
  director_camera_id: string | null
  director_camera_json: Record<string, unknown>
}

export function directorCameraShotPatch(camera: DirectorCamera): DirectorCameraShotPatch {
  return {
    camera: directorCameraMotion(camera),
    director_camera_id: camera.id || null,
    director_camera_json: camera as Record<string, unknown>,
  }
}
