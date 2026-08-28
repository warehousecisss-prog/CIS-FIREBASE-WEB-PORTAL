import React from 'react';

export default function Map_PWH_RUP2_Rolling_2({ inventoryMap, heatmapMode, onSlotClick }) {
  
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
      <svg id="svg1" width="196.34mm" height="182.18mm" version="1.1" viewBox="0 0 196.34 182.18" xmlSpace="preserve" xmlns="http://www.w3.org/2000/svg"><g id="g3" transform="matrix(.26458 0 0 .26458 -1185 864.1)"><g id="g12"><g id="PWH-PandP-RACKA-BG" transform="translate(.10664)" strokeWidth="1.9994"><rect id="rect747" x="4478.7" y="-3265.9" width="742.06" height="688.54" fill="#fff"/><g id="g9" transform="translate(-1140.9,-346.5)"><g id="g7" transform="translate(-.46709)"/><text id="text7" x="5699.8994" y="-2310.5002" fill="#000000" fontFamily="sans-serif" fontSize="42.667px" stroke="#000000" style={{fontVariantCaps: "normal", fontVariantEastAsian: "normal", fontVariantLigatures: "normal", fontVariantNumeric: "normal", lineHeight: "0"}} xmlSpace="preserve"><tspan id="tspan7" x="5699.8994" y="-2310.5002" strokeWidth="1.9994">VIEW RUP 2 Rolling Shelf 2</tspan></text></g></g><g id="g4" transform="translate(.037584)"><g id="rect"><g id="g5"><path id="rect1" d="m4703.6-3055.5v332.96h292.4v-332.96zm2 2h288.41v328.96h-288.41z" stopColor="#000000"/><path id="path3" d="m4704.1-2945.1v2h290.4v-2z" stopColor="#000000"/><path id="path4" d="m4704.1-2834.8v2h290.4v-2z" stopColor="#000000"/></g></g><g id="g2" fill="#0ff"><g id="PWH-FP-RUP2-RACK-ROLLING-02" className={getSlotClass("PWH-FP-RUP2-RACK-ROLLING-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("PWH-FP-RUP2-RACK-ROLLING-02"); }} strokeWidth="1.7957"><rect id="PWH-FP-RUP2-RACK-ROLLING-02-L-04" className={getSlotClass("PWH-FP-RUP2-RACK-ROLLING-02-L-04")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("PWH-FP-RUP2-RACK-ROLLING-02-L-04"); }} x="4711.9" y="-3116.7" width="275.94" height="60.603" opacity=".45454" strokeWidth="1.4557"/><rect id="PWH-FP-RUP2-RACK-ROLLING-02-L-03" className={getSlotClass("PWH-FP-RUP2-RACK-ROLLING-02-L-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("PWH-FP-RUP2-RACK-ROLLING-02-L-03"); }} x="4711.9" y="-3045.9" width="275.94" height="92.222" opacity=".45454"/><rect id="PWH-FP-RUP2-RACK-ROLLING-02-L-02" className={getSlotClass("PWH-FP-RUP2-RACK-ROLLING-02-L-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("PWH-FP-RUP2-RACK-ROLLING-02-L-02"); }} x="4711.9" y="-2935.7" width="275.94" height="92.222" opacity=".45454"/><rect id="PWH-FP-RUP2-RACK-ROLLING-02-L-01" className={getSlotClass("PWH-FP-RUP2-RACK-ROLLING-02-L-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("PWH-FP-RUP2-RACK-ROLLING-02-L-01"); }} x="4711.9" y="-2825.7" width="275.94" height="92.222" opacity=".45454"/></g></g></g></g></g></svg>

    </div>
  );
}
