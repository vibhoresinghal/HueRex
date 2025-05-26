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
  if (node.visible === false) return;
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
  if (node.children) node.children.forEach(recordOriginals);
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
    const v = msg.component==='h'? msg.value/360: msg.value/100;
    (groupMap[msg.groupIndex]||[]).forEach(r=>applyRef(r,msg.component,v));
    figma.ui.postMessage({ type:'update-subsets', subsets:getCurrentSubsets() });

  } else if (msg.type === 'change-hsl-subset') {
    const v = msg.component==='h'? msg.value/360: msg.value/100;
    const refs = groupMap[msg.groupIndex]||[]; const ref = refs[msg.subsetIndex];
    if (ref) applyRef(ref, msg.component, v);
    figma.ui.postMessage({ type:'update-subsets', subsets:getCurrentSubsets() });

  } else if (msg.type === 'reset-group') {
    (groupMap[msg.groupIndex]||[]).forEach(r=>resetRef(r));
    handleSelectionChange();

  } else if (msg.type === 'reset-subset') {
    const ref = (groupMap[msg.groupIndex]||[])[msg.subsetIndex];
    if (ref) resetRef(ref);
    handleSelectionChange();
  }
};
