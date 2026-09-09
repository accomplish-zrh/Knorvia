import test from "node:test"
import assert from "node:assert/strict"

import { GOAL_STATUSES, goalActions, goalStatusLabel, isActiveGoal, goalConversationInput } from "../lib/native-goals"

test("goal actions follow the kernel's durable transition rules", () => {
  assert.deepEqual(goalActions("active"), ["pause", "complete"])
  assert.deepEqual(goalActions("paused"), ["resume", "complete"])
  assert.deepEqual(goalActions("blocked"), ["resume", "complete"])
  assert.deepEqual(goalActions("completed"), [], "completed goals stay terminal")
  assert.deepEqual(goalActions("cancelled"), [], "cancelled goals stay terminal")
  assert.deepEqual(goalActions("unknown"), [], "unknown statuses expose no actions")
})

test("goal status labels cover every status and fall back for foreign values", () => {
  for (const status of GOAL_STATUSES) {
    const label = goalStatusLabel(status)
    assert.ok(label.zh.length > 0 && label.en.length > 0, status)
  }
  assert.equal(goalStatusLabel("mystery").en, "mystery")
})

test("only the active status renders as live", () => {
  assert.equal(isActiveGoal("active"), true)
  assert.equal(isActiveGoal("paused"), false)
  assert.equal(isActiveGoal("completed"), false)
})

test("goal conversation shows the supplied action and retains the execution context", () => {
  const context = "Goal: 整理资料\nAcceptance criteria: 保留来源\n并完成核对\nStanding constraints: 不覆盖原文件"
  const input = "继续当前目标。\n保留这行要求。"
  assert.deepEqual(goalConversationInput(`${context}\n\nNext action: ${input}`, "goal-1"), { input, context })
  assert.deepEqual(goalConversationInput(`${context}\n\nNext action: ${input}`.replaceAll("\n", "\r\n"), "goal-1"), { input, context })
})

test("ordinary messages and ambiguous goal envelopes are never shortened", () => {
  const text = "Goal: 整理资料\nAcceptance criteria: 完成\nStanding constraints: \n\nNext action: 开始"
  assert.equal(goalConversationInput(text), null)
  assert.equal(goalConversationInput("继续当前目标。", "goal-1"), null)
  assert.equal(goalConversationInput(text + "\n\nNext action: 引用示例", "goal-1"), null)
  assert.equal(goalConversationInput("Goal: 原样保留\nAcceptance criteria: 缺少字段", "goal-1"), null)
})
