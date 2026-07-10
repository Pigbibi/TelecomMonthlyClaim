#!/usr/bin/env node
/**
 * Distance audit: open challenge once, run real imageMatch, optionally submit via
 * native __telecomSubmitSlider (no mouse) to isolate distance vs mouse fingerprint.
 *
 * TELECOM_AUDIT_SUBMIT=0  — match only, do not call validSlider (default safer)
 * TELECOM_AUDIT_SUBMIT=1  — submit best naturalX via page hook
 * TELECOM_AUDIT_TRY_HUMAN=116 — also try this natural distance (from manual success)
 *
 * Usage:
 *   TELECOM_USE_DEFAULT_CHROME=1 bash scripts/start-chrome-cdp.sh
 *   export BROWSER_CDP_URL=http://127.0.0.1:9222
 *   node scripts/audit-slider-distance.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { evaluateSliderImageMatch } = require('../src/slider-local-match');

const phone = process.env.TELECOM_PHONE;
const entryUrl = process.env.TELECOM_ENTRY_URL;
const cdp = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
const doSubmit = process.env.TELECOM_AUDIT_SUBMIT === '1';
const tryHuman = process.env.TELECOM_AUDIT_TRY_HUMAN
  ? Number(process.env.TELECOM_AUDIT_TRY_HUMAN)
  : null;
const outDir = path.join('artifacts', 'distance-audit');

if (!phone || !entryUrl) {
  console.error('Need TELECOM_PHONE and TELECOM_ENTRY_URL');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Shared matcher from src/slider-local-match.js. */
async function runImageMatch(page) {
  return evaluateSliderImageMatch(page, { includeDataUrl: true });
}

async function attachSliderSubmitHook(page) {
  await page.route(/\/apps\/serviceapps\/slider_check\/js\/index\.js/i, async route => {
    try {
      const response = await route.fetch();
      let body = await response.text();
      if (!body.includes('window.__telecomSubmitSlider') && body.includes('function submitVerify')) {
        body = body.replace(
          /window\.sliderVerify\s*=\s*sliderVerify\s*;/,
          [
            'window.sliderVerify = sliderVerify;',
            'window.__telecomSubmitSlider = function (naturalDistance) {',
            '  if (!challenge) return { ok: false, reason: "no-challenge" };',
            '  var dist = Math.round(Number(naturalDistance) || 0);',
            '  if (!(dist > 0)) return { ok: false, reason: "bad-distance" };',
            '  sliderLeft = Math.max(0, Math.min(maxSliderMove, dist * scale));',
            '  updateSliderUI();',
            '  submitVerify();',
            '  return { ok: true, sliderLeft: sliderLeft, scale: scale, natural: dist };',
            '};',
            'window.__telecomSliderDebug = function () {',
            '  return {',
            '    hasChallenge: !!challenge,',
            '    scale: typeof scale === "number" ? scale : null,',
            '    sliderLeft: typeof sliderLeft === "number" ? sliderLeft : null,',
            '    maxSliderMove: typeof maxSliderMove === "number" ? maxSliderMove : null,',
            '    token: challenge && challenge.token ? String(challenge.token) : null,',
            '  };',
            '};',
          ].join('\n'),
        );
        console.log('Patched slider_check.js with submit + debug hooks');
      }
      await route.fulfill({
        status: response.status(),
        headers: {
          ...response.headers(),
          'content-type': response.headers()['content-type'] || 'application/javascript; charset=utf-8',
        },
        body,
      });
    } catch (err) {
      console.log('patch failed', err.message);
      await route.continue().catch(() => {});
    }
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  if (!context) throw new Error('no CDP context');
  const page = await context.newPage();
  await attachSliderSubmitHook(page);

  const network = [];
  page.on('request', req => {
    const url = req.url();
    if (!/getSliderChallenge|validSlider|sendRandByUnlog/i.test(url)) return;
    network.push({
      at: new Date().toISOString(),
      phase: 'request',
      method: req.method(),
      url,
      postData: req.postData() || null,
      postDataJSON: safeJson(req.postData() || ''),
    });
    console.log('REQ', req.method(), url.split('?')[0].replace(/^https:\/\/wapbj\.189\.cn/, ''), 'body=', (req.postData() || '').slice(0, 120));
  });
  page.on('response', async res => {
    const url = res.url();
    if (!/getSliderChallenge|validSlider|sendRandByUnlog/i.test(url)) return;
    const body = await res.text().catch(() => '');
    network.push({
      at: new Date().toISOString(),
      phase: 'response',
      status: res.status(),
      url,
      body: body.slice(0, 500),
      bodyJSON: safeJson(body),
    });
    console.log('RES', res.status(), url.split('?')[0].replace(/^https:\/\/wapbj\.189\.cn/, ''), body.slice(0, 160));
  });

  console.log('Goto entry…');
  const resp = await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('entry status', resp?.status());
  await sleep(resp?.status() === 412 ? 12000 : 4000);

  const phoneEl = page.locator('#phoneNumber, input.phonenum').first();
  await phoneEl.waitFor({ state: 'visible', timeout: 20000 });
  await phoneEl.click().catch(() => {});
  await phoneEl.fill(phone);
  await sleep(600);

  // Same selector as capture-manual-drag-forensics.js (works on this page)
  const sendBtn = page.locator('.checknum-button.slider-sms-btn, .checknum-button, .content_send_unlog').first();
  await sendBtn.click({ force: true });
  console.log('clicked send; waiting puzzle…');

  let match = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const msg = document.querySelector('#slider_check_msg, #secondPop_msg')?.innerText || '';
      const visible = e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
      return {
        ready: !!(bg && block && bg.complete && block.complete && visible(bg) && visible(block)),
        busy: /服务繁忙|请稍后再试/.test(msg),
        msg,
      };
    });
    if (state.busy) {
      console.log('BUSY before puzzle', state.msg);
      break;
    }
    if (state.ready) {
      match = await runImageMatch(page);
      break;
    }
    await sleep(400);
  }

  if (!match?.ok) {
    const out = {
      at: new Date().toISOString(),
      success: false,
      reason: match?.reason || 'puzzle-not-ready',
      network,
    };
    const file = path.join(outDir, `${Date.now()}-no-puzzle.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(out, null, 2));
    console.log('No puzzle / busy. Saved', file);
    process.exit(2);
  }

  // Persist images separately
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (match.bgDataUrl) {
    fs.writeFileSync(path.join(outDir, `${stamp}-bg.png`), Buffer.from(match.bgDataUrl.split(',')[1], 'base64'));
  }
  if (match.blockDataUrl) {
    fs.writeFileSync(path.join(outDir, `${stamp}-block.png`), Buffer.from(match.blockDataUrl.split(',')[1], 'base64'));
  }

  const debug = await page.evaluate(() => (typeof window.__telecomSliderDebug === 'function' ? window.__telecomSliderDebug() : null));
  console.log('\n=== IMAGE MATCH ===');
  console.log(JSON.stringify({
    method: match.method,
    score: match.score,
    naturalX: match.naturalX,
    moveX: match.moveX,
    scaleX: match.scaleX,
    displayScale: match.displayScale,
    hole: match.hole,
    texture: match.texture,
    edge: match.edge,
    candidates: match.candidates,
    bg: match.bg,
    block: match.block,
    debug,
  }, null, 2));

  const submitResults = [];
  const distancesToTry = [];
  if (doSubmit) {
    distancesToTry.push({ label: 'best', naturalX: match.naturalX });
    if (tryHuman != null && Number.isFinite(tryHuman) && Math.abs(tryHuman - match.naturalX) > 1) {
      distancesToTry.push({ label: 'human-ref', naturalX: tryHuman });
    }
    // Also try top alternate methods if different
    for (const c of match.candidates.slice(0, 4)) {
      if (distancesToTry.some(d => Math.abs(d.naturalX - c.naturalX) <= 1)) continue;
      if (['cream-edge', 'green-cream-edge', 'texture', 'edge'].includes(c.method)) {
        distancesToTry.push({ label: c.method, naturalX: c.naturalX });
      }
    }
  } else {
    console.log('\nTELECOM_AUDIT_SUBMIT!=1 → match-only (no validSlider). Set TELECOM_AUDIT_SUBMIT=1 to submit.');
  }

  for (const trial of distancesToTry) {
    console.log(`\n--- submit naturalX=${trial.naturalX} (${trial.label}) ---`);
    const before = network.length;
    const hook = await page.evaluate(async (dist) => {
      if (typeof window.__telecomSubmitSlider !== 'function') return { ok: false, reason: 'no-hook' };
      return window.__telecomSubmitSlider(dist);
    }, trial.naturalX);
    console.log('hook', hook);
    await sleep(2500);
    const after = network.slice(before).filter(e => /validSlider|sendRandByUnlog/i.test(e.url));
    const validRes = after.find(e => e.phase === 'response' && /validSlider/i.test(e.url));
    const smsRes = after.find(e => e.phase === 'response' && /sendRandByUnlog/i.test(e.url));
    const row = {
      trial,
      hook,
      validStatus: validRes?.status,
      validBody: validRes?.body,
      validJSON: validRes?.bodyJSON,
      smsStatus: smsRes?.status,
      smsBody: smsRes?.body,
    };
    submitResults.push(row);
    console.log('result', JSON.stringify({
      valid: validRes?.bodyJSON || validRes?.body,
      sms: smsRes?.bodyJSON || smsRes?.body,
    }, null, 2));
    if (validRes?.bodyJSON?.retCode === '000000' || /验证成功/.test(validRes?.body || '')) {
      console.log('SUCCESS with naturalX', trial.naturalX);
      break;
    }
    // refresh challenge for next distance try
    if (trial !== distancesToTry[distancesToTry.length - 1]) {
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
      match = await runImageMatch(page);
      if (match?.ok) {
        console.log('refreshed match naturalX', match.naturalX, match.method);
        // update best for remaining? keep original trial list
      }
    }
  }

  const out = {
    at: new Date().toISOString(),
    doSubmit,
    tryHuman,
    match: {
      ...match,
      bgDataUrl: undefined,
      blockDataUrl: undefined,
    },
    debug,
    submitResults,
    network: network.map(e => ({
      ...e,
      body: e.body && e.body.length > 800 ? `${e.body.slice(0, 800)}…` : e.body,
    })),
    note: 'Manual success used sliderDistance=116 on a different challenge; compare method/candidates here.',
  };
  const file = path.join(outDir, `${stamp}-audit.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(out, null, 2));
  console.log('\nSaved', file);
  console.log('Images:', path.join(outDir, `${stamp}-bg.png`), path.join(outDir, `${stamp}-block.png`));
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
