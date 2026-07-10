function computeSliderImageMatchInPage(options = {}) {
  const { includeDataUrl = false } = options || {};
  const visible = e => !!e
    && getComputedStyle(e).display !== 'none'
    && getComputedStyle(e).visibility !== 'hidden'
    && e.getBoundingClientRect().width > 0
    && e.getBoundingClientRect().height > 0;

  const bg = document.querySelector('#slider_bg_image');
  const block = document.querySelector('#slider_block_image');
  if (!bg || !block || !visible(bg) || !visible(block) || !bg.complete || !block.complete) {
    return { ok: false, reason: 'images-not-ready' };
  }

  const bgRect = bg.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = bg.naturalWidth || Math.round(bgRect.width);
  bgCanvas.height = bg.naturalHeight || Math.round(bgRect.height);
  const blockCanvas = document.createElement('canvas');
  blockCanvas.width = block.naturalWidth || Math.round(blockRect.width);
  blockCanvas.height = block.naturalHeight || Math.round(blockRect.height);
  const bgCtx = bgCanvas.getContext('2d');
  const blockCtx = blockCanvas.getContext('2d');
  bgCtx.drawImage(bg, 0, 0, bgCanvas.width, bgCanvas.height);
  blockCtx.drawImage(block, 0, 0, blockCanvas.width, blockCanvas.height);
  const bgData = bgCtx.getImageData(0, 0, bgCanvas.width, bgCanvas.height).data;
  const blockData = blockCtx.getImageData(0, 0, blockCanvas.width, blockCanvas.height).data;
  const scaleY = bgCanvas.height / bgRect.height;
  const scaleX = bgCanvas.width / bgRect.width;
  const targetY = Math.max(0, Math.min(
    bgCanvas.height - blockCanvas.height,
    Math.round((blockRect.y - bgRect.y) * scaleY),
  ));
  const gray = data => {
    const out = new Uint16Array(data.length / 4);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
    }
    return out;
  };
  const bgGray = gray(bgData);
  const edge = (data, width, height) => {
    const out = new Uint16Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        out[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + width] - data[i - width]);
      }
    }
    return out;
  };
  const bgEdge = edge(bgGray, bgCanvas.width, bgCanvas.height);
  const alphaAt = (x, y) => blockData[(y * blockCanvas.width + x) * 4 + 3];
  const maxX = bgCanvas.width - blockCanvas.width;
  const inRange = x => x >= 40 && x <= maxX - 8;

  let sceneGreen = 0;
  let sceneSamples = 0;
  for (let i = 0; i < bgData.length; i += 16) {
    const r = bgData[i];
    const g = bgData[i + 1];
    const b = bgData[i + 2];
    sceneGreen += Math.max(0, g - r - 15) + Math.max(0, g - b - 5);
    sceneSamples += 1;
  }
  sceneGreen /= Math.max(1, sceneSamples);
  // The telecom cutout is a pale, low-chroma mask even on sunset / beach scenes.
  // A sceneGreen switch makes those challenges chase bright foliage / highlights
  // instead of the real hole, so keep cream-edge as the primary scorer.
  const preferMinGreen = true;

  const interiorPoints = [];
  const boundaryPoints = [];
  for (let by = 1; by < blockCanvas.height - 1; by += 1) {
    for (let bx = 1; bx < blockCanvas.width - 1; bx += 1) {
      if (alphaAt(bx, by) < 80) continue;
      const boundary = alphaAt(bx - 1, by) < 80
        || alphaAt(bx + 1, by) < 80
        || alphaAt(bx, by - 1) < 80
        || alphaAt(bx, by + 1) < 80;
      if (boundary) boundaryPoints.push({ x: bx, y: by });
      else if (bx % 3 === 0 && by % 3 === 0) interiorPoints.push({ x: bx, y: by });
    }
  }
  const samplePoints = interiorPoints.length > 20 ? interiorPoints : boundaryPoints;

  let holeX = 0;
  let holeScore = Number.NEGATIVE_INFINITY;
  let holeY = targetY;
  const yCandidates = new Set([targetY]);
  for (const dy of [-18, -12, -6, 0, 6, 12, 18, 24]) {
    yCandidates.add(Math.max(0, Math.min(bgCanvas.height - blockCanvas.height, targetY + dy)));
  }
  for (const y0 of yCandidates) {
    for (let x = 40; x <= maxX - 8; x += 1) {
      let cream = 0;
      let green = 0;
      let edgeEnergy = 0;
      let samples = 0;
      for (const p of samplePoints) {
        const gi = ((y0 + p.y) * bgCanvas.width + x + p.x) * 4;
        const r = bgData[gi];
        const g = bgData[gi + 1];
        const b = bgData[gi + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const chroma = Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b);
        cream += Math.max(0, lum - 160) * Math.max(0, 50 - chroma);
        green += Math.max(0, g - r - 15) + Math.max(0, g - b - 5);
        samples += 1;
      }
      if (samples === 0) continue;
      cream /= samples;
      green /= samples;
      if (boundaryPoints.length > 0) {
        edgeEnergy = boundaryPoints.reduce((sum, p) => sum + bgEdge[(y0 + p.y) * bgCanvas.width + x + p.x], 0) / boundaryPoints.length;
      }
      const score = preferMinGreen
        ? cream * 0.02 + edgeEnergy * 2 - green * 3
        : green * 8 + cream * 0.01 + edgeEnergy * 1.5;
      if (score > holeScore) {
        holeScore = score;
        holeX = x;
        holeY = y0;
      }
    }
  }
  const holeOk = inRange(holeX) && Number.isFinite(holeScore) && holeScore > (preferMinGreen ? 50 : 20);
  const holeMethod = preferMinGreen ? 'cream-edge' : 'green-cream-edge';

  let textureX = 0;
  let textureScore = Number.POSITIVE_INFINITY;
  let edgeX = 0;
  let edgeScore = Number.NEGATIVE_INFINITY;
  const edgePoints = boundaryPoints.length ? boundaryPoints : [];
  const innerPoints = interiorPoints.length ? interiorPoints : [];
  for (let x = 0; x <= maxX; x += 1) {
    let texture = 0;
    let textureSamples = 0;
    for (let by = 4; by < blockCanvas.height - 4; by += 2) {
      for (let bx = 4; bx < blockCanvas.width - 4; bx += 2) {
        const bi = (by * blockCanvas.width + bx) * 4;
        if (blockData[bi + 3] < 80) continue;
        const gi = ((holeY + by) * bgCanvas.width + x + bx) * 4;
        texture += Math.abs(blockData[bi] - bgData[gi])
          + Math.abs(blockData[bi + 1] - bgData[gi + 1])
          + Math.abs(blockData[bi + 2] - bgData[gi + 2]);
        textureSamples += 1;
      }
    }
    if (textureSamples > 0) texture /= textureSamples;
    if (texture < textureScore) {
      textureScore = texture;
      textureX = x;
    }
    if (edgePoints.length > 0) {
      const boundary = edgePoints.reduce((sum, p) => sum + bgEdge[(holeY + p.y) * bgCanvas.width + x + p.x], 0) / edgePoints.length;
      const inner = innerPoints.length > 0
        ? innerPoints.reduce((sum, p) => sum + bgEdge[(holeY + p.y) * bgCanvas.width + x + p.x], 0) / innerPoints.length
        : 0;
      const score = boundary - inner * 0.35;
      if (score > edgeScore) {
        edgeScore = score;
        edgeX = x;
      }
    }
  }
  const textureOk = inRange(textureX);
  const edgeOk = edgePoints.length >= 20 && inRange(edgeX);
  const edgeStrong = edgeOk && edgeScore >= 80;

  let bestX;
  let method;
  let score;
  if (edgeStrong) {
    bestX = edgeX;
    method = 'edge';
    score = edgeScore;
  } else if (holeOk) {
    bestX = holeX;
    method = holeMethod;
    score = holeScore;
  } else if (edgeOk) {
    bestX = edgeX;
    method = 'edge';
    score = edgeScore;
  } else if (textureOk) {
    bestX = textureX;
    method = 'texture';
    score = textureScore;
  } else {
    bestX = inRange(holeX) ? holeX : (inRange(edgeX) ? edgeX : (inRange(textureX) ? textureX : Math.round(maxX * 0.55)));
    method = 'fallback';
    score = holeScore;
  }

  const candidates = [];
  const pushCand = (x, label) => {
    const n = Math.round(x);
    if (!inRange(n)) return;
    if (candidates.some(c => Math.abs(c.naturalX - n) <= 1)) return;
    candidates.push({ naturalX: n, method: label });
  };
  pushCand(bestX, method);
  if (holeOk) pushCand(holeX, holeMethod);
  if (edgeOk) pushCand(edgeX, 'edge');
  if (textureOk) pushCand(textureX, 'texture');
  for (const delta of [-6, -3, 3, 6, -9, 9, -12, 12]) {
    pushCand(bestX + delta, `${method}${delta >= 0 ? '+' : ''}${delta}`);
  }

  const btn = document.querySelector('#slider_track_btn');
  const track = document.querySelector('#slider_track');
  const btnRect = btn?.getBoundingClientRect();
  const trackRect = track?.getBoundingClientRect();
  const displayScale = bgRect.width / bgCanvas.width;

  return {
    ok: true,
    x: Math.round(bestX / scaleX),
    y: Math.round(holeY / scaleY),
    naturalX: Math.round(bestX),
    moveX: Math.round(bestX / scaleX),
    method,
    score: Math.round(score),
    scaleX,
    scaleY,
    displayScale,
    targetY: holeY,
    candidates,
    hole: {
      naturalX: Math.round(holeX),
      score: Math.round(holeScore * 10) / 10,
      ok: holeOk,
      y: holeY,
      sceneGreen: Math.round(sceneGreen * 10) / 10,
      preferMinGreen,
    },
    texture: {
      naturalX: Math.round(textureX),
      score: Math.round(textureScore),
      ok: textureOk,
    },
    edge: edgePoints.length > 0 ? {
      naturalX: Math.round(edgeX),
      score: Math.round(edgeScore),
      points: edgePoints.length,
      ok: edgeOk,
    } : null,
    bg: {
      width: bgCanvas.width,
      height: bgCanvas.height,
      naturalW: bg.naturalWidth,
      naturalH: bg.naturalHeight,
      cssW: bgRect.width,
      cssH: bgRect.height,
    },
    block: {
      width: blockCanvas.width,
      height: blockCanvas.height,
      naturalW: block.naturalWidth,
      naturalH: block.naturalHeight,
      cssW: blockRect.width,
      cssH: blockRect.height,
      cssX: blockRect.x - bgRect.x,
      cssY: blockRect.y - bgRect.y,
    },
    btn: btnRect ? {
      x: btnRect.x,
      y: btnRect.y,
      w: btnRect.width,
      h: btnRect.height,
      cx: btnRect.x + btnRect.width / 2,
      cy: btnRect.y + btnRect.height / 2,
    } : null,
    track: trackRect ? {
      x: trackRect.x,
      y: trackRect.y,
      w: trackRect.width,
      h: trackRect.height,
    } : null,
    pageScaleHint: typeof window.scale === 'number' ? window.scale : null,
    hasSubmitHook: typeof window.__telecomSubmitSlider === 'function',
    bgDataUrl: includeDataUrl ? bgCanvas.toDataURL('image/png') : undefined,
    blockDataUrl: includeDataUrl ? blockCanvas.toDataURL('image/png') : undefined,
  };
}

async function evaluateSliderImageMatch(page, options = {}) {
  return page.evaluate(computeSliderImageMatchInPage, options);
}

module.exports = {
  computeSliderImageMatchInPage,
  evaluateSliderImageMatch,
};
