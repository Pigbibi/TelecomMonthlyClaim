const test = require('node:test');
const assert = require('node:assert/strict');
const { findFlatCanvasTarget, renderedPuzzleMoveX } = require('../src/slider-canvas-match');

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
});

test('converts a rendered target into slider-track movement', () => {
  assert.equal(renderedPuzzleMoveX(210, 382, 1, 105), 487);
});
