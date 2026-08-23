import type { DirectorCameraShot } from "./directorProject";

export const CAMERA_BODY_OPTIONS = [
  { value: "cinema", label: "电影摄影机" },
  { value: "dslr", label: "单反 / 微单" },
  { value: "action", label: "运动相机" },
  { value: "drone", label: "无人机" },
] as const;

export const CAMERA_SENSOR_OPTIONS = [
  { value: "full-frame", label: "全画幅", heightMm: 24 },
  { value: "super-35", label: "Super 35", heightMm: 18.66 },
  { value: "aps-c", label: "APS-C", heightMm: 15.6 },
  { value: "mft", label: "M4/3", heightMm: 13 },
] as const;

export const CAMERA_LENS_OPTIONS = [
  { value: "ultra-wide", label: "超广角 18mm", focalLengthMm: 18 },
  { value: "wide", label: "广角 24mm", focalLengthMm: 24 },
  { value: "standard", label: "标准 35mm", focalLengthMm: 35 },
  { value: "normal", label: "自然 50mm", focalLengthMm: 50 },
  { value: "portrait", label: "人像 85mm", focalLengthMm: 85 },
  { value: "telephoto", label: "长焦 135mm", focalLengthMm: 135 },
] as const;

export type DirectorCameraBody = (typeof CAMERA_BODY_OPTIONS)[number]["value"];
export type DirectorCameraSensor = (typeof CAMERA_SENSOR_OPTIONS)[number]["value"];
export type DirectorLensPreset = (typeof CAMERA_LENS_OPTIONS)[number]["value"];

const DEFAULT_SENSOR: DirectorCameraSensor = "super-35";

export function getSensorHeightMm(sensor: DirectorCameraSensor | undefined) {
  return CAMERA_SENSOR_OPTIONS.find((option) => option.value === sensor)?.heightMm ?? 18.66;
}

export function focalLengthToVerticalFov(focalLengthMm: number, sensor: DirectorCameraSensor = DEFAULT_SENSOR) {
  const focal = Math.min(300, Math.max(8, focalLengthMm));
  const radians = 2 * Math.atan(getSensorHeightMm(sensor) / (2 * focal));
  return Number((radians * 180 / Math.PI).toFixed(2));
}

export function verticalFovToFocalLength(fov: number, sensor: DirectorCameraSensor = DEFAULT_SENSOR) {
  const safeFov = Math.min(120, Math.max(10, fov));
  const radians = safeFov * Math.PI / 180;
  return Number((getSensorHeightMm(sensor) / (2 * Math.tan(radians / 2))).toFixed(1));
}

export function normalizeCameraOptics(camera: DirectorCameraShot): DirectorCameraShot {
  const sensorPreset = CAMERA_SENSOR_OPTIONS.some((option) => option.value === camera.sensorPreset)
    ? camera.sensorPreset
    : DEFAULT_SENSOR;
  const focalLengthMm = Number.isFinite(camera.focalLengthMm)
    ? Math.min(300, Math.max(8, camera.focalLengthMm as number))
    : verticalFovToFocalLength(camera.fov, sensorPreset);
  return {
    ...camera,
    cameraBody: CAMERA_BODY_OPTIONS.some((option) => option.value === camera.cameraBody) ? camera.cameraBody : "cinema",
    sensorPreset,
    lensPreset: CAMERA_LENS_OPTIONS.some((option) => option.value === camera.lensPreset) ? camera.lensPreset : "standard",
    focalLengthMm,
    aperture: Number.isFinite(camera.aperture) ? Math.min(22, Math.max(1.2, camera.aperture as number)) : 2.8,
  };
}
