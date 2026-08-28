import React from 'react';


export default function TopNav({ toggleViewMenu, changeView, toggleHeatmapMode }) {
  return (
    <div id="top-ui" style={{ display: 'flex', alignItems: 'center', padding: '10px', background: '#333', color: 'white' }}>
      <button id="menu-btn" onClick={toggleViewMenu} style={{ marginRight: '15px' }}>
        <i className="fas fa-bars"></i> Menu
      </button>
      
      <div className="logo-home-btn" onClick={() => changeView('/')} title="Return to Main Dashboard" style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', marginRight: '15px' }}>
        <h2 style={{ margin: 0, color: '#ec2127', fontSize: '1.3rem', whiteSpace: 'nowrap' }}>CIS Portal</h2>
      </div>

      <div id="search-container" style={{ position: 'relative', display: 'flex', flex: 1, maxWidth: '500px' }}>
        <input 
          type="text" 
          id="inventory-search" 
          placeholder="Search SKU Globally..." 
          style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #444', background: '#252525', color: 'white', outline: 'none' }}
        />
      </div>
      
      <button id="trello-po-btn" onClick={() => changeView('/trello-injector')} className="trello-po-btn" title="Open Trello PO Injector" style={{ background: '#222', color: '#0079bf', border: '1px solid #444', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', marginLeft: '6px' }}>
        <i className="fas fa-tasks"></i> <span className="btn-text">Trello PO</span>
      </button>

      <button id="shipping-estimate-btn" onClick={() => alert('Shipping Estimate functionality coming soon!')} className="shipping-estimate-btn" title="Shipping Estimate Calculator" style={{ background: '#222', color: '#ff9800', border: '1px solid #444', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', marginLeft: '6px' }}>
        <i className="fas fa-calculator"></i> <span className="btn-text">Shipping Estimate</span>
      </button>
      
      <button id="heatmap-toggle-btn" className="heatmap-toggle-btn" onClick={toggleHeatmapMode} style={{ marginLeft: '6px' }}>
        <i className="fas fa-fire"></i> <span className="btn-text">Heatmap: OFF</span>
      </button>
    </div>
  );
}
