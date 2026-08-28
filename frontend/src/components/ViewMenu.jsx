import React from 'react';

export default function ViewMenu({ isVisible, changeView }) {
  if (!isVisible) return null;

  return (
    <div id="view-menu" style={{ position: 'absolute', left: 0, top: '60px', width: '250px', background: '#222', color: 'white', height: 'calc(100vh - 60px)', padding: '10px', zIndex: 100 }}>
      <div id="menu-root">
        <button className="menu-item" onClick={() => changeView('/')} style={{ display: 'block', padding: '10px', color: '#00e676', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <i className="fas fa-home"></i> Dashboard Home
        </button>
        <button className="menu-item" onClick={() => changeView('/fedex')} style={{ display: 'block', padding: '10px', color: '#00e676', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
          <i className="fas fa-shipping-fast"></i> FedEx Tracking Engine
        </button>
        <button className="menu-item" onClick={() => changeView('/limbo')} style={{ display: 'block', padding: '10px', color: '#ba68c8', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
          <i className="fas fa-ghost"></i> Limbo Buffer Zone
        </button>
        <button className="menu-item" onClick={() => changeView('/staged')} style={{ display: 'block', padding: '10px', color: '#ff9800', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
          <i className="fas fa-truck-loading"></i> Outbound Staging Aggregator
        </button>
        <button className="menu-item" onClick={() => changeView('/maps')} style={{ display: 'block', padding: '10px', color: '#4dabff', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
          <i className="fas fa-map-marked-alt"></i> Facility Maps
        </button>
      </div>
    </div>
  );
}
