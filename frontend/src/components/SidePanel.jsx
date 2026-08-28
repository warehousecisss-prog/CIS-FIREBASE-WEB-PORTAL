import React from 'react';
import { useStore } from '../store/useStore';
import Button from './ui/Button';

export default function SidePanel({ isVisible, closeDrawer }) {
  const selectedSlotId = useStore(state => state.selectedSlotId);
  const inventoryData = useStore(state => state.inventoryData);

  if (!isVisible) return null;

  const slotData = selectedSlotId && inventoryData ? inventoryData[selectedSlotId] : null;

  return (
    <div id="side-panel" className="drawer open" style={{ position: 'absolute', right: 0, top: '60px', width: '350px', background: '#1a1a1a', color: 'white', height: 'calc(100vh - 60px)', borderLeft: '1px solid #444', zIndex: 90, display: 'flex', flexDirection: 'column' }}>
      
      {/* Header */}
      <div className="drawer-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#252525', padding: '16px', borderBottom: '1px solid #333' }}>
        <h2 id="loc-title" style={{ margin: 0, fontSize: '1.2rem', color: '#4dabff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selectedSlotId || "Select Location"}
        </h2>
        <button className="close-drawer" onClick={closeDrawer} style={{ background: 'none', border: 'none', color: '#888', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
      </div>

      {/* Body */}
      <div className="drawer-content-wrapper" style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>
        
        {!selectedSlotId ? (
          <p style={{ color: '#888', textAlign: 'center', marginTop: '40px' }}>Select a location on the map to see inventory details.</p>
        ) : !slotData ? (
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            <i className="fas fa-box-open" style={{ fontSize: '3rem', color: '#333', marginBottom: '16px' }}></i>
            <h3 style={{ color: '#aaa', margin: 0 }}>Slot is Empty</h3>
            <p style={{ color: '#666', fontSize: '0.85rem' }}>No inventory currently assigned here.</p>
            
            <Button variant="primary" style={{ marginTop: '20px', width: '100%' }}>
              <i className="fas fa-plus"></i> Receive Inventory Here
            </Button>
          </div>
        ) : (
          <div>
            {/* Status Badge */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <span style={{ 
                background: slotData.status === 'Occupied' ? '#ec2127' : slotData.status === 'Staged' ? '#d84315' : slotData.status === 'Reserved' ? '#8e24aa' : '#2e7d32', 
                color: 'white', padding: '4px 10px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 'bold', textTransform: 'uppercase' 
              }}>
                {slotData.status}
              </span>
              <span style={{ color: '#888', fontSize: '0.8rem' }}><i className="fas fa-clock"></i> {slotData.agingDays} Days in Slot</span>
            </div>

            {/* SKU Card */}
            <div style={{ background: '#111', padding: '16px', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
              <p style={{ color: '#aaa', fontSize: '0.75rem', textTransform: 'uppercase', margin: '0 0 4px 0' }}>Stored SKU</p>
              <h3 style={{ margin: '0 0 16px 0', fontSize: '1.1rem', color: '#fff' }}>{slotData.sku}</h3>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <p style={{ color: '#aaa', fontSize: '0.75rem', textTransform: 'uppercase', margin: 0 }}>Quantity</p>
                <div style={{ display: 'flex', alignItems: 'center', background: '#000', borderRadius: '6px', border: '1px solid #444', overflow: 'hidden' }}>
                  <button style={{ background: '#252525', color: '#fff', border: 'none', padding: '8px 12px', cursor: 'pointer' }}>-</button>
                  <span style={{ width: '40px', textAlign: 'center', fontWeight: 'bold' }}>{slotData.qty}</span>
                  <button style={{ background: '#252525', color: '#fff', border: 'none', padding: '8px 12px', cursor: 'pointer' }}>+</button>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <h4 style={{ color: '#aaa', margin: '0 0 12px 0', fontSize: '0.85rem', textTransform: 'uppercase' }}>Quick Actions</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Button variant="secondary" style={{ justifyContent: 'flex-start' }}>
                <i className="fas fa-truck-loading" style={{ width: '20px' }}></i> Pick / Move to Staging
              </Button>
              <Button variant="secondary" style={{ justifyContent: 'flex-start' }}>
                <i className="fas fa-exchange-alt" style={{ width: '20px' }}></i> Transfer to another Slot
              </Button>
              <Button variant="secondary" style={{ justifyContent: 'flex-start', color: '#ff5252' }}>
                <i className="fas fa-trash-alt" style={{ width: '20px' }}></i> Remove / Adjust Out
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
