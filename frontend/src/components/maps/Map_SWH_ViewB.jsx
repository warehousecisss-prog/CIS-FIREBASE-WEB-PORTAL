import React from 'react';

export default function Map_SWH_ViewB({ inventoryMap, heatmapMode, onSlotClick }) {
  
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
      <svg id="svg1" width="100%" height="100%" version="1.1" preserveAspectRatio="xMidYMid meet" viewBox="0 0 151.5 152.4" xmlSpace="preserve" xmlns="http://www.w3.org/2000/svg"><defs id="defs45"><clipPath id="clipPath76"><path id="path38" d="m0 0h13200v10200h-13200z" clipRule="evenodd"/></clipPath><clipPath id="clipPath82"><path id="path82" d="m0 0h13200v10200h-13200z" clipRule="evenodd"/></clipPath></defs><g id="g1"><rect id="RACK_B_BG" transform="translate(-259.57 -17.962)" x="259.57" y="17.962" width="151.5" height="152.4" fill="#fff" strokeWidth=".28927"/><g id="g2" fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="12"><path id="path67" transform="matrix(.021167 0 0 .021167 -137.72 -8.3255)" d="m9861.6 7487.2h-123.89v-278.74h123.89m774.31 123.87c34.21 0 61.943-27.733 61.943-61.943s-27.733-61.943-61.943-61.943h-77.428v278.74h77.428c42.763 0 77.429-34.666 77.429-77.428s-34.666-77.428-77.429-77.428zm-681.37-123.89 61.942 278.74 61.943-185.83 61.943 185.83 61.942-278.74m-464.57 123.89h92.914m-185.83 154.86v-278.74m-278.74 0 92.914 278.74 92.914-278.74m1084 123.89h-77.428" clipPath="url(#clipPath82)"/><path id="path3" transform="matrix(.021166 0 0 .021166 10.113 -8.321)" d="m3101 6721v-4014m-2801 4014v-4014m5602 4014v-4014m-1400 4014v-4014m1400 4014h-5602m5602 0h-5602m5602-1951h-5602m5602-1952h-5602m1400 3903v-4014" clipPath="url(#clipPath76)" strokeWidth="25.001"/></g></g><g id="SWH-VIEWB" className={getSlotClass("SWH-VIEWB")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-VIEWB"); }} transform="translate(-.00043044 .0010001)"><g id="g5" fill="#0ff" strokeWidth=".20397"><g id="SWH-RACKB-SEC-04" className={getSlotClass("SWH-RACKB-SEC-04")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-04"); }}><rect id="SWH-RACKB-SEC-04-L-01" className={getSlotClass("SWH-RACKB-SEC-04-L-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-04-L-01"); }} x="107.47" y="94.797" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-04-L-02" className={getSlotClass("SWH-RACKB-SEC-04-L-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-04-L-02"); }} x="107.31" y="53.501" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-04-L-03" className={getSlotClass("SWH-RACKB-SEC-04-L-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-04-L-03"); }} x="107.31" y="12.206" width="25.5" height="36.964" opacity=".37818"/></g><g id="SWH-RACKB-SEC-03" className={getSlotClass("SWH-RACKB-SEC-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-03"); }}><rect id="SWH-RACKB-SEC-03-L-01" className={getSlotClass("SWH-RACKB-SEC-03-L-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-03-L-01"); }} x="78.05" y="94.797" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-03-L-02" className={getSlotClass("SWH-RACKB-SEC-03-L-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-03-L-02"); }} x="77.89" y="53.501" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-03-L-03" className={getSlotClass("SWH-RACKB-SEC-03-L-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-03-L-03"); }} x="77.89" y="12.206" width="25.5" height="36.964" opacity=".37818"/></g><g id="SWH-RACKB-SEC-02" className={getSlotClass("SWH-RACKB-SEC-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-02"); }}><rect id="SWH-RACKB-SEC-02-L-01" className={getSlotClass("SWH-RACKB-SEC-02-L-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-02-L-01"); }} x="48.1" y="94.797" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-02-L-02" className={getSlotClass("SWH-RACKB-SEC-02-L-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-02-L-02"); }} x="47.94" y="53.501" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-02-L-03" className={getSlotClass("SWH-RACKB-SEC-02-L-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-02-L-03"); }} x="47.94" y="12.206" width="25.5" height="36.964" opacity=".37818"/></g><g id="SWH-RACKB-SEC-01" className={getSlotClass("SWH-RACKB-SEC-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-01"); }}><rect id="SWH-RACKB-SEC-01-L-01" className={getSlotClass("SWH-RACKB-SEC-01-L-01")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-01-L-01"); }} x="18.68" y="94.797" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-01-L-02" className={getSlotClass("SWH-RACKB-SEC-01-L-02")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-01-L-02"); }} x="18.52" y="53.501" width="25.5" height="36.964" opacity=".37818"/><rect id="SWH-RACKB-SEC-01-L-03" className={getSlotClass("SWH-RACKB-SEC-01-L-03")} onClick={(e) => { e.stopPropagation(); onSlotClick && onSlotClick("SWH-RACKB-SEC-01-L-03"); }} x="18.52" y="12.206" width="25.5" height="36.964" opacity=".37818"/></g></g></g></svg>

    </div>
  );
}
