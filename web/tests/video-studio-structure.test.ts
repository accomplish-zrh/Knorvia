import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webRoot = process.cwd()
const pageSource = readFileSync(join(webRoot, 'app', '(workspace)', 'video-studio', 'page.tsx'), 'utf8')
const apiSource = readFileSync(join(webRoot, 'lib', 'video-studio-api.ts'), 'utf8')
const previewSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoPreview.tsx'), 'utf8')
const composerSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoComposer.tsx'), 'utf8')
const queueSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoJobQueue.tsx'), 'utf8')
const taskCardSource = readFileSync(join(webRoot, 'components', 'chat', 'home', 'ChatTaskCards.tsx'), 'utf8')
const taskLogicSource = readFileSync(join(webRoot, 'lib', 'chat-task-cards.ts'), 'utf8')

test('video studio owns project epochs, one batched follow loop, and persisted storyboard CAS', () => {
  assert.match(pageSource, /projectEpochRef/)
  // One aggregated poller for every active job (batched endpoint), not a
  // private per-job request loop.
  assert.match(pageSource, /followLoopRef/)
  assert.match(pageSource, /followCursorsRef/)
  assert.match(pageSource, /startFollowLoop/)
  assert.match(pageSource, /followVideoJobs\(/)
  assert.doesNotMatch(pageSource, /followerControllersRef/)
  assert.match(apiSource, /jobs:follow/)
  assert.match(pageSource, /controller\.abort\(\)/)
  assert.match(pageSource, /saveVideoStoryboard/)
  assert.match(pageSource, /error\.status === 409/)
  assert.match(pageSource, /latest version was loaded/)
  assert.match(pageSource, /const deepLink = new URLSearchParams\(window\.location\.search\)/)
  assert.match(pageSource, /deepLink\.get\('project'\)/)
  assert.match(pageSource, /submissionGuardRef/)
  assert.match(pageSource, /flushBeforeProjectChange/)
  assert.match(pageSource, /beforeunload/)
  assert.match(pageSource, /visibilitychange/)
  assert.match(pageSource, /storyboardDirtyRef/)
  assert.match(pageSource, /onRemoveAsset=\{assetId => \{[\s\S]*invalidateVideoSubmissionRequest/)
  assert.match(pageSource, /patch\.prompt !== undefined\) setPrompt\(patch\.prompt\)/)
  assert.match(pageSource, /storyboard_shot_id: shot\?\.id \?\? null/)
  assert.doesNotMatch(pageSource, /shot\?\.id \|\| job\.storyboard_shot_id/)
  assert.match(pageSource, /observeSubmittedJob[\s\S]*isVideoJobFinal\(job\.status\)[\s\S]*previewOutput\(outputId, job\)/)
  assert.match(pageSource, /setOffline\(false\)/)
})

test('job API pins idempotency, cost confirmation, monotonic event cursor, and If-Match', () => {
  assert.match(apiSource, /client_request_id: string/)
  assert.match(apiSource, /confirmed_cost: true/)
  assert.match(apiSource, /storyboard_shot_id/)
  assert.match(apiSource, /retryVideoJob[\s\S]*client_request_id/)
  assert.match(apiSource, /after_seq/)
  assert.match(apiSource, /next_seq/)
  assert.match(apiSource, /'If-Match'/)
  assert.match(apiSource, /projects\?limit=100/)
  assert.match(apiSource, /Math\.min\(12_000/)
  assert.match(apiSource, /discardVideoUploadSession/)
  assert.match(apiSource, /if \(!completed\) await discardVideoUploadSession/)
})

test('video preview streams the same-origin asset URL directly instead of fetching a Blob', () => {
  assert.match(previewSource, /<video/)
  assert.match(previewSource, /src=\{videoAssetUrl\(asset\.id\)\}/)
  assert.doesNotMatch(previewSource, /apiFetch|createObjectURL|arrayBuffer|base64/)
  assert.match(pageSource, /void previewOutput\(shot\.output_asset_id, job\)/)
})

test('deprecated model lifecycle is surfaced without blocking generation', () => {
  assert.match(composerSource, /lifecycle\?\.status === 'deprecated'/)
  assert.match(composerSource, /scheduled to stop working/)
})

test('historical tasks do not claim provider cancellation after their model disappears', () => {
  assert.match(queueSource, /Boolean\(model\) && model\?\.capabilities\.supports_cancel !== false/)
})

test('agent video tasks deep-link into and focus the exact persisted job', () => {
  assert.match(taskLogicSource, /meta\.tool_metadata/)
  assert.match(taskLogicSource, /video_studio_job_id/)
  assert.match(taskLogicSource, /collectVideoStudioProjectRefs/)
  assert.match(taskCardSource, /followVideoJob/)
  assert.match(taskCardSource, /normalizedJobProgress/)
  assert.match(taskCardSource, /videoStudioJobHref/)
  assert.match(taskCardSource, /videoStudioProjectHref/)
  assert.match(taskCardSource, /Storyboard planned/)
  assert.match(taskCardSource, /videoAssetUrl\(outputId\)/)
  assert.match(pageSource, /deepLink\.get\('job'\)/)
  assert.match(pageSource, /deepLink\.get\('view'\)/)
  assert.match(pageSource, /deepLink\.get\('shot'\)/)
  assert.match(pageSource, /activateVideoProject/)
  assert.match(pageSource, /getVideoJob\(requestedJobId/)
  assert.match(pageSource, /setFocusedJobId\(deepLinkedJob\.id\)/)
  assert.match(apiSource, /\/activate/)
  assert.match(queueSource, /data-focused=/)
  assert.match(queueSource, /scrollIntoView/)
})

test('canvas workbench: persisted view toggle, board CAS save chain, node jobs', () => {
  // §5.2 view toggle persisted under its own storage key (key defined in
  // lib/video-studio/page-helpers.ts, imported by the page)
  assert.match(pageSource, /VIDEO_VIEW_STORAGE_KEY/)
  assert.match(pageSource, /changeViewMode\('board'\)/)
  assert.match(pageSource, /changeViewMode\('storyboard'\)/)
  assert.match(pageSource, /changeViewMode\('production'\)/)
  assert.match(pageSource, /saveToStorage\(VIDEO_VIEW_STORAGE_KEY, mode\)/)
  // board renders through the shared canvas component with live job states
  assert.match(pageSource, /<VideoInfiniteBoard/)
  assert.match(pageSource, /jobsById=\{jobsById\}/)
  assert.match(pageSource, /onGenerateRequest=\{nodeId => void handleGenerateBoardNode\(nodeId\)\}/)
  assert.match(pageSource, /focusNodeRef=\{boardFocusNodeRef\}/)
  assert.match(pageSource, /onDropAsset=\{dropAssetOnBoard\}/)
  // §5.7 canvas generation sends role-tagged inputs bound to the node
  assert.match(pageSource, /videoInputSpecs\(boardRef\.current, nodeId\)/)
  assert.match(pageSource, /collectVideoNodePrompt\(boardRef\.current, nodeId\)/)
  assert.match(pageSource, /boardNodeId: nodeId/)
  assert.match(pageSource, /applyVideoJobToBoard\(boardRef\.current, \{/)
  assert.match(pageSource, /job\.board_node_id/)
  // board CAS persistence mirrors the storyboard save chain
  assert.match(pageSource, /saveVideoBoard/)
  assert.match(pageSource, /VideoBoardConflictError/)
  assert.match(pageSource, /boardSaveRunningRef/)
  assert.match(pageSource, /flushBoard/)
  assert.match(pageSource, /boardDirtyRef\.current \|\| boardSaveRunningRef\.current/)
  // templates + storyboard ⇄ canvas flows
  assert.match(pageSource, /BOARD_TEMPLATE_IDS\.map/)
  assert.match(pageSource, /placeVideoBoardTemplate/)
  assert.match(pageSource, /importVideoStoryboardToBoard/)
  assert.match(pageSource, /exportVideoBoardToStoryboard/)
})

test('board API pins If-Match CAS, conflict code, and role-tagged job inputs', () => {
  assert.match(apiSource, /board_revision_conflict/)
  assert.match(apiSource, /VideoBoardConflictError/)
  assert.match(apiSource, /board_node_id\?: string \| null/)
  assert.match(apiSource, /inputs\?: VideoJobInput\[\]/)
  assert.match(apiSource, /board\/templates\//)
  assert.match(apiSource, /board\/import-storyboard/)
  assert.match(apiSource, /board\/export-storyboard/)
  // the server rejects bodies carrying both input forms
  assert.match(apiSource, /body\.input_asset_ids = \[\]/)
  assert.match(apiSource, /delete body\.inputs/)
})

test('phase A export loop: two-step paid shot actions and the free local compose panel', () => {
  const storyboardSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoStoryboard.tsx'), 'utf8')
  const composeSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoComposePanel.tsx'), 'utf8')
  // paid shot actions require a two-step arm/confirm guard with auto-disarm
  assert.match(storyboardSource, /useArmedPaidAction/)
  assert.match(storyboardSource, /keyframeGuard\.armed\(selected\.id\)/)
  assert.match(storyboardSource, /voiceoverGuard\.armed\(selected\.id\)/)
  // keyframe/voiceover results render inline (thumbnail + audio preview)
  assert.match(storyboardSource, /assetUrl\(shot\.keyframe_asset_id\)/)
  assert.match(storyboardSource, /src=\{assetUrl\(selected\.voiceover_asset_id\)\}/)
  // the page wires both paid actions through the storyboard component
  assert.match(pageSource, /onGenerateKeyframe=\{\(shot, promptOverride\) => void generateShotKeyframe\(shot, promptOverride\)\}/)
  assert.match(pageSource, /onGenerateVoiceover=\{\(shot, text, voice\) => void generateShotVoiceover\(shot, text, voice\)\}/)
  assert.match(pageSource, /generateVideoShotKeyframe\(id, shot\.id, \{/)
  assert.match(pageSource, /generateVideoShotVoiceover\(id, shot\.id, \{/)
  // the free local composition runs without cost confirmation
  assert.match(pageSource, /<VideoComposePanel/)
  assert.match(pageSource, /composeVideoProject\(id, \{/)
  assert.match(pageSource, /client_request_id: crypto\.randomUUID\(\)/)
  assert.match(pageSource, /installVideoFfmpeg/)
  assert.match(pageSource, /listVideoCompositions/)
  // the compose panel gates on ffmpeg availability and counts composable shots
  assert.match(composeSource, /ffmpeg\?.available === true/)
  assert.match(composeSource, /shot\.output_asset_id \|\| shot\.keyframe_asset_id/)
  assert.match(composeSource, /install_supported/)
})

test('phase D2 subtitles: editor table saves an asset the compose panel can burn', () => {
  const editorSource = readFileSync(join(webRoot, 'components', 'video-studio', 'SubtitleEditor.tsx'), 'utf8')
  const composeSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoComposePanel.tsx'), 'utf8')
  // The editor edits through the shared pure logic and blocks broken saves.
  assert.match(editorSource, /from '@\/lib\/video-studio\/subtitle-logic'/)
  assert.match(editorSource, /serializeSrt\(sanitizeCues\(cues\)\)/)
  assert.match(editorSource, /cuesHaveIssues/)
  assert.match(editorSource, /splitCue/)
  assert.match(editorSource, /adjustCueBound/)
  assert.match(editorSource, /shiftCues/)
  // Saving adopts an SRT document as a subtitle asset (create or in-place update).
  assert.match(editorSource, /saveVideoSubtitleAsset/)
  assert.match(editorSource, /updateVideoSubtitleAsset/)
  // The compose panel exposes all four caption sources plus the style presets.
  assert.match(composeSource, /SUBTITLE_SOURCE_MODES/)
  assert.match(composeSource, /SUBTITLE_STYLE_OPTIONS/)
  assert.match(composeSource, /from_asr/)
  assert.match(composeSource, /from_asset/)
  assert.match(composeSource, /srt_asset_id: subtitleMode === 'from_asset' \? srtAssetId : ''/)
  // from_asset without a file must not fire a doomed composition.
  assert.match(composeSource, /subtitleMode === 'from_asset' && !srtAssetId/)
  // The three subtitle selects carry data-* scoping hooks for the audits
  // (their label innerText includes option texts, so label matching is ambiguous).
  assert.match(composeSource, /data-subtitle-mode/)
  assert.match(composeSource, /data-subtitle-style/)
  assert.match(composeSource, /data-subtitle-asset/)
  // The page forwards style + srt_asset_id and adopts editor saves into assets.
  assert.match(pageSource, /srt_asset_id: config\.srt_asset_id/)
  assert.match(pageSource, /style: config\.subtitle_style/)
  assert.match(pageSource, /onAssetSaved=/)
  // The API layer pins the new subtitle-asset endpoints.
  assert.match(apiSource, /\/subtitle-assets/)
  assert.match(apiSource, /\/assets\/\$\{encodeURIComponent\(assetId\)\}\/subtitle/)
  assert.match(apiSource, /srt_asset_id\?: string/)
})

test('phase E/F export polish: timeline view, trim handles, upscale toggle, and burn-in overrides', () => {
  const composeSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoComposePanel.tsx'), 'utf8')
  const timelineSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoTimeline.tsx'), 'utf8')
  // F1: the page mounts the timeline with reorder/trim callbacks over pure layout
  assert.match(pageSource, /<VideoTimeline/)
  assert.match(pageSource, /reorderStoryboardShots\(storyboardRef\.current, from, to\)/)
  assert.match(pageSource, /videoAssetThumbnailUrl/)
  assert.match(timelineSource, /timelineLayout\(document\.shots\)/)
  assert.match(timelineSource, /rulerTicks\(total, pxPerSecond\)/)
  assert.match(timelineSource, /reorderTarget\(layout\.blocks, current\.index, seconds\)/)
  // E3 trim: drag edges and keyboard nudges both funnel through resolveTrimPatch
  assert.match(timelineSource, /aria-label=\{t\('Trim start'\)\}/)
  assert.match(timelineSource, /aria-label=\{t\('Trim end'\)\}/)
  assert.match(timelineSource, /resolveTrimPatch\(/)
  // F1: the music bed band reacts to the compose panel's lifted BGM selection
  assert.match(timelineSource, /bgmAssetId \? t\('Music bed'\) : t\('No music bed selected'\)/)
  // E2: size/colour overrides clamp/convert client-side before submission
  assert.match(composeSource, /clampSubtitleFontSize/)
  assert.match(composeSource, /hexToAssColour/)
  assert.match(composeSource, /data-subtitle-font-size/)
  assert.match(composeSource, /data-subtitle-colour/)
  assert.match(composeSource, /fontSizeInvalid/)
  // E5: the experimental upscale locks the output to 1080p and warns
  assert.match(composeSource, /data-upscale-toggle/)
  assert.match(composeSource, /resolution: upscale \? '1080p' : resolution/)
  assert.match(composeSource, /disabled=\{upscale\}/)
  // the page forwards every override into the compose request
  assert.match(pageSource, /font_size: config\.subtitle_font_size/)
  assert.match(pageSource, /primary_colour: config\.subtitle_primary_colour/)
  assert.match(pageSource, /upscale: true/)
  // the API layer pins the E2/E5 request fields
  assert.match(apiSource, /font_size\?: number/)
  assert.match(apiSource, /primary_colour\?: string/)
  assert.match(apiSource, /upscale\?: boolean/)
})

test('phase C4 camera control: composer chips, canvas badge, and plan field', () => {
  const boardNodeSource = readFileSync(join(webRoot, 'components', 'video-studio', 'VideoBoardNode.tsx'), 'utf8')
  // composer: only camera* string enums with fully-known labels chip out
  assert.match(composerSource, /name\.startsWith\('camera'\) && cameraChipValues\(schema\) !== null/)
  assert.match(composerSource, /function CameraChips\(/)
  assert.match(composerSource, /data-camera-chips=\{name\}/)
  // chips are single-select (re-click clears) and carry a localized clear button
  assert.match(composerSource, /aria-pressed=\{value === option\}/)
  assert.match(composerSource, /onValue\(value === option \? '' : option\)/)
  assert.match(composerSource, /aria-label=\{t\('Clear camera selection'\)\}/)
  // chip labels go through the i18n label map, never the raw enum value
  assert.match(composerSource, /\{t\(CAMERA_VALUE_LABELS\[option\]\)\}/)
  // non-camera enums keep the advanced-parameters dropdown branch untouched
  assert.match(composerSource, /!cameraGroups\.some\(\(\[cameraName\]\) => cameraName === name\)/)
  assert.match(composerSource, /extraProperties\.map/)
  // canvas generate card badges the stored motion with a localized fallback
  assert.match(boardNodeSource, /node\.camera \? \(/)
  assert.match(boardNodeSource, /labels\.cameraMotions\[node\.camera\] \|\| node\.camera/)
  // the page resolves the badge motion onto the model's own camera parameter
  // at submit time and labels every motion value for the badge
  assert.match(pageSource, /cameraParameterForKey\(capabilities, node\.camera\)/)
  assert.match(pageSource, /\[nodeCamera\.key\]: nodeCamera\.value/)
  assert.match(pageSource, /CAMERA_VALUE_LABELS\)\.map\(\(\[value, label\]\) => \[value, t\(label\)\]\)/)
})

test('white-model previs: third view mode, reference-to-export loop, theme hook, and i18n keys', () => {
  const panelSource = readFileSync(join(webRoot, 'components', 'video-studio', 'DirectorDeskPanel.tsx'), 'utf8')
  const hookSource = readFileSync(join(webRoot, 'lib', 'director-desk', 'use-director-desk.ts'), 'utf8')
  const clientSource = readFileSync(join(webRoot, 'lib', 'director-desk', 'client.ts'), 'utf8')
  const zhSource = readFileSync(join(webRoot, 'locales', 'zh', 'app.json'), 'utf8')
  const enSource = readFileSync(join(webRoot, 'locales', 'en', 'app.json'), 'utf8')

  // the page mounts the panel as the persisted third view mode with a localized tab
  assert.match(pageSource, /'storyboard' \| 'board' \| 'director'/)
  assert.match(pageSource, /<DirectorDeskPanel/)
  assert.match(pageSource, /t\('White-model Previs'\)/)
  assert.match(pageSource, /t\('Previs'\)/)
  assert.match(pageSource, /data-director-embed/)
  assert.match(pageSource, /directorMounted/)
  assert.match(pageSource, /viewMode === 'director' \? '!hidden'/)
  assert.match(pageSource, /onSelectShot=\{selectShot\}/)
  assert.match(panelSource, /aria-label=\{t\('Target shot'\)\}/)
  assert.match(panelSource, /sceneReferenceSources/)
  assert.match(panelSource, /selectedShot\?\.keyframe_asset_id/)
  assert.match(panelSource, /exportVideoToAssets/)
  assert.match(panelSource, /t\('Previs video to assets'\)/)
  // host chrome stays outside the iframe so it cannot cover the desk HUD
  assert.match(panelSource, /data-director-toolbar/)
  assert.match(panelSource, /relative z-30/)
  assert.match(panelSource, /data-director-captures/)
  assert.doesNotMatch(panelSource, /absolute inset-x-0 bottom-0/)
  assert.doesNotMatch(panelSource, /absolute top-3 left-3/)

  // theme follows the app theme subscription and hot-swaps via openSession (no iframe reload)
  assert.match(hookSource, /subscribeToThemeChanges/)
  assert.match(hookSource, /getStoredTheme\(\) \?\? getSystemTheme\(\)/)
  assert.match(hookSource, /client\.openSession\(theme\)/)
  assert.doesNotMatch(hookSource, /directorDeskUrl\(\{ instanceId, hostOrigin, theme \}\)/)

  // the static desk bundle is same-origin and requests no camera/microphone capture
  // (the bundle has zero getUserMedia/mediaDevices call sites)
  assert.match(panelSource, /allow="autoplay; fullscreen"/)
  assert.doesNotMatch(panelSource, /camera; microphone/)

  // host-side bridge validates both the source window and the origin of every message
  assert.match(clientSource, /event\.source !== this\.iframe\.contentWindow\) return/)
  assert.match(clientSource, /event\.origin !== window\.location\.origin\) return/)

  // every white-model previs UI string exists in both locales (parity of the new keys)
  for (const locale of [zhSource, enSource]) {
    assert.match(locale, /"White-model Previs":/)
    assert.match(locale, /"Previs":/)
    assert.match(locale, /"Previs video to assets":/)
    assert.match(locale, /"Scene reference image":/)
    assert.match(locale, /"Export current frame":/)
    assert.match(locale, /"Export reference video":/)
    assert.match(locale, /"Project JSON":/)
    assert.match(locale, /"Inject panorama":/)
    assert.match(locale, /"Set as shot keyframe":/)
    assert.match(locale, /"The 3D director desk needs a video project first\.":/)
  }
})
