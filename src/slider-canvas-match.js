function findFlatCanvasTarget(data, width, height) {
  const colors = new Map();
  const startX = Math.max(40, Math.round(width * 0.04));
  for (let y = 0; y < height; y += 1) {
    for (let x = startX; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      if (data[index + 3] < 240 || Math.max(r, g, b) - Math.min(r, g, b) > 6) continue;
      const luminance = (r + g + b) / 3;
      if (luminance < 45 || luminance > 210) continue;
      const key = (r << 16) | (g << 8) | b;
      colors.set(key, (colors.get(key) || 0) + 1);
    }
  }
  const candidates = [...colors.entries()]
    .filter(([, count]) => count >= 100)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);
  let best = null;
  for (const [key] of candidates) {
    const seen = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = startX; x < width; x += 1) {
        const pixel = y * width + x;
        const index = pixel * 4;
        const pixelKey = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
        if (seen[pixel] || pixelKey !== key) continue;
        const queue = [pixel];
        seen[pixel] = 1;
        let cursor = 0;
        let count = 0;
        let minX = width;
        let maxX = 0;
        let minY = height;
        let maxY = 0;
        while (cursor < queue.length) {
          const current = queue[cursor++];
          const px = current % width;
          const py = Math.floor(current / width);
          count += 1;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
          for (const next of [current - 1, current + 1, current - width, current + width]) {
            if (next < 0 || next >= width * height || seen[next]) continue;
            const nx = next % width;
            if (Math.abs(nx - px) > 1) continue;
            const i = next * 4;
            const nextKey = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            if (nextKey !== key) continue;
            seen[next] = 1;
            queue.push(next);
          }
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        if (count < 100 || componentWidth < 15 || componentHeight < 15 || componentWidth > width * 0.25) continue;
        const aspect = componentWidth / componentHeight;
        const fill = count / (componentWidth * componentHeight);
        const shapeScore = count * Math.pow(Math.min(aspect, 1 / aspect), 2);
        if (!best || shapeScore > best.score) {
          best = { ok: true, x: minX, count, width: componentWidth, height: componentHeight, aspect, fill, score: shapeScore };
        }
      }
    }
  }
  return best || { ok: false, reason: 'flat-component-not-found' };
}

function renderedPuzzleMoveX(sourceX, flatX, screenshotScaleX, sliderX, canvasWidth = 0) {
  const scale = Number(screenshotScaleX);
  const width = Number(canvasWidth);
  if (![sourceX, flatX, scale, sliderX, width].every(Number.isFinite) || scale <= 0) return null;
  const targetDistance = Number(sourceX) + Number(flatX) / scale - Number(sliderX);
  const sliderRatio = width > 60 ? (width - 40) / (width - 60) : 1;
  return Math.round(targetDistance * sliderRatio);
}

function isFlatPuzzleCandidateReliable(candidate) {
  return !!candidate?.ok
    && Number(candidate.aspect) >= 0.7
    && Number(candidate.aspect) <= 1.4
    && Number(candidate.fill) >= 0.35;
}

module.exports = { findFlatCanvasTarget, renderedPuzzleMoveX, isFlatPuzzleCandidateReliable };
