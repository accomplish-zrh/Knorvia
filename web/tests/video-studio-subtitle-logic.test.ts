import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  SUBTITLE_SOURCE_MODES,
  SUBTITLE_STYLE_OPTIONS,
  addCueAfter,
  adjustCueBound,
  assColourToHex,
  clampSubtitleFontSize,
  cueIssue,
  cuesHaveIssues,
  cueDuration,
  draftCues,
  formatTimecode,
  hexToAssColour,
  parseSrt,
  parseTimecode,
  renumberCues,
  removeCue,
  sanitizeCues,
  serializeSrt,
  shiftCues,
  splitCue,
  type SubtitleCue,
} from '../lib/video-studio/subtitle-logic'

const DOC = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello world',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '第二句',
  '',
].join('\n')

test('timecodes format and parse round-trip across separators', () => {
  assert.equal(formatTimecode(0), '00:00:00,000')
  assert.equal(formatTimecode(3661.5), '01:01:01,500')
  assert.equal(formatTimecode(-5), '00:00:00,000')
  assert.equal(parseTimecode('00:00:01,000'), 1)
  assert.equal(parseTimecode('01:01:01.5'), 3661.5)
  assert.equal(parseTimecode('00:00:01.50'), 1.5)
  assert.equal(parseTimecode('0:00:01,000'), 1)
  assert.equal(parseTimecode('nonsense'), null)
  assert.equal(parseTimecode('00:00:01:000'), null)
})

test('parseSrt tolerates BOM, dot millis, missing indexes and junk blocks', () => {
  const messy = '\ufeff' + [
    '1',
    '00:00:01.000 --> 00:00:03,500',
    ' spaced  text ',
    '',
    '00:00:04,000 --> 00:00:06,000',
    'no index line',
    '',
    '3',
    '00:00:07,000 --> 00:00:06,000',
    'inverted timing dropped',
    '',
    '4',
    'not a timing line',
    'dropped',
    '',
    '5',
    '00:00:07,000 --> 00:00:08,000',
    '   ',
    '',
  ].join('\n')
  const cues = parseSrt(messy)
  assert.deepEqual(
    cues.map(cue => ({ start: cue.start, end: cue.end, text: cue.text })),
    [
      { start: 1, end: 3.5, text: 'spaced text' },
      { start: 4, end: 6, text: 'no index line' },
    ]
  )
  assert.deepEqual(parseSrt(''), [])
  assert.deepEqual(parseSrt(DOC).map(cue => cue.text), ['Hello world', '第二句'])
})

test('serializeSrt renumbers, skips unusable cues and round-trips', () => {
  const cues: SubtitleCue[] = [
    { index: 7, start: 1, end: 3.5, text: '  Hello   world ' },
    { index: 2, start: 5, end: 4, text: 'inverted dropped' },
    { index: 3, start: 4, end: 6, text: '   ' },
    { index: 4, start: 4, end: 6, text: '第二句' },
  ]
  const document = serializeSrt(cues)
  assert.equal(
    document,
    ['1', '00:00:01,000 --> 00:00:03,500', 'Hello world', '', '2', '00:00:04,000 --> 00:00:06,000', '第二句', ''].join('\n')
  )
  assert.deepEqual(parseSrt(document), [
    { index: 1, start: 1, end: 3.5, text: 'Hello world' },
    { index: 2, start: 4, end: 6, text: '第二句' },
  ])
  assert.equal(serializeSrt([]), '')
  assert.deepEqual(renumberCues(cues).map(cue => cue.index), [1, 2, 3, 4])
})

test('cue validation flags empty text and inverted timings', () => {
  assert.equal(cueIssue({ start: 0, end: 1, text: 'ok' }), null)
  assert.equal(cueIssue({ start: 0, end: 1, text: '  ' }), 'text')
  assert.equal(cueIssue({ start: 2, end: 1, text: 'ok' }), 'timing')
  assert.equal(cueIssue({ start: -1, end: 1, text: 'ok' }), 'timing')
  assert.equal(cuesHaveIssues(draftCues()), true)
})

test('edits shift, nudge, add, remove and keep the table coherent', () => {
  const cues = parseSrt(DOC)
  assert.deepEqual(shiftCues(cues, 1).map(cue => cue.start), [2, 5])
  assert.deepEqual(shiftCues(cues, -5).map(cue => cue.start), [0, 0]) // clamped at zero

  const nudged = adjustCueBound(cues, 0, 'start', -2.5)
  assert.equal(nudged[0].start, 0) // clamped at zero, never below
  const crossed = adjustCueBound(cues, 0, 'start', 10)
  assert.equal(crossed[0].start, 3.499) // never crosses its own end
  const nudgedEnd = adjustCueBound(cues, 0, 'end', -10)
  assert.equal(nudgedEnd[0].end, 1.001)

  const grown = addCueAfter(cues, 0)
  assert.equal(grown.length, 3)
  assert.deepEqual(
    grown.map(cue => [cue.start, cue.end]),
    [
      [1, 3.5],
      [3.5, 4.5],
      [4, 6],
    ]
  )
  const appended = addCueAfter(cues, -1)
  assert.equal(appended[appended.length - 1].start, 6)

  const shrunk = removeCue(grown, 1)
  assert.equal(shrunk.length, 2)
  assert.deepEqual(shrunk.map(cue => cue.index), [1, 2])
  assert.deepEqual(removeCue(cues, 99).length, 2)
  assert.equal(cueDuration(cues[0]), 2.5)
})

test('splitCue breaks on sentence boundaries near the midpoint', () => {
  const cues = parseSrt(DOC)
  const [first, second] = splitCue(
    [{ index: 1, start: 0, end: 4, text: '第一句话。Second sentence here.' }],
    0
  )
  assert.equal(first.text, '第一句话。')
  assert.equal(second.text, 'Second sentence here.')
  assert.equal(first.end, second.start)
  assert.ok(first.end > 0 && first.end < 4)

  // Unbroken CJK still splits near the middle with proportional timing.
  const [hard1, hard2] = splitCue([{ index: 1, start: 0, end: 6, text: '一二三四五六七八九十' }], 0)
  assert.equal(hard1.text.length + hard2.text.length, 10)
  assert.ok(Math.abs(hard1.end - 3) < 0.01)

  // A single-character cue cannot be split → unchanged.
  assert.equal(splitCue([{ index: 1, start: 0, end: 1, text: '嗨' }], 0).length, 1)
})

test('sanitizeCues drops bad rows, sorts by start and renumbers', () => {
  const sanitized = sanitizeCues([
    { index: 1, start: 4, end: 6, text: 'later' },
    { index: 2, start: 5, end: 4, text: 'inverted' },
    { index: 3, start: 1, end: 2, text: '' },
    { index: 4, start: 1, end: 3, text: 'first' },
  ])
  assert.deepEqual(
    sanitized.map(cue => [cue.index, cue.start, cue.text]),
    [
      [1, 1, 'first'],
      [2, 4, 'later'],
    ]
  )
})

test('compose option sets match the backend contract', () => {
  assert.deepEqual([...SUBTITLE_STYLE_OPTIONS], ['clean', 'yellow_box', 'outline_large', 'high_contrast'])
  assert.deepEqual([...SUBTITLE_SOURCE_MODES], ['off', 'from_notes', 'from_asr', 'from_asset'])
})

test('§E2 font size clamps into the backend 12–72 window', () => {
  assert.equal(SUBTITLE_FONT_SIZE_MIN, 12)
  assert.equal(SUBTITLE_FONT_SIZE_MAX, 72)
  assert.equal(clampSubtitleFontSize(48), 48)
  assert.equal(clampSubtitleFontSize('48'), 48)
  assert.equal(clampSubtitleFontSize(' 24 '), 24)
  // Boundaries are inclusive; anything outside or unparsable is rejected.
  assert.equal(clampSubtitleFontSize(12), 12)
  assert.equal(clampSubtitleFontSize(72), 72)
  assert.equal(clampSubtitleFontSize(11), null)
  assert.equal(clampSubtitleFontSize(73), null)
  assert.equal(clampSubtitleFontSize('0'), null)
  assert.equal(clampSubtitleFontSize(''), null)
  assert.equal(clampSubtitleFontSize('abc'), null)
  assert.equal(clampSubtitleFontSize('12px'), null)
  assert.equal(clampSubtitleFontSize(Infinity), null)
  assert.equal(clampSubtitleFontSize(NaN), null)
  // Half-values round to the nearest whole number first.
  assert.equal(clampSubtitleFontSize(24.4), 24)
  assert.equal(clampSubtitleFontSize(24.6), 25)
  assert.equal(clampSubtitleFontSize(11.6), 12)
  assert.equal(clampSubtitleFontSize(71.5), 72)
})

test('§E2 colour pickers convert #RRGGBB ↔ ASS &HAABBGGRR', () => {
  assert.equal(hexToAssColour('#FFFFFF'), '&H00FFFFFF')
  assert.equal(hexToAssColour('#ffe97f'), '&H007FE9FF')
  assert.equal(hexToAssColour('#00FF00'), '&H0000FF00')
  // The colour input only emits 6-digit hex; anything else is unusable.
  assert.equal(hexToAssColour('fff'), null)
  assert.equal(hexToAssColour('#FFF'), null)
  assert.equal(hexToAssColour('#12345'), null)
  assert.equal(hexToAssColour('#GGGGGG'), null)
  assert.equal(hexToAssColour('&H00FFFFFF'), null)
  assert.equal(hexToAssColour(''), null)

  // 8-digit ASS values carry alpha first; 6-digit are bare BBGGRR.
  assert.equal(assColourToHex('&H00FFFFFF'), '#ffffff')
  assert.equal(assColourToHex('&H7FE9FF'), '#ffe97f')
  assert.equal(assColourToHex('&H0000FF00'), '#00ff00')
  // Hex digits may be lowercase, but the &H sigil is uppercase-only —
  // matching the backend `_ASS_COLOUR` fullmatch exactly.
  assert.equal(assColourToHex('&H7fe9ff'), '#ffe97f')
  assert.equal(assColourToHex('&h7fe9ff'), null)
  assert.equal(assColourToHex('&H00'), null)
  assert.equal(assColourToHex('&H00ZZZZZZ'), null)
  assert.equal(assColourToHex('#FFFFFF'), null)
  assert.equal(assColourToHex(''), null)

  // Picker values survive a full round-trip to the burner and back.
  for (const hex of ['#ffffff', '#ffe97f', '#1a2b3c', '#000000']) {
    assert.equal(assColourToHex(hexToAssColour(hex)!), hex)
  }
})
