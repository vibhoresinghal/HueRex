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

function getCurrentSubsets() {
  return groupMap.map(refs => {
    var arr = refs.map(ref => {
      var node = figma.getNodeById(ref.nodeId);
      if (!node) return null;
      var c = ref.type === 'effects'
            ? node.effects[ref.index].color
            : (node[ref.type][ref.index].type === 'SOLID'
               ? node[ref.type][ref.index].color
               : node[ref.type][ref.index].gradientStops[ref.stopIndex].color);
      var hsl = rgbToHsl(c.r, c.g, c.b);
      return { h: hsl.h*360, s: hsl.s, l: hsl.l };
    }).filter(Boolean);
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
    rect.dashPattern = [0, ];
    figma.currentPage.appendChild(rect);
    highlightRects.push(rect);
  }
}


function handleSelectionChange() {
  var sel = figma.currentPage.selection;
  originalPaints = {}; groupMap = [];
  if (!sel.length) {
    figma.ui.postMessage({ type:'selection-colors', colors: [], subsets: [] });
    return;
  }
  sel.forEach(recordOriginals);
  var colors = buildGroups(), subsets = getCurrentSubsets();
  var zipped = colors.map((c,i)=>({color:c, subset:subsets[i], refs:groupMap[i]}));
  zipped.sort((a,b)=> b.color.l - a.color.l);
  colors   = zipped.map(z=>z.color);
  subsets  = zipped.map(z=>z.subset);
  groupMap = zipped.map(z=>z.refs);

  figma.ui.postMessage({ type:'selection-colors', colors, subsets });
}

figma.showUI(__html__, { width:320, height:260 });
figma.on('selectionchange', handleSelectionChange);
handleSelectionChange();

function applyRef(ref, comp, v) {
  const node = figma.getNodeById(ref.nodeId);
  if (!node) return;

  // pull existing color
  let hsl, rgb;
  if (ref.type === 'effects') {
    const effs = clonePaints(node.effects), e = effs[ref.index];
    hsl = rgbToHsl(e.color.r, e.color.g, e.color.b);
    hsl[comp] = v;
    // —— NEW: if you’re adjusting H on a perfectly desaturated color, give it some S
    if (comp === 'h' && hsl.s === 0) {
      hsl.s = 0.5; // 50% sat, adjust as you like
      // inform the UI so its slider catches that change:
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
      node.fillStyleId = '';
      node.fills = paints;
    } else {
      node.strokeStyleId = '';
      node.strokes = paints;
    }
  }
}

function resetRef(ref) {
  var node = figma.getNodeById(ref.nodeId);
  if (!node) return;
  if (ref.type === 'effects') {
    node.effects = clonePaints(originalPaints[node.id].effects);
  } else {
    var paints = clonePaints(node[ref.type]),
        orig   = originalPaints[node.id][ref.type];
    paints[ref.index] = clonePaints(orig)[ref.index];
    if (ref.type === 'fills') {
      node.fillStyleId = ''; node.fills   = paints;
    } else {
      node.strokeStyleId = ''; node.strokes = paints;
    }
  }
}

figma.ui.onmessage = msg => {
  if (msg.type === 'change-hsl-group') {
    const v    = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    const refs = groupMap[msg.groupIndex] || [];
    refs.forEach(ref => applyRef(ref, msg.component, v));
    figma.ui.postMessage({
      type:    'update-subsets',
      subsets: getCurrentSubsets()
    });

  } else if (msg.type === 'change-hsl-subset') {
    const v     = msg.component === 'h' ? msg.value / 360 : msg.value / 100;
    // figure out which exact HSL we’re targeting
    const allSubsets = getCurrentSubsets();
    const targetHSL  = allSubsets[msg.groupIndex][msg.subsetIndex];
    // apply to every matching ref in the cluster
    (groupMap[msg.groupIndex] || []).forEach(ref => {
      const node = figma.getNodeById(ref.nodeId);
      if (!node) return;
      // pull its current color
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
      // if it matches our subset HSL within tolerance:
      if (
        Math.abs(h - targetHSL.h) < 1 &&
        Math.abs(s - targetHSL.s) < 0.01 &&
        Math.abs(l - targetHSL.l) < 0.01
      ) {
        applyRef(ref, msg.component, v);
      }
    });
    figma.ui.postMessage({
      type:    'update-subsets',
      subsets: getCurrentSubsets()
    });

  } else if (msg.type === 'reset-group') {
    (groupMap[msg.groupIndex] || [])
      .forEach(ref => resetRef(ref));
    handleSelectionChange();

  } else if (msg.type === 'reset-subset') {
    // 1. figure out which HSL we want to reset
    const subsetsArr = getCurrentSubsets();
    const targetHSL  = subsetsArr[msg.groupIndex][msg.subsetIndex];
  
    // 2. reset every ref in this cluster whose current HSL matches
    (groupMap[msg.groupIndex] || []).forEach(ref => {
      const node = figma.getNodeById(ref.nodeId);
      if (!node) return;
  
      // pull its current color
      let c;
      if (ref.type === 'effects') {
        c = node.effects[ref.index].color;
      } else {
        const p = node[ref.type][ref.index];
        c = p.type === 'SOLID'
          ? p.color
          : p.gradientStops[ref.stopIndex].color;
      }
  
      // convert to HSL
      const hsl = rgbToHsl(c.r, c.g, c.b);
      const h   = hsl.h * 360,
            s   = hsl.s,
            l   = hsl.l;
  
      // if it matches our subset HSL (within a small tolerance), reset it
      if (
        Math.abs(h - targetHSL.h) < 1 &&
        Math.abs(s - targetHSL.s) < 0.01 &&
        Math.abs(l - targetHSL.l) < 0.01
      ) {
        resetRef(ref);
      }
    });
  
    // 3. refresh everything
    handleSelectionChange();
  }
   else if (msg.type === 'hover-subset') {
    // highlight all nodes whose current color still matches this subset
    const subsetsArr = getCurrentSubsets();
    const targetHSL  = subsetsArr[msg.groupIndex][msg.subsetIndex];
    const refs       = groupMap[msg.groupIndex] || [];
    const nodeIds    = new Set();
    for (const ref of refs) {
      const node = figma.getNodeById(ref.nodeId);
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
    const nodesToHighlight = Array.from(nodeIds)
      .map(id => figma.getNodeById(id))
      .filter(n => n);
    highlightNodes(nodesToHighlight);

  } else if (msg.type === 'unhover-subset') {
    clearHighlights();
  }
  else if (msg.type === 'refresh-groups') {
    // re-cluster & redraw everything
    handleSelectionChange();
  }
};  // ← make sure this closing brace & semicolon are here

