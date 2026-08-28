import React, { useState, useEffect } from 'react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataGrid from '../components/ui/DataGrid';
import { API } from '../api';

export default function DashboardView() {
  const [activeTab, setActiveTab] = useState('inbound'); // 'inbound' or 'outbound'
  const [logisticsData, setLogisticsData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Filters
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    chain: 'ALL',
    origin: 'ALL',
    sku: '',
    store: '',
    showCompleted: false
  });

  useEffect(() => {
    // Fetch data whenever tab changes
    const loadData = async () => {
      setIsLoading(true);
      try {
        // const data = await API.getLogisticsData(activeTab);
        // setLogisticsData(data);
        
        // Dummy data for now
        setTimeout(() => {
          setLogisticsData([
            { id: 1, entityName: 'PO 1234 - Supplier A', scheduledDate: '2026-08-20', status: 'In Transit', rollupStatus: 'On Time' },
            { id: 2, entityName: 'PO 1235 - Supplier B', scheduledDate: '2026-08-25', status: 'Ordered', rollupStatus: 'Delayed' }
          ]);
          setIsLoading(false);
        }, 500);
      } catch (err) {
        console.error("Failed to fetch logistics data", err);
        setIsLoading(false);
      }
    };
    
    loadData();
  }, [activeTab]);

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters({
      startDate: '',
      endDate: '',
      chain: 'ALL',
      origin: 'ALL',
      sku: '',
      store: '',
      showCompleted: false
    });
  };

  // The actual filtering would apply to the logisticsData before passing to DataGrid
  const filteredData = logisticsData.filter(item => {
    if (!filters.showCompleted && item.status === 'Completed') return false;
    if (filters.sku && !item.entityName.toLowerCase().includes(filters.sku.toLowerCase())) return false;
    return true;
  });

  const columns = [
    { header: 'Entity / PO Title', accessor: 'entityName' },
    { header: 'Scheduled Date', accessor: 'scheduledDate' },
    { header: 'Status', accessor: 'status' },
    { header: 'Rollup Status', accessor: 'rollupStatus' }
  ];

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', paddingBottom: '60px' }}>
      
      {/* 1. TOP LOGISTICS SUB-NAVIGATION TABS */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', background: '#111', padding: '8px', borderRadius: '8px', border: '1px solid #222' }}>
        <button 
          onClick={() => setActiveTab('inbound')}
          style={{ flex: 1, padding: '12px', background: activeTab === 'inbound' ? '#0088ff' : '#222', color: activeTab === 'inbound' ? 'white' : '#aaa', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem', transition: 'all 0.2s' }}
        >
          <i className="fas fa-ship" style={{ marginRight: '8px' }}></i> Inbound Receiving POs
        </button>
        <button 
          onClick={() => setActiveTab('outbound')}
          style={{ flex: 1, padding: '12px', background: activeTab === 'outbound' ? '#222' : '#0088ff', color: activeTab === 'outbound' ? '#aaa' : 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '0.95rem', transition: 'all 0.2s' }}
        >
          <i className="fas fa-truck-loading" style={{ marginRight: '8px' }}></i> Outbound Store Shipments
        </button>
      </div>

      {/* 2. DYNAMIC SUMMARY METRIC BADGES */}
      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {/* Placeholder for badges */}
        <Card style={{ flex: 1, textAlign: 'center', borderColor: '#0088ff' }}>
          <h3 style={{ margin: 0, color: '#0088ff', fontSize: '2rem' }}>12</h3>
          <p style={{ margin: 0, color: '#aaa', fontSize: '0.85rem' }}>Open POs</p>
        </Card>
        <Card style={{ flex: 1, textAlign: 'center', borderColor: '#00e676' }}>
          <h3 style={{ margin: 0, color: '#00e676', fontSize: '2rem' }}>5</h3>
          <p style={{ margin: 0, color: '#aaa', fontSize: '0.85rem' }}>In Transit</p>
        </Card>
      </div>

      {/* 3. INTERACTIVE FILTER BAR */}
      <Card style={{ marginBottom: '15px', padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', padding: '15px', background: '#141414', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#111', padding: '6px 10px', borderRadius: '6px', border: '1px solid #444' }}>
            <span style={{ color: '#888', fontSize: '0.8rem', fontWeight: 'bold' }}>FROM:</span>
            <input type="date" value={filters.startDate} onChange={e => handleFilterChange('startDate', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '0.85rem', outline: 'none' }} />
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#111', padding: '6px 10px', borderRadius: '6px', border: '1px solid #444' }}>
            <span style={{ color: '#888', fontSize: '0.8rem', fontWeight: 'bold' }}>TO:</span>
            <input type="date" value={filters.endDate} onChange={e => handleFilterChange('endDate', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '0.85rem', outline: 'none' }} />
          </div>

          <div style={{ minWidth: '170px' }}>
            <select value={filters.chain} onChange={e => handleFilterChange('chain', e.target.value)} style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', borderRadius: '6px', color: 'white', fontSize: '0.85rem', fontWeight: 'bold', outline: 'none', cursor: 'pointer' }}>
              <option value="ALL">All Chains / Brands (Master)</option>
            </select>
          </div>

          {activeTab === 'inbound' && (
            <div style={{ minWidth: '170px' }}>
              <select value={filters.origin} onChange={e => handleFilterChange('origin', e.target.value)} style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', borderRadius: '6px', color: 'white', fontSize: '0.85rem', fontWeight: 'bold', outline: 'none', cursor: 'pointer' }}>
                <option value="ALL">All Origins</option>
                <option value="LOCAL">Local Only</option>
                <option value="NONLOCAL">Non-Local Only (AUS/CA)</option>
              </select>
            </div>
          )}

          <div style={{ flex: 1, minWidth: '160px' }}>
            <input type="search" value={filters.sku} onChange={e => handleFilterChange('sku', e.target.value)} placeholder="Filter by SKU / Item Name..." style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', borderRadius: '6px', color: 'white', fontSize: '0.85rem', boxSizing: 'border-box', outline: 'none' }} />
          </div>

          <div style={{ flex: 1, minWidth: '140px' }}>
            <input type="search" value={filters.store} onChange={e => handleFilterChange('store', e.target.value)} placeholder="Filter Store / PO #..." style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', borderRadius: '6px', color: 'white', fontSize: '0.85rem', boxSizing: 'border-box', outline: 'none' }} />
          </div>

          <button onClick={resetFilters} style={{ background: '#333', color: '#fff', border: '1px solid #555', padding: '10px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem', transition: 'background 0.2s' }}>
            <i className="fas fa-undo"></i>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#222', padding: '10px 14px', borderRadius: '6px', border: '1px solid #444', color: '#fff', fontSize: '0.85rem', cursor: 'pointer' }}>
            <input type="checkbox" id="show-completed" checked={filters.showCompleted} onChange={e => handleFilterChange('showCompleted', e.target.checked)} style={{ cursor: 'pointer', transform: 'scale(1.2)' }} />
            <label htmlFor="show-completed" style={{ cursor: 'pointer', fontWeight: 'bold', marginBottom: 0 }}>Show Completed</label>
          </div>

          {activeTab === 'outbound' && (
            <button style={{ background: '#00e676', color: '#000', border: 'none', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <i className="fas fa-clipboard-list"></i> Shipping Report
            </button>
          )}

          {activeTab === 'inbound' && (
            <button style={{ background: '#0088ff', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <i className="fas fa-clipboard-check"></i> Inbound Report
            </button>
          )}

        </div>

        {/* 4. MAIN LOGISTICS TABLE */}
        <div style={{ background: '#111', maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
          {isLoading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '8px', display: 'block' }}></i>
              Syncing Logistics Control Tower...
            </div>
          ) : (
            <DataGrid columns={columns} data={filteredData} />
          )}
        </div>
      </Card>

      {/* 5. LIVE RECORD COUNTER / FOOTER BAR */}
      <div style={{ marginTop: '12px', padding: '12px 18px', background: '#161616', border: '1px solid #282828', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <span style={{ color: '#4dabff', fontWeight: 'bold', fontSize: '0.9rem' }}>
          <i className="fas fa-list-ol" style={{ marginRight: '6px' }}></i> Showing {filteredData.length} Shipments
        </span>
        <span style={{ color: '#777', fontSize: '0.8rem' }}>
          * Table is vertically scrollable. Use filters above to narrow results.
        </span>
      </div>

    </div>
  );
}
