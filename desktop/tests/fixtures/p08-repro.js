"use strict";
// P08 缺陷复现（无网络纯函数）：模拟 main.js 现有往返方式。
const updateCheck = require("../../update-check");

// 1) asset 往返丢失 installer：normalize 后的 assets（带 url）被 main.js 再塞回
//    decideUpdate，extractLatestRelease 只认 browser_download_url → installer null。
const payload = {
  tag_name: "v1.2.0",
  html_url: "https://github.com/o/r/releases/tag/v1.2.0",
  body: "notes",
  assets: [{ name: "Knorvia-1.2.0-setup.exe", browser_download_url: "https://u/setup", size: 300 }],
};
const normalized = updateCheck.extractLatestRelease(payload);
const mainLikePayload = {
  tag_name: normalized.version,
  html_url: normalized.url,
  body: normalized.notes,
  assets: normalized.assets, // url 形态
};
const decision = updateCheck.decideUpdate({ currentVersion: "1.0.0", latest: mainLikePayload });
console.log("defect1 installerAfterMainRoundTrip:", JSON.stringify(decision.installer));

// 2) beta.10 被字典序判小于 beta.2
console.log(
  "defect2 compareSemver('1.2.0-beta.10','1.2.0-beta.2'):",
  updateCheck.compareSemver("1.2.0-beta.10", "1.2.0-beta.2"),
);

// 3) +build 被当成 prerelease
console.log(
  "defect3 compareSemver('1.2.0+build.7','1.2.0'):",
  updateCheck.compareSemver("1.2.0+build.7", "1.2.0"),
);
console.log(
  "defect3 parseSemver('1.2.0+build.7').pre:",
  JSON.stringify(updateCheck.parseSemver("1.2.0+build.7").pre),
);
