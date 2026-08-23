import test from "node:test"
import assert from "node:assert/strict"
import { creationDeskNavState } from "../lib/creation-desk-nav"

test("home and library do not open the creation desk", () => {
  assert.deepEqual(creationDeskNavState("/home"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/home/session-1"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/library"), { open: false, child: null })
})

test("co-writer, image studio, and video studio open the group and name the child", () => {
  assert.deepEqual(creationDeskNavState("/co-writer"), { open: true, child: "write" })
  assert.deepEqual(creationDeskNavState("/image-studio"), { open: true, child: "image" })
  assert.deepEqual(creationDeskNavState("/video-studio"), { open: true, child: "video" })
})

test("studio prefix match treats nested paths and ignores query strings", () => {
  assert.deepEqual(creationDeskNavState("/image-studio/project-1"), { open: true, child: "image" })
  assert.deepEqual(creationDeskNavState("/video-studio?project=p1&job=j1"), { open: true, child: "video" })
  assert.deepEqual(creationDeskNavState("/co-writer/doc-1"), { open: true, child: "write" })
})

test("non-creation paths do not report a studio child", () => {
  assert.deepEqual(creationDeskNavState("/partners"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/create"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/book"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/settings"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/co-writers"), { open: false, child: null })
  assert.deepEqual(creationDeskNavState("/image-studios"), { open: false, child: null })
})
