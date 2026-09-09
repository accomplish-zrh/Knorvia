import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSequenceShot, MAX_SEQUENCE_SHOTS, moveSequenceShot, readSequenceDraft, renderSequenceTemplate, sequenceShotInput } from '../lib/studio-sequence-draft';
import type { StudioTemplate } from '../lib/native-studio';

test('200-shot draft retains identities across serialization and page-boundary reorder', () => {
  const shots = Array.from({ length: MAX_SEQUENCE_SHOTS }, (_, index) => ({ ...makeSequenceShot('local-model', 4, index), prompt: `Shot ${index}` }));
  const before = shots[20].id;
  const next = moveSequenceShot(shots, before, -1);
  assert.equal(next[19].id, before);
  assert.equal(new Set(next.map(shot => shot.id)).size, MAX_SEQUENCE_SHOTS);
  const restored = readSequenceDraft(JSON.parse(JSON.stringify({ title: 'Long queue', globalPrompt: 'Shared context', profileId: 'local-model', seconds: 4, shots: next })));
  assert.deepEqual(restored?.shots.map(sequenceShotInput), next.map(sequenceShotInput));
});

test('submitted boundaries cannot move and a new first shot cannot depend on itself', () => {
  const shots = [makeSequenceShot(), makeSequenceShot('', 4, 1), makeSequenceShot('', 4, 2)];
  const moved = moveSequenceShot(shots, shots[1].id, -1);
  assert.equal(moved[0].continuity, 'none');
  shots[0].locked = true;
  assert.equal(moveSequenceShot(shots, shots[1].id, -1), shots);
  assert.equal(moveSequenceShot(shots, shots[0].id, 1), shots);
});

test('template variables substitute once and pinned snapshots survive source deletion', () => {
  const template: StudioTemplate = { id: 'template', revision: 2, name: 'Fixture', kind: 'video', createdAt: '2026-09-08', updatedAt: '2026-09-08', prompt: '{{ person }} in {{place}}', defaults: { place: 'the garden' }, variables: ['person', 'place'] };
  const shot = { ...makeSequenceShot(), templateId: 'template', templateRevision: 2, templateParams: { person: '{{place}}' } };
  assert.deepEqual(renderSequenceTemplate(shot, template), { text: '{{place}} in the garden', missing: [] });
  assert.equal(renderSequenceTemplate({ ...shot, templateSnapshot: 'Pinned earlier content' }).text, 'Pinned earlier content');
  assert.deepEqual(renderSequenceTemplate({ ...shot, templateRevision: 1 }, template).missing, ['template-version']);
  const missing = renderSequenceTemplate({ ...shot, templateParams: {} }, template); assert.deepEqual(missing.missing, ['person']);
});

test('draft validation rejects duplicate IDs and invalid durations without inventing defaults', () => {
  const shot = makeSequenceShot();
  const draft = { title: '', globalPrompt: '', profileId: '', seconds: 4, shots: [shot, { ...shot }] };
  assert.equal(readSequenceDraft(draft), undefined);
  assert.equal(readSequenceDraft({ ...draft, shots: [{ ...shot, seconds: 0 }] }), undefined);
  assert.equal(readSequenceDraft({ ...draft, shots: [shot] })?.shots[0].id, shot.id);
});
