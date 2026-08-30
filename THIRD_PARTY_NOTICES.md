## FlyingMouse Format (design reference; no incorporated code)

- Project: [LaoFeng-mouse/flyingmouse-format](https://github.com/LaoFeng-mouse/flyingmouse-format) — 飞鼠格式, an offline Windows file converter by 牢蜂 (LaoFeng)
- License: custom non-commercial license. **No code from it is used in Knorvia**; only uncopyrightable design ideas were absorbed (capability discovery per file, the engine resolution chain env → managed folder → PATH, alpha-aware media conversion, offline-first engine bundling).
- Engines Knorvia uses for its own conversion toolbox are independent OSS projects resolved on the user's machine: FFmpeg (GPL/LGPL build), LibreOffice, Poppler, Tesseract — plus in-tree PyMuPDF/Pillow/pypdf.


## OpenMAIC (design reference; adapted code and prompts)

- Project: [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) — Open Multi-Agent Interactive Classroom (Tsinghua THU-MAIC team)
- License: MIT (© 2026 THU-MAIC). Used under the MIT license; the notice below applies to the adapted portions.
- Use in Knorvia: the AI Classroom feature (learning space) adapts OpenMAIC's three-stage lesson generation (outlines → scenes → actions), the deterministic action-timeline playback model, the stateless discussion director routing rules, the agent-profile registry concept, and two-tier quiz grading. Adapted in `knorvia/services/classroom/`, `knorvia/api/routers/classroom.py`, `web/lib/classroom-api.ts`, and `web/components/classroom/`.

```
MIT License

Copyright (c) 2026 THU-MAIC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## Real-ESRGAN / Real-ESRGAN NCNN Vulkan

- Projects: [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) and [xinntao/Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)
- Distribution: optional, downloaded on demand from the official `v0.2.5.0` GitHub release and verified with a pinned SHA-256 digest
- Licenses: BSD-3-Clause (Real-ESRGAN and official model weights); MIT (NCNN Vulkan implementation)
- Use in Knorvia: local image super-resolution for Image Studio. The engine runs as a separate process and does not send images to an external service.

The applicable license and copyright notices are retained in Knorvia's source
distribution. Official release assets are not modified; users may remove the
optional runtime from `data/engines/realesrgan-ncnn-vulkan` at any time.

## Video Studio design references (no incorporated code or assets)

For architectural research, the Knorvia team reviewed these public projects:

- [libtv-labs/libtv-skills](https://github.com/libtv-labs/libtv-skills) — MIT
- [Lightricks/LTX-Desktop](https://github.com/Lightricks/LTX-Desktop) — Apache-2.0
- [livepeer/storyboard](https://github.com/livepeer/storyboard) — public source;
  no standard open-source license grant was identified during review
- [VelornLabs/velorn](https://github.com/VelornLabs/velorn) — GPL-3.0
- [pireel/pireel](https://github.com/pireel/pireel) — AGPL-3.0-only

These repositories are not Knorvia dependencies. Knorvia does not distribute
their source, assets, prompts, names, or branding. LibTV's project/session and
incremental-result concepts, Livepeer Storyboard's artifact/capability
separation, and LTX Desktop's local/cloud separation were used only as design
references. Velorn and Pireel were considered only at the product-concept level;
no GPL or AGPL implementation was copied, translated, or adapted. This section
records research provenance and does not imply that those projects endorse or
are bundled with Knorvia.

## CSSwitch

- Project: [SuperJJ007/CSSwitch](https://github.com/SuperJJ007/CSSwitch)
- Source commit: `4e0af6ba7909dca22f1257b168172ecbe4af4836`
- License: MIT
- Copyright: Copyright (c) 2026 shanjunjie
- Adapted concepts: PKCE loopback login, auth generations, atomic credential updates, model-catalog cache invalidation, and redacted operation states.

Knorvia's Codex OAuth support draws on the design concepts listed above and
implements them independently against Knorvia's own settings directory, model
catalog, and provider lifecycle. The MIT license text from that source commit
follows:

```text
MIT License

Copyright (c) 2026 shanjunjie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
