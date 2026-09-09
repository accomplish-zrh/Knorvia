import test from "node:test"
import assert from "node:assert/strict"

import {
  WORKBENCH_NAV,
  isWorkbenchHref,
  knorviaApiPath,
  packInvokePath,
} from "../lib/workbench-api"

test("workbench nav covers Workspace product surfaces", () => {
  const labels: string[] = WORKBENCH_NAV.map((item) => item.label)
  for (const need of ["New task", "Projects", "All tasks", "Outputs", "Extensions", "Settings"]) {
    assert.ok(labels.includes(need), `missing ${need}`)
  }
  assert.equal(isWorkbenchHref("/workbench/packs"), true)
  assert.equal(isWorkbenchHref("/settings"), false)
})

test("workbench API paths go to knorvia-daemon prefix not FastAPI chat", () => {
  assert.equal(knorviaApiPath("packs"), "/api/v1/knorvia/packs")
  assert.equal(packInvokePath(), "/api/v1/knorvia/packs/invoke")
  assert.ok(!knorviaApiPath("packs").includes("/api/v1/ws"))
  assert.ok(!knorviaApiPath("packs").includes("/chat"))
})
