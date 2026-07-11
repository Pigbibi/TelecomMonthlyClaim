const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const { computeSliderImageMatchInPage } = require('../src/slider-local-match');
const samples = require('./fixtures/slider-challenge-samples');

async function launchChromeOrNull() {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    return null;
  }
}

test('matches known successful slider distances from captured challenges', async t => {
  const browser = await launchChromeOrNull();
  if (!browser) {
    t.skip('Chrome channel unavailable');
    return;
  }
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  for (const sample of samples) {
    await page.setContent(`<!doctype html><html><body>
      <div id="slider_image_panel" style="position:relative;width:280px;height:150px;">
        <img id="slider_bg_image" src="${sample.bgImage}" style="position:absolute;left:0;top:0;width:${sample.imageWidth}px;height:150px;display:block" />
        <img id="slider_block_image" src="${sample.sliderImage}" style="position:absolute;left:0;top:${sample.correctY}px;width:${sample.blockWidth}px;height:${sample.blockHeight}px;display:block" />
      </div>
      <div id="slider_track" style="position:relative;width:${sample.imageWidth}px;height:144px"></div>
      <div id="slider_track_btn" style="position:absolute;left:0;top:160px;width:${sample.blockWidth}px;height:144px"></div>
    </body></html>`, { waitUntil: 'load' });

    await page.waitForFunction(() => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      return bg?.complete && block?.complete;
    });

    const result = await page.evaluate(computeSliderImageMatchInPage);
    assert.equal(result.ok, true, `${sample.name}: expected image match`);
    assert.ok(
      Math.abs(result.naturalX - sample.expectedDistance) <= 2,
      `${sample.name}: expected ${sample.expectedDistance}, got ${result.naturalX} (${result.method})`,
    );
    assert.equal(result.method, 'flat-mask', `${sample.name}: expected flat mask detection`);
  }
});
