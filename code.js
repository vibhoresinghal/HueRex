// Helpers: RGB ↔ HSL
function rgbToHsl(r, g, b) {
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h, s: s, l: l };
}

function hslToRgb(h, s, l) {
  if (s === 0) return { r: l, g: l, b: l };
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
    return p;
  }
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1 / 3)
  };
}

function clonePaints(arr) {
  return Array.isArray(arr) ? JSON.parse(JSON.stringify(arr)) : [];
}

// Helper: Ensure fonts are loaded for a text node
async function ensureNodeFontsLoaded(node) {
  if (node.type !== 'TEXT') return;
  if (node.characters.length === 0) return;
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
  } else {
    const segs = node.getStyledTextSegments(['fontName']);
    const fonts = new Set(segs.map(s => JSON.stringify(s.fontName)));
    await Promise.all(Array.from(fonts).map(f => figma.loadFontAsync(JSON.parse(f))));
  }
}

var originalPaints = {}, groupMap = [], currentColors = {}, currentPaintsData = {};

function getRefKey(ref) {
  if (ref.type === 'mixedTextFills')
    return `${ref.nodeId}-${ref.type}-${ref.segmentIndex}-${ref.index}-${ref.stopIndex}`;
  if (ref.type === 'vectorRegions')
    return `${ref.nodeId}-${ref.type}-${ref.regionIndex}-${ref.index}-${ref.stopIndex}`;
  return `${ref.nodeId}-${ref.type}-${ref.index}-${ref.stopIndex}`;
}

function recordOriginals(node) {
  if (node.visible === false) return;
  if (node.isMask) return;

  const isMixedFills = node.type === 'TEXT' && node.fills === figma.mixed;

  // Check for vector network regions (paint bucket fills on vector shapes)
  let hasVectorRegions = false;
  let vectorRegions = [];
  if (node.type === 'VECTOR' && node.vectorNetwork && node.vectorNetwork.regions) {
    vectorRegions = node.vectorNetwork.regions.filter(r => r.fills && r.fills.length > 0);
    hasVectorRegions = vectorRegions.length > 0;
  }

  // record this node's fills, strokes, effects, and vector regions if present
  if (
    isMixedFills ||
    (node.fills !== undefined && node.fills !== figma.mixed) ||
    (node.strokes !== undefined && node.strokes !== figma.mixed) ||
    (node.effects && node.effects.length) ||
    hasVectorRegions
  ) {
    const entry = {};
    if (isMixedFills) {
      entry.isMixedFills = true;
      entry.segments = JSON.parse(JSON.stringify(node.getStyledTextSegments(['fills'])));
    } else if (node.fills !== undefined) {
      entry.fills = clonePaints(node.fills);
    }
    if (node.strokes !== undefined && node.strokes !== figma.mixed) {
      entry.strokes = clonePaints(node.strokes);
    }
    if (node.effects && node.effects.length) {
      entry.effects = clonePaints(node.effects);
    }
    if (hasVectorRegions) {
      entry.vectorRegions = vectorRegions.map(r => ({
        fills: clonePaints(r.fills),
        windingRule: r.windingRule,
        loops: r.loops
      }));
      entry.vectorNetwork = JSON.parse(JSON.stringify(node.vectorNetwork));
    }
    originalPaints[node.id] = entry;
  }

  // recurse into children (including those inside masks)
  // If it's a boolean operation, we've already recorded its paint,
  // so we don't want to process its children's individual paints.
  if (node.type === 'BOOLEAN_OPERATION') {
    return;
  } else if (node.children) {
    node.children.forEach(recordOriginals);
  }
}

// Build hue clusters (±15°), dedupe, skip hidden
function buildGroups() {
  var unique = []; groupMap = [];
  function cluster(hsl, ref) {
    var tolH = 15 / 360;
    for (var gi = 0; gi < unique.length; gi++) {
      var u = unique[gi];
      if (!u.all && Math.abs(u.h / 360 - hsl.h) < tolH) {
        u.h = (u.h + hsl.h * 360) / 2;
        u.s = (u.s + hsl.s) / 2;
        u.l = (u.l + hsl.l) / 2;
        groupMap[gi].push(ref);
        return;
      }
    }
    unique.push({ h: hsl.h * 360, s: hsl.s, l: hsl.l });
    groupMap.push([ref]);
  }

  Object.keys(originalPaints).forEach(nodeId => {
    var orig = originalPaints[nodeId];
    function processPaints(paints, type, segmentIndex = null) {
      (paints || []).forEach((p, pi) => {
        if (p.visible === false) return;
        const ref = { nodeId, type, index: pi, stopIndex: null };
        if (segmentIndex !== null) ref.segmentIndex = segmentIndex;

        if (p.type === 'SOLID') {
          cluster(rgbToHsl(p.color.r, p.color.g, p.color.b), ref);
        } else if (p.type.indexOf('GRADIENT') === 0) {
          p.gradientStops.forEach((stop, si) => {
            if (stop.visible === false) return;
            const sRef = Object.assign({}, ref, { stopIndex: si });
            cluster(rgbToHsl(stop.color.r, stop.color.g, stop.color.b), sRef);
          });
        }
      });
    }

    if (orig.isMixedFills) {
      orig.segments.forEach((seg, si) => {
        processPaints(seg.fills, 'mixedTextFills', si);
      });
    } else {
      processPaints(orig.fills, 'fills');
    }
    processPaints(orig.strokes, 'strokes');

    (orig.effects || []).forEach((eff, ei) => {
      if ((eff.type === 'DROP_SHADOW' || eff.type === 'INNER_SHADOW') &&
        eff.visible !== false) {
        cluster(rgbToHsl(eff.color.r, eff.color.g, eff.color.b),
          { nodeId, type: 'effects', index: ei, stopIndex: null });
      }
    });

    // Process vector region fills (paint bucket fills)
    (orig.vectorRegions || []).forEach((region, ri) => {
      (region.fills || []).forEach((p, pi) => {
        if (p.visible === false) return;
        const ref = { nodeId, type: 'vectorRegions', regionIndex: ri, index: pi, stopIndex: null };

        if (p.type === 'SOLID') {
          cluster(rgbToHsl(p.color.r, p.color.g, p.color.b), ref);
        } else if (p.type.indexOf('GRADIENT') === 0) {
          p.gradientStops.forEach((stop, si) => {
            if (stop.visible === false) return;
            const sRef = Object.assign({}, ref, { stopIndex: si });
            cluster(rgbToHsl(stop.color.r, stop.color.g, stop.color.b), sRef);
          });
        }
      });
    });
  });

  if (unique.length > 1) {
    unique.unshift({ all: true });
    groupMap.unshift([].concat(...groupMap));
  }
  return unique;
}

function extractColorFromOrigPaint(orig, ref) {
  let paint;
  if (ref.type === 'mixedTextFills') {
    if (orig.segments && orig.segments[ref.segmentIndex])
      paint = orig.segments[ref.segmentIndex].fills[ref.index];
  } else if (ref.type === 'vectorRegions') {
    if (orig.vectorRegions && orig.vectorRegions[ref.regionIndex])
      paint = orig.vectorRegions[ref.regionIndex].fills[ref.index];
  } else if (ref.type === 'effects') {
    paint = orig.effects && orig.effects[ref.index];
  } else {
    paint = orig[ref.type] && orig[ref.type][ref.index];
  }
  if (!paint) return null;
  let c;
  if (ref.type === 'effects') {
    c = paint.color;
  } else if (paint.type === 'SOLID') {
    c = paint.color;
  } else if (paint.gradientStops && paint.gradientStops[ref.stopIndex]) {
    c = paint.gradientStops[ref.stopIndex].color;
  }
  return c ? { r: c.r, g: c.g, b: c.b } : null;
}

function initCurrentColors() {
  currentColors = {};
  for (const refs of groupMap) {
    for (const ref of refs) {
      const key = getRefKey(ref);
      if (currentColors[key]) continue;
      const orig = originalPaints[ref.nodeId];
      if (!orig) continue;
      const c = extractColorFromOrigPaint(orig, ref);
      if (c) currentColors[key] = c;
    }
  }
}

function initCurrentPaintsData() {
  currentPaintsData = {};
  for (const nodeId in originalPaints) {
    currentPaintsData[nodeId] = JSON.parse(JSON.stringify(originalPaints[nodeId]));
  }
}

function computeCurrentSubsets() {
  return groupMap.map(refs => {
    var arr = [];
    for (const ref of refs) {
      const c = currentColors[getRefKey(ref)];
      if (!c) continue;
      const hsl = rgbToHsl(c.r, c.g, c.b);
      arr.push({ h: hsl.h * 360, s: hsl.s, l: hsl.l });
    }
    var seen = {};
    return arr.filter(c => {
      var key = `${c.h.toFixed(1)}_${c.s.toFixed(3)}_${c.l.toFixed(3)}`;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  });
}

// At top of code.js, add:
let highlightRects = [];

function clearHighlights() {
  for (const r of highlightRects) r.remove();
  highlightRects = [];
}

function highlightNodes(nodes) {
  clearHighlights();
  for (const node of nodes) {
    const bbox = node.absoluteBoundingBox;
    if (!bbox) continue;
    const rect = figma.createRectangle();
    rect.x = bbox.x;
    rect.y = bbox.y;
    rect.resize(bbox.width, bbox.height);
    rect.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.12 }];
    rect.strokes = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.32 }];
    rect.strokeWeight = 1;
    /*rect.strokeCap = 'ROUND';*/
    rect.dashPattern = [0];
    figma.currentPage.appendChild(rect);
    highlightRects.push(rect);
  }
}

async function handleSelectionChange(selectedGroupIndex) {
  var sel = figma.currentPage.selection;
  originalPaints = {}; groupMap = []; currentColors = {}; currentPaintsData = {};
  if (!sel.length) {
    figma.ui.postMessage({ type: 'selection-colors', colors: [], subsets: [] });
    return;
  }
  sel.forEach(recordOriginals);
  var colors = buildGroups();
  initCurrentColors();
  initCurrentPaintsData();
  var subsets = computeCurrentSubsets();
  var zipped = colors.map((c, i) => ({ color: c, subset: subsets[i], refs: groupMap[i] }));
  zipped.sort((a, b) => b.color.l - a.color.l);
  colors = zipped.map(z => z.color);
  subsets = zipped.map(z => z.subset);
  groupMap = zipped.map(z => z.refs);

  figma.ui.postMessage({ type: 'selection-colors', colors, subsets, selectedGroupIndex });
}

figma.showUI(__html__, { width: 320, height: 260 });
figma.on('selectionchange', handleSelectionChange);
// Initial call (no await needed)
handleSelectionChange();

async function applyRef(ref, comp, v, delta, initialValues) {
  const paintData = currentPaintsData[ref.nodeId];
  if (!paintData) return;

  let hsl, rgb;
  const refKey = getRefKey(ref);
  const initialHSL = initialValues ? initialValues[refKey] : null;

  function computeHSL(color) {
    if (initialHSL && (comp === 's' || comp === 'l')) {
      hsl = { h: initialHSL.h, s: initialHSL.s, l: initialHSL.l };
      hsl[comp] = Math.max(0, Math.min(1, initialHSL[comp] + (delta || 0)));
    } else {
      hsl = rgbToHsl(color.r, color.g, color.b);
      hsl[comp] = v;
    }
    if (comp === 'h' && hsl.s === 0) {
      hsl.s = 0.5;
      figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
    }
    rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  }

  if (ref.type === 'effects') {
    const effs = JSON.parse(JSON.stringify(paintData.effects));
    const e = effs[ref.index];
    computeHSL(e.color);
    e.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: e.color.a };
    paintData.effects = effs;
    const node = await figma.getNodeByIdAsync(ref.nodeId);
    if (node) node.effects = effs;

  } else if (ref.type === 'vectorRegions') {
    if (!paintData.vectorNetwork) return;
    const vn = JSON.parse(JSON.stringify(paintData.vectorNetwork));
    const region = vn.regions[ref.regionIndex];
    if (!region || !region.fills || !region.fills[ref.index]) return;
    const p = region.fills[ref.index];
    if (p.type === 'SOLID') {
      computeHSL(p.color);
      p.color = { r: rgb.r, g: rgb.g, b: rgb.b };
    } else {
      const stop = p.gradientStops[ref.stopIndex];
      computeHSL(stop.color);
      stop.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.color.a };
    }
    paintData.vectorNetwork = vn;
    const node = await figma.getNodeByIdAsync(ref.nodeId);
    if (node) await node.setVectorNetworkAsync(vn);

  } else {
    let paints;
    if (ref.type === 'mixedTextFills') {
      paints = JSON.parse(JSON.stringify(paintData.segments[ref.segmentIndex].fills));
    } else {
      paints = JSON.parse(JSON.stringify(paintData[ref.type]));
    }
    const p = paints[ref.index];
    if (p.type === 'SOLID') {
      computeHSL(p.color);
      p.color = { r: rgb.r, g: rgb.g, b: rgb.b };
    } else {
      const stop = p.gradientStops[ref.stopIndex];
      computeHSL(stop.color);
      stop.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.color.a };
    }

    const node = await figma.getNodeByIdAsync(ref.nodeId);
    if (!node) return;

    if (ref.type === 'mixedTextFills') {
      paintData.segments[ref.segmentIndex].fills = paints;
      await ensureNodeFontsLoaded(node);
      const seg = paintData.segments[ref.segmentIndex];
      node.setRangeFills(seg.start, seg.end, paints);
    } else if (ref.type === 'fills') {
      paintData.fills = paints;
      await node.setFillStyleIdAsync('');
      node.fills = paints;
    } else {
      paintData.strokes = paints;
      await node.setStrokeStyleIdAsync('');
      node.strokes = paints;
    }
  }
}

async function resetRef(ref) {
  const paintData = currentPaintsData[ref.nodeId];
  const orig = originalPaints[ref.nodeId];
  if (!paintData || !orig) return;

  var node = await figma.getNodeByIdAsync(ref.nodeId);
  if (!node) return;

  if (ref.type === 'effects') {
    const origEffects = JSON.parse(JSON.stringify(orig.effects));
    node.effects = origEffects;
  } else if (ref.type === 'mixedTextFills') {
    await ensureNodeFontsLoaded(node);
    const currentFills = JSON.parse(JSON.stringify(paintData.segments[ref.segmentIndex].fills));
    const origFills = JSON.parse(JSON.stringify(orig.segments[ref.segmentIndex].fills));
    currentFills[ref.index] = origFills[ref.index];
    const seg = orig.segments[ref.segmentIndex];
    node.setRangeFills(seg.start, seg.end, currentFills);
  } else if (ref.type === 'vectorRegions') {
    if (!paintData.vectorNetwork) return;
    const vn = JSON.parse(JSON.stringify(paintData.vectorNetwork));
    const origRegion = orig.vectorRegions[ref.regionIndex];
    if (vn.regions[ref.regionIndex] && origRegion) {
      vn.regions[ref.regionIndex].fills[ref.index] = JSON.parse(JSON.stringify(origRegion.fills[ref.index]));
      await node.setVectorNetworkAsync(vn);
    }
  } else {
    const paints = JSON.parse(JSON.stringify(paintData[ref.type]));
    const origPaints = JSON.parse(JSON.stringify(orig[ref.type]));
    paints[ref.index] = origPaints[ref.index];
    if (ref.type === 'fills') {
      await node.setFillStyleIdAsync('');
      node.fills = paints;
    } else {
      await node.setStrokeStyleIdAsync('');
      node.strokes = paints;
    }
  }
}

// ---- ADD: Object to store initial HSL values for relative changes ----
let originalSliderValues = {};

// ---- CHANGE: make onmessage handler async ----
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'start-hsl-change') {
    const refs = groupMap[msg.groupIndex] || [];
    originalSliderValues[msg.groupIndex] = {};
    for (const ref of refs) {
      const key = getRefKey(ref);
      const c = currentColors[key];
      if (!c) continue;
      originalSliderValues[msg.groupIndex][key] = rgbToHsl(c.r, c.g, c.b);
    }

  } else if (msg.type === 'change-hsl-group' || msg.type === 'change-hsl-group-fast') {
    const v = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    const refs = groupMap[msg.groupIndex] || [];
    const delta = (msg.component === 's' || msg.component === 'l') ? (msg.value - msg.startValue) / 100 : 0;
    const initialValues = originalSliderValues[msg.groupIndex];

    // Group refs by nodeId to apply changes to the same node at once.
    const refsByNode = refs.reduce((acc, ref) => {
      if (!acc[ref.nodeId]) acc[ref.nodeId] = [];
      acc[ref.nodeId].push(ref);
      return acc;
    }, {});

    const writeOps = [];

    for (const nodeId of Object.keys(refsByNode)) {
      const paintData = currentPaintsData[nodeId];
      if (!paintData) continue;
      const nodeRefs = refsByNode[nodeId];

      const hasMixed = nodeRefs.some(r => r.type === 'mixedTextFills');
      const hasVectorRegions = nodeRefs.some(r => r.type === 'vectorRegions');

      const clonedFills = (!hasMixed && paintData.fills) ? JSON.parse(JSON.stringify(paintData.fills)) : [];
      const clonedStrokes = paintData.strokes ? JSON.parse(JSON.stringify(paintData.strokes)) : [];
      const clonedEffects = paintData.effects ? JSON.parse(JSON.stringify(paintData.effects)) : [];
      let clonedVectorNetwork = null;
      if (hasVectorRegions && paintData.vectorNetwork) {
        clonedVectorNetwork = JSON.parse(JSON.stringify(paintData.vectorNetwork));
      }

      let fillsDirty = false, strokesDirty = false, effectsDirty = false, vectorNetworkDirty = false;
      const modifiedSegments = new Set();

      for (const ref of nodeRefs) {
        const refKey = getRefKey(ref);
        const initialHSL = initialValues ? initialValues[refKey] : null;

        if (ref.type === 'effects') {
          effectsDirty = true;
          const e = clonedEffects[ref.index];
          const { color: newColor } = calculateNewColor(e.color, msg.component, v, delta, initialHSL);
          e.color = Object.assign(newColor, { a: e.color.a });
          currentColors[refKey] = { r: newColor.r, g: newColor.g, b: newColor.b };
        } else if (ref.type === 'mixedTextFills') {
          const seg = paintData.segments[ref.segmentIndex];
          const p = seg.fills[ref.index];
          const target = p.type === 'SOLID' ? p : p.gradientStops[ref.stopIndex];
          const { color: newColor } = calculateNewColor(target.color, msg.component, v, delta, initialHSL);
          target.color = p.type === 'SOLID' ? newColor : Object.assign(newColor, { a: target.color.a });
          modifiedSegments.add(ref.segmentIndex);
          currentColors[refKey] = { r: newColor.r, g: newColor.g, b: newColor.b };
        } else if (ref.type === 'vectorRegions') {
          if (!clonedVectorNetwork || !clonedVectorNetwork.regions[ref.regionIndex]) continue;
          vectorNetworkDirty = true;
          const p = clonedVectorNetwork.regions[ref.regionIndex].fills[ref.index];
          const target = p.type === 'SOLID' ? p : p.gradientStops[ref.stopIndex];
          const { color: newColor } = calculateNewColor(target.color, msg.component, v, delta, initialHSL);
          target.color = p.type === 'SOLID' ? newColor : Object.assign(newColor, { a: target.color.a });
          currentColors[refKey] = { r: newColor.r, g: newColor.g, b: newColor.b };
        } else {
          let targetPaintArray = ref.type === 'fills' ? clonedFills : clonedStrokes;
          if (ref.type === 'fills') fillsDirty = true; else strokesDirty = true;
          const p = targetPaintArray[ref.index];
          const target = p.type === 'SOLID' ? p : p.gradientStops[ref.stopIndex];
          const { color: newColor } = calculateNewColor(target.color, msg.component, v, delta, initialHSL);
          target.color = p.type === 'SOLID' ? newColor : Object.assign(newColor, { a: target.color.a });
          currentColors[refKey] = { r: newColor.r, g: newColor.g, b: newColor.b };
        }
      }

      if (fillsDirty) paintData.fills = clonedFills;
      if (strokesDirty) paintData.strokes = clonedStrokes;
      if (effectsDirty) paintData.effects = clonedEffects;
      if (vectorNetworkDirty && clonedVectorNetwork) {
        paintData.vectorNetwork = clonedVectorNetwork;
        paintData.vectorRegions = clonedVectorNetwork.regions.filter(r => r.fills && r.fills.length > 0).map(r => ({
          fills: r.fills, windingRule: r.windingRule, loops: r.loops
        }));
      }

      writeOps.push({ nodeId, hasMixed, fillsDirty, strokesDirty, effectsDirty, vectorNetworkDirty,
        clonedFills, clonedStrokes, clonedEffects, clonedVectorNetwork, modifiedSegments, paintData });
    }

    for (const op of writeOps) {
      const node = await figma.getNodeByIdAsync(op.nodeId);
      if (!node) continue;
      if (op.hasMixed) await ensureNodeFontsLoaded(node);
      if (op.fillsDirty) { await node.setFillStyleIdAsync(''); node.fills = op.clonedFills; }
      if (op.strokesDirty) { await node.setStrokeStyleIdAsync(''); node.strokes = op.clonedStrokes; }
      if (op.effectsDirty) node.effects = op.clonedEffects;
      if (op.vectorNetworkDirty && op.clonedVectorNetwork) await node.setVectorNetworkAsync(op.clonedVectorNetwork);
      for (const segIdx of op.modifiedSegments) {
        const seg = op.paintData.segments[segIdx];
        node.setRangeFills(seg.start, seg.end, seg.fills);
      }
    }

    // Only recalculate subsets on the final update (not during fast drag updates)
    if (msg.type === 'change-hsl-group') {
      figma.ui.postMessage({
        type: 'update-subsets',
        subsets: computeCurrentSubsets()
      });
    }

  } else if (msg.type === 'change-hsl-subset') {
    const v = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    const allSubsets = computeCurrentSubsets();
    const targetHSL = allSubsets[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const refKey = getRefKey(ref);
      const c = currentColors[refKey];
      if (!c) continue;
      const hsl = rgbToHsl(c.r, c.g, c.b);
      if (
        Math.abs(hsl.h * 360 - targetHSL.h) < 1 &&
        Math.abs(hsl.s - targetHSL.s) < 0.01 &&
        Math.abs(hsl.l - targetHSL.l) < 0.01
      ) {
        await applyRef(ref, msg.component, v);
        const newHsl = { h: hsl.h, s: hsl.s, l: hsl.l };
        newHsl[msg.component] = v;
        if (msg.component === 'h' && newHsl.s === 0) newHsl.s = 0.5;
        if (msg.component === 'l') newHsl.l = Math.max(0.01, Math.min(0.99, v));
        const nr = hslToRgb(newHsl.h, newHsl.s, newHsl.l);
        currentColors[refKey] = { r: nr.r, g: nr.g, b: nr.b };
      }
    }
    figma.ui.postMessage({
      type: 'update-subsets',
      subsets: computeCurrentSubsets()
    });

  } else if (msg.type === 'stop-hsl-change') {
    // Clear the stored initial values
    originalSliderValues = {};
    // We no longer want to automatically rebuild groups on slider release.
    // The user must explicitly click "Update Groups".
  } else if (msg.type === 'reset-group') {
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      await resetRef(ref);
    }
    await handleSelectionChange();

  } else if (msg.type === 'reset-subset') {
    const subsetsArr = computeCurrentSubsets();
    const targetHSL = subsetsArr[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const c = currentColors[getRefKey(ref)];
      if (!c) continue;
      const hsl = rgbToHsl(c.r, c.g, c.b);
      if (
        Math.abs(hsl.h * 360 - targetHSL.h) < 1 &&
        Math.abs(hsl.s - targetHSL.s) < 0.01 &&
        Math.abs(hsl.l - targetHSL.l) < 0.01
      ) {
        await resetRef(ref);
      }
    }
    await handleSelectionChange();

  } else if (msg.type === 'hover-subset') {
    const subsetsArr = computeCurrentSubsets();
    const targetHSL = subsetsArr[msg.groupIndex][msg.subsetIndex];
    const refs = groupMap[msg.groupIndex] || [];
    const matchingNodeIds = [];
    for (const ref of refs) {
      const c = currentColors[getRefKey(ref)];
      if (!c) continue;
      const hsl = rgbToHsl(c.r, c.g, c.b);
      if (
        Math.abs(hsl.h * 360 - targetHSL.h) < 5 &&
        Math.abs(hsl.s - targetHSL.s) < 0.05 &&
        Math.abs(hsl.l - targetHSL.l) < 0.05
      ) {
        matchingNodeIds.push(ref.nodeId);
      }
    }
    const uniqueIds = [...new Set(matchingNodeIds)];
    const nodes = await Promise.all(uniqueIds.map(id => figma.getNodeByIdAsync(id)));
    highlightNodes(nodes.filter(Boolean));

  } else if (msg.type === 'set-hex') {
    const { groupIndex, subsetIndex, hex } = msg;
    const r8 = parseInt(hex.slice(1, 3), 16) / 255;
    const g8 = parseInt(hex.slice(3, 5), 16) / 255;
    const b8 = parseInt(hex.slice(5, 7), 16) / 255;
    const newHSL = rgbToHsl(r8, g8, b8);
    const vH = newHSL.h, vS = newHSL.s, vL = newHSL.l;
    const refs = groupMap[groupIndex] || [];

    if (subsetIndex < 0) {
      for (const ref of refs) {
        await applyRef(ref, 'h', vH);
        await applyRef(ref, 's', vS);
        await applyRef(ref, 'l', vL);
      }
    } else {
      const oldSubsets = computeCurrentSubsets();
      const targetHSL = oldSubsets[groupIndex][subsetIndex];
      const epsH = 1, epsS = 0.01, epsL = 0.01;
      for (const ref of refs) {
        const c = currentColors[getRefKey(ref)];
        if (!c) continue;
        const cur = rgbToHsl(c.r, c.g, c.b);
        if (
          Math.abs(cur.h * 360 - targetHSL.h) < epsH &&
          Math.abs(cur.s - targetHSL.s) < epsS &&
          Math.abs(cur.l - targetHSL.l) < epsL
        ) {
          await applyRef(ref, 'h', vH);
          await applyRef(ref, 's', vS);
          await applyRef(ref, 'l', vL);
        }
      }
    }
    await handleSelectionChange();

  } else if (msg.type === 'unhover-subset') {
    clearHighlights();

  } else if (msg.type === 'refresh-groups') {
    await handleSelectionChange();
  }
};  // ← closing brace & semicolon

function calculateNewColor(c, comp, v, delta, initialHSL) {
  let hsl;
  if (initialHSL && (comp === 's' || comp === 'l')) {
    hsl = { h: initialHSL.h, s: initialHSL.s, l: initialHSL.l };
    const newValue = initialHSL[comp] + delta;
    if (comp === 'l') {
      hsl[comp] = Math.max(0.01, Math.min(0.99, newValue));
    } else { // saturation
      hsl[comp] = Math.max(0, Math.min(1, newValue));
    }
  } else {
    hsl = rgbToHsl(c.r, c.g, c.b);
    // Also clamp absolute changes for lightness
    hsl[comp] = comp === 'l' ? Math.max(0.01, Math.min(0.99, v)) : v;
  }

  if (comp === 'h' && hsl.s === 0) {
    hsl.s = 0.5;
    figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
  }

  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  const color = { r: rgb.r, g: rgb.g, b: rgb.b };

  return { color, hsl };
}
