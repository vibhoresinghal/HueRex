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

// Deep‐clone helper
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

var originalPaints = {}, groupMap = [];

// Record paints & effects (skip hidden)
function recordOriginals(node) {
  // skip hidden nodes
  if (node.visible === false) return;
  // skip the mask layer itself, but not its children
  if (node.isMask) return;

  const isMixedFills = node.type === 'TEXT' && node.fills === figma.mixed;

  // record this node’s fills, strokes, and effects if present
  if (
    isMixedFills ||
    (node.fills !== undefined && node.fills !== figma.mixed) ||
    (node.strokes !== undefined && node.strokes !== figma.mixed) ||
    (node.effects && node.effects.length)
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
  });

  if (unique.length > 1) {
    unique.unshift({ all: true });
    groupMap.unshift([].concat(...groupMap));
  }
  return unique;
}

// ---- CHANGE: make this function async and use getNodeByIdAsync ----
async function getCurrentSubsets() {
  return Promise.all(groupMap.map(async refs => {
    var arr = [];
    for (const ref of refs) {
      var node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      let paint;
      if (ref.type === 'mixedTextFills') {
        const segs = node.getStyledTextSegments(['fills']);
        if (segs[ref.segmentIndex]) paint = segs[ref.segmentIndex].fills[ref.index];
      } else {
        paint = node[ref.type] && node[ref.type][ref.index];
      }
      if (!paint) continue;

      if (ref.type === 'effects') {
        c = paint.color;
      } else {
        c = paint.type === 'SOLID' ? paint.color : (paint.gradientStops && paint.gradientStops[ref.stopIndex] ? paint.gradientStops[ref.stopIndex].color : null);
      }
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
  }));
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

// ---- CHANGE: make handleSelectionChange async and await getCurrentSubsets ----
async function handleSelectionChange(selectedGroupIndex) {
  var sel = figma.currentPage.selection;
  originalPaints = {}; groupMap = [];
  if (!sel.length) {
    figma.ui.postMessage({ type: 'selection-colors', colors: [], subsets: [] });
    return;
  }
  sel.forEach(recordOriginals);
  var colors = buildGroups();
  var subsets = await getCurrentSubsets();
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

// ---- CHANGE: make applyRef async and use getNodeByIdAsync AND async style setters ----
async function applyRef(ref, comp, v, delta, initialValues) {
  const node = await figma.getNodeByIdAsync(ref.nodeId);
  if (!node) return;

  // pull existing color
  let hsl, rgb;
  const key = ref.type === 'mixedTextFills'
    ? `${ref.nodeId}-${ref.type}-${ref.segmentIndex}-${ref.index}-${ref.stopIndex}`
    : `${ref.nodeId}-${ref.type}-${ref.index}-${ref.stopIndex}`;
  const initialHSL = initialValues ? initialValues[key] : null;

  if (ref.type === 'effects') {
    const effs = clonePaints(node.effects), e = effs[ref.index];
    if (initialHSL && (comp === 's' || comp === 'l')) {
      hsl = { h: initialHSL.h, s: initialHSL.s, l: initialHSL.l };
      hsl[comp] = Math.max(0, Math.min(1, initialHSL[comp] + delta));
    } else {
      hsl = rgbToHsl(e.color.r, e.color.g, e.color.b);
      hsl[comp] = v;
    }
    // If hue on desaturated, give some saturation
    if (comp === 'h' && hsl.s === 0) {
      hsl.s = 0.5;
      figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
    }
    rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
    e.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: e.color.a };
    node.effects = effs;

  } else {
    let paints;
    if (ref.type === 'mixedTextFills') {
      await ensureNodeFontsLoaded(node);
      const origSeg = originalPaints[node.id].segments[ref.segmentIndex];
      paints = clonePaints(node.getRangeFills(origSeg.start, origSeg.end));
    } else {
      paints = clonePaints(node[ref.type]);
    }
    const p = paints[ref.index];

    if (p.type === 'SOLID') {
      if (initialHSL && (comp === 's' || comp === 'l')) {
        hsl = { h: initialHSL.h, s: initialHSL.s, l: initialHSL.l };
        hsl[comp] = Math.max(0, Math.min(1, initialHSL[comp] + delta));
      } else {
        hsl = rgbToHsl(p.color.r, p.color.g, p.color.b);
        hsl[comp] = v;
      }
      if (comp === 'h' && hsl.s === 0) {
        hsl.s = 0.5;
        figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
      }
      rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      p.color = { r: rgb.r, g: rgb.g, b: rgb.b };
    } else {
      // When a gradient stop is part of a group, apply the change only to that stop.
      const stop = p.gradientStops[ref.stopIndex];
      if (initialHSL && (comp === 's' || comp === 'l')) {
        hsl = { h: initialHSL.h, s: initialHSL.s, l: initialHSL.l };
        hsl[comp] = Math.max(0, Math.min(1, initialHSL[comp] + delta));
      } else {
        hsl = rgbToHsl(stop.color.r, stop.color.g, stop.color.b);
        hsl[comp] = v;
      }
      if (comp === 'h' && hsl.s === 0) {
        hsl.s = 0.5;
        figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
      }

      rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      stop.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.color.a };
    }

    if (ref.type === 'mixedTextFills') {
      const origSeg = originalPaints[node.id].segments[ref.segmentIndex];
      node.setRangeFills(origSeg.start, origSeg.end, paints);
    } else if (ref.type === 'fills') {
      // Async setter for dynamic-page access
      await node.setFillStyleIdAsync('');
      node.fills = paints;
    } else {
      await node.setStrokeStyleIdAsync('');
      node.strokes = paints;
    }
  }
}

// ---- CHANGE: make resetRef async and use getNodeByIdAsync AND async style setters ----
async function resetRef(ref) {
  var node = await figma.getNodeByIdAsync(ref.nodeId);
  if (!node) return;
  if (ref.type === 'effects') {
    node.effects = clonePaints(originalPaints[node.id].effects);
  } else if (ref.type === 'mixedTextFills') {
    await ensureNodeFontsLoaded(node);
    const origSeg = originalPaints[node.id].segments[ref.segmentIndex];
    const paints = clonePaints(node.getRangeFills(origSeg.start, origSeg.end));
    paints[ref.index] = clonePaints(origSeg.fills)[ref.index];
    node.setRangeFills(origSeg.start, origSeg.end, paints);
  } else {
    var paints = clonePaints(node[ref.type]),
      orig = originalPaints[node.id][ref.type];
    paints[ref.index] = clonePaints(orig)[ref.index];
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
    // Store the initial HSL values for all colors in the group
    const refs = groupMap[msg.groupIndex] || [];
    originalSliderValues[msg.groupIndex] = {};
    for (const ref of refs) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else if (ref.type === 'mixedTextFills') {
        const segs = node.getStyledTextSegments(['fills']);
        const p = segs[ref.segmentIndex].fills[ref.index];
        c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
      }
      const key = ref.type === 'mixedTextFills'
        ? `${ref.nodeId}-${ref.type}-${ref.segmentIndex}-${ref.index}-${ref.stopIndex}`
        : `${ref.nodeId}-${ref.type}-${ref.index}-${ref.stopIndex}`;
      originalSliderValues[msg.groupIndex][key] = rgbToHsl(c.r, c.g, c.b);
    }

  } else if (msg.type === 'change-hsl-group') {
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

    const promises = Object.keys(refsByNode).map(async (nodeId) => {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) return;

      const nodeRefs = refsByNode[nodeId];

      const hasMixed = nodeRefs.some(r => r.type === 'mixedTextFills');
      if (hasMixed) {
        await ensureNodeFontsLoaded(node);
      }

      const clonedFills = (!hasMixed && node.fills !== figma.mixed && node.fills) ? clonePaints(node.fills) : [];
      const clonedStrokes = (node.strokes !== undefined && node.strokes !== figma.mixed) ? clonePaints(node.strokes) : [];
      const clonedEffects = (node.effects && node.effects.length) ? clonePaints(node.effects) : [];

      let fillsDirty = false, strokesDirty = false, effectsDirty = false;

      for (const ref of nodeRefs) {
        const key = ref.type === 'mixedTextFills'
          ? `${ref.nodeId}-${ref.type}-${ref.segmentIndex}-${ref.index}-${ref.stopIndex}`
          : `${ref.nodeId}-${ref.type}-${ref.index}-${ref.stopIndex}`;
        const initialHSL = initialValues ? initialValues[key] : null;

        // Determine target array
        let targetPaintArray = (ref.type === 'fills' || ref.type === 'mixedTextFills') ? clonedFills : (ref.type === 'strokes' ? clonedStrokes : clonedEffects);
        if (ref.type === 'effects') {
          effectsDirty = true;
          const e = targetPaintArray[ref.index];
          const { color: newColor } = calculateNewColor(e.color, msg.component, v, delta, initialHSL);
          e.color = Object.assign(newColor, { a: e.color.a });
        } else if (ref.type === 'mixedTextFills') {
          const origSeg = originalPaints[nodeId].segments[ref.segmentIndex];
          const currentFills = node.getRangeFills(origSeg.start, origSeg.end);
          if (currentFills === figma.mixed) continue; // Should not happen if segments are valid
          const paints = clonePaints(currentFills);
          const p = paints[ref.index];
          const target = p.type === 'SOLID' ? p : p.gradientStops[ref.stopIndex];
          const { color: newColor } = calculateNewColor(target.color, msg.component, v, delta, initialHSL);
          target.color = p.type === 'SOLID' ? newColor : Object.assign(newColor, { a: target.color.a });
          node.setRangeFills(origSeg.start, origSeg.end, paints);
        } else { // standard fills or strokes
          if (ref.type === 'fills') fillsDirty = true; else strokesDirty = true;
          const p = targetPaintArray[ref.index];
          const target = p.type === 'SOLID' ? p : p.gradientStops[ref.stopIndex];
          const { color: newColor } = calculateNewColor(target.color, msg.component, v, delta, initialHSL);
          target.color = p.type === 'SOLID' ? newColor : Object.assign(newColor, { a: target.color.a });
        }
      }

      if (fillsDirty) { await node.setFillStyleIdAsync(''); node.fills = clonedFills; }
      if (strokesDirty) { await node.setStrokeStyleIdAsync(''); node.strokes = clonedStrokes; }
      if (effectsDirty) node.effects = clonedEffects;
    });

    await Promise.all(promises);
    const subsets = await getCurrentSubsets();
    figma.ui.postMessage({ type: 'update-subsets', subsets });

  } else if (msg.type === 'change-hsl-subset') {
    // NOTE: This logic for individual subset colors remains an absolute change.
    const v = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    const allSubsets = await getCurrentSubsets();
    const targetHSL = allSubsets[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else if (ref.type === 'mixedTextFills') {
        const segs = node.getStyledTextSegments(['fills']);
        const p = segs[ref.segmentIndex].fills[ref.index];
        c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h = hsl.h * 360, s = hsl.s, l = hsl.l;
      if (
        Math.abs(h - targetHSL.h) < 1 &&
        Math.abs(s - targetHSL.s) < 0.01 &&
        Math.abs(l - targetHSL.l) < 0.01
      ) {
        await applyRef(ref, msg.component, v);
      }
    }
    const subsets2 = await getCurrentSubsets();
    figma.ui.postMessage({
      type: 'update-subsets',
      subsets: subsets2
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
    const subsetsArr = await getCurrentSubsets();
    const targetHSL = subsetsArr[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      // Add defensive checks
      if (!node || !node[ref.type] || !node[ref.type][ref.index]) continue;

      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else if (ref.type === 'mixedTextFills') {
        const segs = node.getStyledTextSegments(['fills']);
        const p = segs[ref.segmentIndex].fills[ref.index];
        c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
      } else {
        const p = node[ref.type][ref.index];
        if (p.type !== 'SOLID' && (!p.gradientStops || !p.gradientStops[ref.stopIndex])) continue;
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h = hsl.h * 360, s = hsl.s, l = hsl.l;
      if (
        Math.abs(h - targetHSL.h) < 1 &&
        Math.abs(s - targetHSL.s) < 0.01 &&
        Math.abs(l - targetHSL.l) < 0.01
      ) {
        await resetRef(ref);
      }
    }
    await handleSelectionChange();

  } else if (msg.type === 'hover-subset') {
    const subsetsArr = await getCurrentSubsets();
    const targetHSL = subsetsArr[msg.groupIndex][msg.subsetIndex];
    const refs = groupMap[msg.groupIndex] || [];
    const nodeIds = new Set();
    for (const ref of refs) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else if (ref.type === 'mixedTextFills') {
        const segs = node.getStyledTextSegments(['fills']);
        const p = segs[ref.segmentIndex].fills[ref.index];
        c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h = hsl.h * 360, s = hsl.s, l = hsl.l;
      if (
        Math.abs(h - targetHSL.h) < 5 &&
        Math.abs(s - targetHSL.s) < 0.05 &&
        Math.abs(l - targetHSL.l) < 0.05
      ) {
        nodeIds.add(ref.nodeId);
      }
    }
    const nodesToHighlight = [];
    for (const id of nodeIds) {
      const n = await figma.getNodeByIdAsync(id);
      if (n) nodesToHighlight.push(n);
    }
    highlightNodes(nodesToHighlight);

  } else if (msg.type === 'set-hex') {
    const { groupIndex, subsetIndex, hex } = msg;
    const r8 = parseInt(hex.slice(1, 3), 16) / 255;
    const g8 = parseInt(hex.slice(3, 5), 16) / 255;
    const b8 = parseInt(hex.slice(5, 7), 16) / 255;
    const newHSL = rgbToHsl(r8, g8, b8);
    const vH = newHSL.h, vS = newHSL.s, vL = newHSL.l;

    if (subsetIndex < 0) {
      for (const ref of (groupMap[groupIndex] || [])) {
        await applyRef(ref, 'h', vH);
        await applyRef(ref, 's', vS);
        await applyRef(ref, 'l', vL);
      }
    } else {
      const oldSubsets = await getCurrentSubsets();
      const targetHSL = oldSubsets[groupIndex][subsetIndex];
      const epsH = 1, epsS = 0.01, epsL = 0.01;
      for (const ref of (groupMap[groupIndex] || [])) {
        const node = await figma.getNodeByIdAsync(ref.nodeId);
        if (!node) continue;
        let c;
        if (ref.type === 'effects') {
          c = node.effects[ref.index].color;
        } else if (ref.type === 'mixedTextFills') {
          const segs = node.getStyledTextSegments(['fills']);
          const p = segs[ref.segmentIndex].fills[ref.index];
          c = p.type === 'SOLID' ? p.color : p.gradientStops[ref.stopIndex].color;
        } else {
          const p = node[ref.type][ref.index];
          c = p.type === 'SOLID'
            ? p.color
            : p.gradientStops[ref.stopIndex].color;
        }
        const cur = rgbToHsl(c.r, c.g, c.b);
        const h = cur.h * 360, s = cur.s, l = cur.l;
        if (
          Math.abs(h - targetHSL.h) < epsH &&
          Math.abs(s - targetHSL.s) < epsS &&
          Math.abs(l - targetHSL.l) < epsL
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
