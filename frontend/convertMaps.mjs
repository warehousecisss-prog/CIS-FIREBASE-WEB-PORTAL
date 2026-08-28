import fs from 'fs';
import path from 'path';

const legacyMapsDir = 'C:/Users/Michael/Desktop/CIS WEB PORTAL CODE BASE - SRC RESOURCE REFACTOR/src/frontend/maps';
const outDir = path.resolve('./src/components/maps');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const files = fs.readdirSync(legacyMapsDir).filter(f => f.endsWith('.html'));

const camelCaseProps = {
  'clip-rule': 'clipRule',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'clip-path': 'clipPath',
  'fill-rule': 'fillRule',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'text-anchor': 'textAnchor',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'xml:space': 'xmlSpace',
  'transform-origin': 'transformOrigin',
  'preserveAspectRatio': 'preserveAspectRatio',
  'viewBox': 'viewBox',
  'xmlns:xlink': 'xmlnsXlink'
};

for (const file of files) {
  let content = fs.readFileSync(path.join(legacyMapsDir, file), 'utf8');
  
  // Convert standard SVG attributes to camelCase
  for (const [k, v] of Object.entries(camelCaseProps)) {
    const regex = new RegExp(`\\s${k}=`, 'g');
    content = content.replace(regex, ` ${v}=`);
  }

  // Handle style="fill: red;" -> style={{fill: "red"}}
  content = content.replace(/style="([^"]*)"/g, (match, styles) => {
    const styleObj = styles.split(';').filter(Boolean).map(s => {
      const [k, v] = s.split(':');
      if (!k || !v) return '';
      const camelK = k.trim().replace(/-([a-z])/g, g => g[1].toUpperCase());
      return `${camelK}: "${v.trim()}"`;
    }).filter(Boolean).join(', ');
    return `style={{${styleObj}}}`;
  });

  // Inject dynamic classNames based on id for elements that look like slots
  content = content.replace(/id="([^"]+)"/g, (match, id) => {
    // Catch anything that is all uppercase with hyphens (e.g., PWH-STAGING-01, PP-A-1)
    const isSlotOrRack = id.includes('-') && id === id.toUpperCase() && /[A-Z]/.test(id);
    
    if (isSlotOrRack) {
      return `id="${id}" className={getSlotClass("${id}")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("${id}"); }}`;
    }
    return `id="${id}"`;
  });

  const componentName = file.replace('.html', '');

  const jsx = `import React from 'react';

export default function ${componentName}({ inventoryMap, heatmapMode, onSlotClick }) {
  
  const getSlotClass = (id) => {
    const slot = inventoryMap?.[id];
    let classes = ['map-slot'];
    
    if (slot) {
      if (slot.status === 'Occupied') classes.push('occupied-slot');
      else if (slot.status === 'Reserved') classes.push('reserved-slot');
      else if (slot.status === 'Staging') classes.push('staging-slot');
      else if (slot.status === 'Staged') classes.push('staged-slot');
      else if (slot.status === 'Labeled') classes.push('labeled-slot');
      
      if (heatmapMode) {
        if (slot.agingDays <= 30) classes.push('heat-fresh');
        else if (slot.agingDays <= 90) classes.push('heat-mid');
        else classes.push('heat-stale');
      }
    } else {
      classes.push('empty-slot');
    }
    return classes.join(' ');
  };

  return (
    <div className="svg-map-wrapper" style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      ${content}
    </div>
  );
}
`;

  fs.writeFileSync(path.join(outDir, `${componentName}.jsx`), jsx);
}

console.log('Successfully converted all SVG maps to React components!');
