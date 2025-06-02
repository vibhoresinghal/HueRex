// Helpers: RGB ↔ HSL
function rgbToHsl(r, g, b) {
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2;             break;
      case b: h = (r - g) / d + 4;             break;
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
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * 6 * (2/3 - t);
    return p;
  }
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1/3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1/3)
  };
}

// Deep‐clone helper
function clonePaints(arr) {
  return Array.isArray(arr) ? JSON.parse(JSON.stringify(arr)) : [];
}

var originalPaints = {}, groupMap = [];

// Record paints & effects (skip hidden)
function recordOriginals(node) {
  // skip hidden nodes
  if (node.visible === false) return;
  // skip the mask layer itself, but not its children
  if (node.isMask) return;

  // record this node’s fills, strokes, and effects if present
  if (
    (node.fills   !== undefined && node.fills   !== figma.mixed) ||
    (node.strokes !== undefined && node.strokes !== figma.mixed) ||
    (node.effects && node.effects.length)
  ) {
    originalPaints[node.id] = {
      fills:   clonePaints(node.fills),
      strokes: clonePaints(node.strokes),
      effects: clonePaints(node.effects)
    };
  }

  // recurse into children (including those inside masks)
  if (node.children) {
    node.children.forEach(recordOriginals);
  }
}

// Build hue clusters (±15°), dedupe, skip hidden
function buildGroups() {
  var unique = []; groupMap = [];
  function cluster(hsl, ref) {
    var tolH = 15/360;
    for (var gi = 0; gi < unique.length; gi++) {
      var u = unique[gi];
      if (!u.all && Math.abs(u.h/360 - hsl.h) < tolH) {
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
    ['fills','strokes'].forEach(type => {
      (orig[type] || []).forEach((p, pi) => {
        if (p.visible === false) return;
        if (p.type === 'SOLID') {
          cluster(rgbToHsl(p.color.r, p.color.g, p.color.b),
                  { nodeId, type, index: pi, stopIndex: null });
        } else if (p.type.indexOf('GRADIENT') === 0) {
          p.gradientStops.forEach((stop, si) => {
            if (stop.visible === false) return;
            cluster(rgbToHsl(stop.color.r, stop.color.g, stop.color.b),
                    { nodeId, type, index: pi, stopIndex: si });
          });
        }
      });
    });
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
      var c = ref.type === 'effects'
            ? node.effects[ref.index].color
            : (node[ref.type][ref.index].type === 'SOLID'
               ? node[ref.type][ref.index].color
               : node[ref.type][ref.index].gradientStops[ref.stopIndex].color);
      var hsl = rgbToHsl(c.r, c.g, c.b);
      arr.push({ h: hsl.h*360, s: hsl.s, l: hsl.l });
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
async function handleSelectionChange() {
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
  colors   = zipped.map(z => z.color);
  subsets  = zipped.map(z => z.subset);
  groupMap = zipped.map(z => z.refs);

  figma.ui.postMessage({ type: 'selection-colors', colors, subsets });
}

figma.showUI(__html__, { width: 320, height: 260 });
figma.on('selectionchange', handleSelectionChange);
// Initial call (no await needed)
handleSelectionChange();

// ---- CHANGE: make applyRef async and use getNodeByIdAsync AND async style setters ----
async function applyRef(ref, comp, v) {
  const node = await figma.getNodeByIdAsync(ref.nodeId);
  if (!node) return;

  // pull existing color
  let hsl, rgb;
  if (ref.type === 'effects') {
    const effs = clonePaints(node.effects), e = effs[ref.index];
    hsl = rgbToHsl(e.color.r, e.color.g, e.color.b);
    hsl[comp] = v;
    // If hue on desaturated, give some saturation
    if (comp === 'h' && hsl.s === 0) {
      hsl.s = 0.5;
      figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
    }
    rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
    e.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: e.color.a };
    node.effects = effs;

  } else {
    const paints = clonePaints(node[ref.type]), p = paints[ref.index];
    if (p.type === 'SOLID') {
      hsl = rgbToHsl(p.color.r, p.color.g, p.color.b);
      hsl[comp] = v;
      if (comp === 'h' && hsl.s === 0) {
        hsl.s = 0.5;
        figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
      }
      rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      p.color = { r: rgb.r, g: rgb.g, b: rgb.b };
    } else {
      const stop = p.gradientStops[ref.stopIndex];
      hsl = rgbToHsl(stop.color.r, stop.color.g, stop.color.b);
      hsl[comp] = v;
      if (comp === 'h' && hsl.s === 0) {
        hsl.s = 0.5;
        figma.ui.postMessage({ type: 'force-saturation', value: Math.round(50) });
      }
      rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      stop.color = { r: rgb.r, g: rgb.g, b: rgb.b, a: stop.color.a };
    }
    if (ref.type === 'fills') {
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
  } else {
    var paints = clonePaints(node[ref.type]),
        orig   = originalPaints[node.id][ref.type];
    paints[ref.index] = clonePaints(orig)[ref.index];
    if (ref.type === 'fills') {
      await node.setFillStyleIdAsync('');
      node.fills   = paints;
    } else {
      await node.setStrokeStyleIdAsync('');
      node.strokes = paints;
    }
  }
}

// ---- CHANGE: make onmessage handler async ----
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'change-hsl-group') {
    const comp     = msg.component;              // 'h' | 's' | 'l'
    const rawValue = msg.value;                  // 0–360 for hue, 0–100 for sat/light
    const v        = (comp === 'h')
                     ? rawValue / 360
                     : rawValue / 100;

    // 1) Grab exactly the refs in this cluster:
    const refs = groupMap[msg.groupIndex] || [];

    // 2) For each ref (which may be a gradientStop or a solid), call applyRef(ref,…)
    for (const ref of refs) {
      await applyRef(ref, comp, v);
    }

    // 3) Recompute subsets and send updated subsets back:
    const subsets = await getCurrentSubsets();
    figma.ui.postMessage({ type: 'update-subsets', subsets });

  } else if (msg.type === 'change-hsl-subset') {
    const v     = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    const allSubsets = await getCurrentSubsets();
    const targetHSL  = allSubsets[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h   = hsl.h * 360, s = hsl.s, l = hsl.l;
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
      type:    'update-subsets',
      subsets: subsets2
    });

  } else if (msg.type === 'reset-group') {
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      await resetRef(ref);
    }
    await handleSelectionChange();

  } else if (msg.type === 'reset-subset') {
    const subsetsArr = await getCurrentSubsets();
    const targetHSL  = subsetsArr[msg.groupIndex][msg.subsetIndex];
    for (const ref of (groupMap[msg.groupIndex] || [])) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h   = hsl.h * 360, s = hsl.s, l = hsl.l;
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
    const targetHSL  = subsetsArr[msg.groupIndex][msg.subsetIndex];
    const refs       = groupMap[msg.groupIndex] || [];
    const nodeIds    = new Set();
    for (const ref of refs) {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node) continue;
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h   = hsl.h * 360, s = hsl.s, l = hsl.l;
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
    const r8 = parseInt(hex.slice(1,3), 16) / 255;
    const g8 = parseInt(hex.slice(3,5), 16) / 255;
    const b8 = parseInt(hex.slice(5,7), 16) / 255;
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
      const targetHSL  = oldSubsets[groupIndex][subsetIndex];
      const epsH = 1, epsS = 0.01, epsL = 0.01;
      for (const ref of (groupMap[groupIndex] || [])) {
        const node = await figma.getNodeByIdAsync(ref.nodeId);
        if (!node) continue;
        let c;
        if (ref.type === 'effects') {
          c = node.effects[ref.index].color;
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
