const test = require('node:test');
const assert = require('node:assert/strict');

const { chooseSliderDistanceCandidate } = require('../scripts/telecom-monthly-claim');

const inRangeNatural = d => d != null && d >= 45 && d <= 240;

test('prefers vision when local candidate is weak', () => {
  const result = chooseSliderDistanceCandidate({
    localNaturalX: 86,
    localMethod: 'edge',
    localMatchStrong: false,
    localHoleScore: 0,
    localEdgeScore: 52,
    localSceneGreen: 14,
    vision: { ok: true, naturalX: 134 },
    inRangeNatural,
  });

  assert.equal(result.naturalX, 134);
  assert.equal(result.matchSource, 'vision');
  assert.equal(result.reason, 'weak-local-overridden');
});

test('blends close strong local and vision candidates on same challenge', () => {
  const result = chooseSliderDistanceCandidate({
    localNaturalX: 153,
    localMethod: 'cream-edge',
    localMatchStrong: true,
    localHoleScore: 210,
    localSceneGreen: 26,
    vision: { ok: true, naturalX: 156 },
    inRangeNatural,
  });

  assert.equal(result.naturalX, 155);
  assert.equal(result.matchSource, 'cream-edge+vision');
  assert.equal(result.reason, 'strong-local-confirmed-by-vision');
});

test('keeps very strong local candidate when vision disagrees sharply', () => {
  const result = chooseSliderDistanceCandidate({
    localNaturalX: 195,
    localMethod: 'cream-edge',
    localMatchStrong: true,
    localHoleScore: 453,
    localSceneGreen: 36,
    vision: { ok: true, naturalX: 176 },
    inRangeNatural,
  });

  assert.equal(result.naturalX, 195);
  assert.equal(result.matchSource, 'cream-edge');
  assert.equal(result.reason, 'very-strong-local-kept');
});

test('uses vision when local candidate is out of range', () => {
  const result = chooseSliderDistanceCandidate({
    localNaturalX: 33,
    localMethod: 'track',
    localMatchStrong: false,
    vision: { ok: true, naturalX: 117 },
    inRangeNatural,
  });

  assert.equal(result.naturalX, 117);
  assert.equal(result.matchSource, 'vision');
  assert.equal(result.reason, 'local-out-of-range');
});
