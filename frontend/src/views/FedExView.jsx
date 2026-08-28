import React, { useState } from 'react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataGrid from '../components/ui/DataGrid';

export default function FedExView() {
  const [isAccordionOpen, setIsAccordionOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [search, setSearch] = useState('');
  const [hideDelivered, setHideDelivered] = useState(true);
  
  // Dummy data
  const [trackingData, setTrackingData] = useState([
    { id: 1, entityName: 'Burlington Store 1145', direction: 'Outbound', masterTracking: '875021925761', rollupStatus: 'In Transit' },
    { id: 2, entityName: 'MAR 281', direction: 'Outbound', masterTracking: '873541339477', rollupStatus: 'Delivered' }
  ]);

  const handleBulkStage = () => {
    alert('Processed bulk paste:\n' + bulkText);
    setIsAccordionOpen(false);
    setBulkText('');
  };

  const filteredData = trackingData.filter(item => {
    if (hideDelivered && item.rollupStatus === 'Delivered') return false;
    if (search && !item.entityName.toLowerCase().includes(search.toLowerCase()) && !item.masterTracking.includes(search)) return false;
    return true;
  });

  const columns = [
    { header: 'Store / PO Source', accessor: 'entityName' },
    { header: 'Direction', accessor: 'direction' },
    { header: 'Master Tracking #', accessor: 'masterTracking' },
    { header: 'Discovery Status', accessor: 'rollupStatus' }
  ];

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', paddingBottom: '60px' }}>
      
      {/* 1. HEADER */}
      <Card style={{ borderLeft: '5px solid #00e676', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '1.25rem' }}>
            <i className="fas fa-shipping-fast" style={{ color: '#00e676', marginRight: '10px' }}></i>
            FedEx Tracking Engine & Master Ledger
          </h2>
          <p style={{ color: '#aaa', fontSize: '0.85rem', margin: 0 }}>
            Live multi-piece discovery and tracking for all outbound store shipments and inbound POs.
          </p>
        </div>
        <Button variant="secondary" onClick={() => alert('Syncing...')}>
          <i className="fas fa-sync" style={{ marginRight: '6px' }}></i> Sync FedEx Ledger
        </Button>
      </Card>

      {/* 2. ACCORDION */}
      <Card style={{ marginBottom: '20px', padding: 0, overflow: 'hidden' }}>
        <div 
          onClick={() => setIsAccordionOpen(!isAccordionOpen)}
          style={{ background: '#161616', padding: '14px 20px', color: '#00e676', fontWeight: 'bold', fontSize: '0.95rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>
            <i className="fas fa-plus-circle" style={{ marginRight: '8px' }}></i>
            Stage New Store Orders (Bulk Paste & Formatting Instructions)
          </span>
          <span style={{ fontSize: '0.75rem', color: '#888', fontWeight: 'normal' }}>
            Click to expand/collapse tool
          </span>
        </div>
        
        {isAccordionOpen && (
          <div style={{ padding: '20px', borderTop: '1px solid #282828', background: '#0e0e0e' }}>
            <div style={{ background: '#181818', border: '1px solid #333', borderLeft: '4px solid #4dabff', padding: '12px 16px', borderRadius: '6px', fontSize: '0.85rem', color: '#ccc', marginBottom: '16px' }}>
              <strong style={{ color: '#4dabff', display: 'block', marginBottom: '6px' }}>
                <i className="fas fa-info-circle" style={{ marginRight: '6px' }}></i> Quick Paste Formatting Instructions:
              </strong>
              <span style={{ display: 'block', marginBottom: '4px' }}>• Paste directly from Excel or plain text (Store / Chain Name + Number + Master Tracking #).</span>
              <span style={{ display: 'block', fontFamily: 'monospace', color: '#aaa' }}>• Example 1: Burlington Store 1145 [Tab] 875021925761</span>
              <span style={{ display: 'block', fontFamily: 'monospace', color: '#aaa' }}>• Example 2: MAR 281 - 873541339477</span>
            </div>

            <label style={{ color: '#e0e0e0', fontWeight: 'bold', fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>
              <i className="fas fa-clipboard-list" style={{ color: '#00e676', marginRight: '6px' }}></i>
              Paste Store Orders Here:
            </label>
            <textarea 
              rows="4" 
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              placeholder="Paste store names and tracking numbers here..." 
              style={{ width: '100%', padding: '12px', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', color: '#fff', fontFamily: 'monospace', fontSize: '0.9rem', boxSizing: 'border-box', outline: 'none', resize: 'vertical', marginBottom: '14px' }}
            />
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <span style={{ color: '#777', fontSize: '0.8rem' }}>
                * Automatically deduplicates against existing records in 'Multi Piece Tracking'.
              </span>
              <Button style={{ background: '#00e676', color: '#000', border: 'none' }} onClick={handleBulkStage}>
                <i className="fas fa-layer-group" style={{ marginRight: '8px' }}></i> Stage Store Orders
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* 3. MASTER TRACKING LEDGER */}
      <Card style={{ marginBottom: '12px', padding: 0, overflow: 'hidden' }}>
        <div style={{ background: '#1c1c1c', padding: '14px 20px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <h3 style={{ color: '#4dabff', margin: 0, fontSize: '1rem' }}>
            <i className="fas fa-list-alt" style={{ marginRight: '8px' }}></i> Master Tracking Ledger
          </h3>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' }}>
            <div style={{ position: 'relative', minWidth: '220px', flex: 1, maxWidth: '400px' }}>
              <i className="fas fa-search" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#555', fontSize: '0.8rem' }}></i>
              <input 
                type="search" 
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter store, PO, or tracking #..." 
                style={{ width: '100%', padding: '8px 10px 8px 32px', background: '#111', border: '1px solid #444', borderRadius: '6px', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box', outline: 'none' }}
              />
            </div>

            <label style={{ color: '#ccc', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={hideDelivered} onChange={e => setHideDelivered(e.target.checked)} style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#00e676' }} />
              <span>Hide Delivered</span>
            </label>
            <span style={{ color: '#555' }}>|</span>
            <span style={{ color: '#777', fontSize: '0.8rem' }}>Discovery: 10 Mins</span>
          </div>
        </div>
        
        <div style={{ maxHeight: 'calc(100vh - 290px)', minHeight: '380px', overflowY: 'auto' }}>
          <DataGrid columns={columns} data={filteredData} />
        </div>
      </Card>

      {/* 4. FOOTER */}
      <div style={{ padding: '12px 18px', background: '#161616', border: '1px solid #282828', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <span style={{ color: '#00e676', fontWeight: 'bold', fontSize: '0.85rem' }}>
          <i className="fas fa-list-ol" style={{ marginRight: '6px' }}></i> Showing {filteredData.length} Staged Master Tracking Numbers
        </span>
        <span style={{ color: '#777', fontSize: '0.8rem' }}>
          * Click any row to inspect individual child box tracking numbers.
        </span>
      </div>

    </div>
  );
}
