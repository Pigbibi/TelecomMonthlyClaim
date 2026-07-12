const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findFlatCanvasTarget,
  renderedPuzzleMoveX,
  isFlatPuzzleCandidateReliable,
} = require('../src/slider-canvas-match');

test('finds the uniform gray puzzle target in a noisy canvas', () => {
  const width = 320;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 20 + (x * 3 + y) % 180;
      data[i + 1] = 60 + (x + y * 5) % 160;
      data[i + 2] = 90 + (x * 7 + y * 2) % 150;
      data[i + 3] = 255;
    }
  }
  for (let y = 30; y < 90; y += 1) {
    for (let x = 190; x < 245; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 112;
      data[i + 1] = 112;
      data[i + 2] = 112;
    }
  }
  const result = findFlatCanvasTarget(data, width, height);
  assert.equal(result.ok, true);
  assert.equal(result.x, 190);
  assert.equal(result.width, 55);
  assert.equal(isFlatPuzzleCandidateReliable(result), true);
});

test('prefers a puzzle-shaped component over a larger flat stripe', () => {
  const width = 320;
  const height = 140;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const fill = (left, top, right, bottom, value) => {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      }
    }
  };
  fill(70, 20, 190, 50, 120);
  fill(220, 50, 275, 110, 96);
  const result = findFlatCanvasTarget(data, width, height);
  assert.equal(result.x, 220);
  assert.equal(isFlatPuzzleCandidateReliable(result), true);
});

test('converts a rendered target into slider-track movement', () => {
  assert.equal(renderedPuzzleMoveX(210, 382, 1, 105, 840), 499);
});
