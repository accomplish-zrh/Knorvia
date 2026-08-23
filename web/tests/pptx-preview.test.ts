import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPptxSlides,
  extractTextRuns,
  isPptxPreviewXml,
  parseRelationshipTargets,
  parseSlideOrder,
  readZipTextFiles,
} from "../lib/pptx-preview";
import { previewKindFor } from "../components/chat/preview/previewerFor";
import {
  canWatchPreviewUrl,
  previewRevisionFingerprint,
  withPreviewRevision,
} from "../lib/preview-revision";
import {
  collectBookIds,
  collectStudioJobRefs,
  collectVideoStudioJobRefs,
  collectVideoStudioProjectRefs,
  hasResearchEvents,
  latestResearchLabelKey,
  videoStudioJobHref,
  videoStudioProjectHref,
} from "../lib/chat-task-cards";
import type { StreamEvent } from "../lib/unified-ws";

test("previewKindFor uses slide cards for pptx, text fallback for legacy ppt", () => {
  assert.equal(previewKindFor({ filename: "deck.pptx" }), "pptx");
  assert.equal(
    previewKindFor({
      filename: "deck",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    "pptx",
  );
  assert.equal(previewKindFor({ filename: "old.ppt" }), "office-text");
});

test("pptx slide builder follows presentation order and text runs", () => {
  const files = new Map<string, string>([
    [
      "ppt/presentation.xml",
      `<p:presentation><p:sldIdLst><p:sldId r:id="rId3"/><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `<Relationships><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId3" Target="slides/slide1.xml"/></Relationships>`,
    ],
    [
      "ppt/slides/slide1.xml",
      `<p:sld><a:t>Title one</a:t><a:t>Bullet A</a:t></p:sld>`,
    ],
    [
      "ppt/slides/slide2.xml",
      `<p:sld><a:t>Title two</a:t></p:sld>`,
    ],
  ]);
  const slides = buildPptxSlides(files);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].title, "Title one");
  assert.deepEqual(slides[0].lines, ["Bullet A"]);
  assert.equal(slides[1].title, "Title two");
  assert.deepEqual(parseSlideOrder(files.get("ppt/presentation.xml") || ""), [
    "rId3",
    "rId2",
  ]);
  assert.equal(
    parseRelationshipTargets(files.get("ppt/_rels/presentation.xml.rels") || "")
      .rId2,
    "slides/slide2.xml",
  );
  assert.deepEqual(extractTextRuns("<a:t>Hello &amp; hi</a:t>"), ["Hello & hi"]);
});

test("pptx preview only inflates presentation metadata and slide XML", () => {
  assert.equal(isPptxPreviewXml("ppt/presentation.xml"), true);
  assert.equal(isPptxPreviewXml("ppt/_rels/presentation.xml.rels"), true);
  assert.equal(isPptxPreviewXml("ppt/slides/slide42.xml"), true);
  assert.equal(isPptxPreviewXml("ppt/media/image1.png"), false);
  assert.equal(isPptxPreviewXml("ppt/media/video1.mp4"), false);
  assert.equal(isPptxPreviewXml("../outside.xml"), false);
});

test("pptx preview rejects an oversized archive before parsing zip structures", async () => {
  await assert.rejects(
    readZipTextFiles(new ArrayBuffer(25 * 1024 * 1024 + 1)),
    /too large to preview/,
  );
});

test("preview revision only cache-busts http(s) and relative urls", () => {
  assert.equal(withPreviewRevision("/api/outputs/a.pptx", 3), "/api/outputs/a.pptx?v=3");
  assert.equal(
    withPreviewRevision("/api/outputs/a.pptx?x=1", 2),
    "/api/outputs/a.pptx?x=1&v=2",
  );
  assert.equal(withPreviewRevision("data:text/plain,hi", 1), "data:text/plain,hi");
  assert.equal(canWatchPreviewUrl("/api/outputs/a.pptx"), true);
  assert.equal(canWatchPreviewUrl("blob:abc"), false);
  assert.equal(
    previewRevisionFingerprint({
      get: (name) => (name === "etag" ? '"1-2"' : name === "content-length" ? "12" : null),
    }),
    '"1-2"||12',
  );
});

test("chat task cards collect studio, research, and book refs", () => {
  const events: StreamEvent[] = [
    {
      type: "progress",
      source: "chat",
      stage: "responding",
      content: "Image Studio queued",
      metadata: { studio_job_id: "job-1", studio_project_id: "proj-1" },
      timestamp: 1,
    },
    {
      type: "progress",
      source: "chat",
      stage: "responding",
      content: "Image Studio running",
      metadata: { studio_job_id: "job-1", studio_project_id: "proj-1" },
      timestamp: 2,
    },
    {
      type: "progress",
      content: "researching",
      source: "deep_research",
      stage: "researching",
      metadata: { research_status_key: "research_topic" },
      timestamp: 3,
    },
    {
      type: "progress",
      source: "book",
      stage: "ideation",
      content: "proposal",
      metadata: { book_id: "bk_1" },
      timestamp: 4,
    },
  ];
  assert.deepEqual(collectStudioJobRefs(events), [
    { jobId: "job-1", projectId: "proj-1" },
  ]);
  assert.deepEqual(collectBookIds(events), ["bk_1"]);
  assert.equal(hasResearchEvents(events), true);
  assert.equal(latestResearchLabelKey(events), "research_topic");
});

test("chat task cards coalesce top-level and nested Video Studio tool metadata", () => {
  const events: StreamEvent[] = [
    {
      type: "tool_result",
      source: "chat",
      stage: "tool",
      content: "queued",
      metadata: {
        tool_metadata: {
          video_studio_job_id: "video job/1",
          video_studio_project_id: "project & 1",
          open_url: "/video-studio?project=project%20%26%201&job=video%20job%2F1",
        },
      },
      timestamp: 5,
    },
    {
      type: "progress",
      source: "chat",
      stage: "responding",
      content: "running",
      metadata: { video_studio_job_id: "video job/1" },
      timestamp: 6,
    },
  ];
  const refs = collectVideoStudioJobRefs(events);
  assert.deepEqual(refs, [
    {
      jobId: "video job/1",
      projectId: "project & 1",
      openUrl: "/video-studio?project=project%20%26%201&job=video%20job%2F1",
    },
  ]);
  assert.equal(
    videoStudioJobHref(refs[0]),
    "/video-studio?project=project+%26+1&job=video+job%2F1",
  );
});

test("collectVideoStudioProjectRefs surfaces storyboard plans without a job", () => {
  const events: StreamEvent[] = [
    {
      type: "progress",
      source: "chat",
      stage: "responding",
      content: "planned",
      metadata: {
        tool_metadata: {
          action: "plan_episode",
          video_studio_project_id: "video_project_desk",
          shot_ids: ["shot_a", "shot_b"],
          open_url: "/video-studio?project=video_project_desk&view=storyboard",
        },
      },
      timestamp: 1,
    },
    {
      type: "progress",
      source: "chat",
      stage: "responding",
      content: "analyzed",
      metadata: {
        action: "analyze_script",
        video_studio_project_id: "video_project_desk",
        shot_count: 4,
        open_url: "/video-studio?project=video_project_desk&view=production",
      },
      timestamp: 2,
    },
  ];
  const refs = collectVideoStudioProjectRefs(events);
  assert.deepEqual(refs, [
    {
      projectId: "video_project_desk",
      action: "plan_episode",
      openUrl: "/video-studio?project=video_project_desk&view=storyboard",
      shotCount: 2,
    },
    {
      projectId: "video_project_desk",
      action: "analyze_script",
      openUrl: "/video-studio?project=video_project_desk&view=production",
      shotCount: 4,
    },
  ]);
  assert.equal(
    videoStudioProjectHref(refs[0]),
    "/video-studio?project=video_project_desk&view=storyboard",
  );
});
