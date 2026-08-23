import { describe, expect, it } from "vitest";
import { focalLengthToVerticalFov, normalizeCameraOptics, verticalFovToFocalLength } from "../cameraOptics";
import type { DirectorCameraShot } from "../directorProject";

const camera: DirectorCameraShot = {
  id: "cam_test",
  name: "测试机位",
  fov: 50,
  transform: { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  targetMode: "manual",
  target: [0, 1, 0],
};

describe("camera optics", () => {
  it("round-trips vertical FOV and focal length for a Super 35 sensor", () => {
    const focal = verticalFovToFocalLength(50, "super-35");
    expect(focalLengthToVerticalFov(focal, "super-35")).toBeCloseTo(50, 0);
  });

  it("adds safe physical-camera defaults to older project cameras", () => {
    expect(normalizeCameraOptics(camera)).toMatchObject({
      cameraBody: "cinema",
      sensorPreset: "super-35",
      lensPreset: "standard",
      aperture: 2.8,
    });
  });
});
