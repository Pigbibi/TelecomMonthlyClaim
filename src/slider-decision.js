// Picks between the local canvas match and the vision estimate for the same
// slider challenge. Local geometry is trusted when it is strong; vision only
// overrides weak or implausible local matches.
function chooseSliderDistanceCandidate({
  localNaturalX = null,
  localMethod = '',
  localMatchStrong = false,
  localHoleScore = 0,
  localEdgeScore = 0,
  localSceneGreen = null,
  vision = null,
  inRangeNatural = () => true,
  forceVision = false,
}) {
  const localInRange = Number.isFinite(localNaturalX) && inRangeNatural(localNaturalX);
  const visionInRange = !!(vision?.ok && Number.isFinite(vision?.naturalX) && inRangeNatural(vision.naturalX));
  const diffPx = localInRange && visionInRange ? Math.abs(localNaturalX - vision.naturalX) : null;
  const localSource = localMethod || 'local';
  const localStrength = /cream-edge/i.test(localMethod)
    ? Number(localHoleScore || 0)
    : Number(localEdgeScore || localHoleScore || 0);
  const localVeryStrong = /cream-edge/i.test(localMethod) && localStrength >= 220;

  if (forceVision && visionInRange) {
    return { naturalX: vision.naturalX, matchSource: 'vision', reason: 'forced-vision', diffPx };
  }
  if (!localInRange && visionInRange) {
    return { naturalX: vision.naturalX, matchSource: 'vision', reason: 'local-out-of-range', diffPx };
  }
  if (!visionInRange) {
    return { naturalX: localNaturalX, matchSource: localSource, reason: 'vision-unavailable', diffPx };
  }
  if (!localInRange) {
    return { naturalX: localNaturalX, matchSource: localSource, reason: 'no-usable-candidate', diffPx };
  }
  if (!localMatchStrong) {
    if (diffPx != null && diffPx <= 6) {
      return {
        naturalX: Math.round((localNaturalX + vision.naturalX) / 2),
        matchSource: `${localSource}+vision`,
        reason: 'weak-local-close-to-vision',
        diffPx,
      };
    }
    return { naturalX: vision.naturalX, matchSource: 'vision', reason: 'weak-local-overridden', diffPx };
  }
  if (diffPx != null && diffPx <= 6) {
    return {
      naturalX: Math.round((localNaturalX + vision.naturalX) / 2),
      matchSource: `${localSource}+vision`,
      reason: 'strong-local-confirmed-by-vision',
      diffPx,
    };
  }
  if (localVeryStrong) {
    return { naturalX: localNaturalX, matchSource: localSource, reason: 'very-strong-local-kept', diffPx };
  }
  if (localSceneGreen != null && localSceneGreen < 18) {
    return { naturalX: vision.naturalX, matchSource: 'vision', reason: 'low-green-scene-prefers-vision', diffPx };
  }
  return { naturalX: localNaturalX, matchSource: localSource, reason: 'strong-local-kept', diffPx };
}

module.exports = { chooseSliderDistanceCandidate };
