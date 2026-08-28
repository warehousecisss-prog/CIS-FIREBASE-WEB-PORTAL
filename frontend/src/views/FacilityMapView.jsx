import React, { useState } from 'react';
import Card from '../components/ui/Card';
import { useStore } from '../store/useStore';

// Import all 14 SVG Map Components
import Map_PP_ViewA from '../components/maps/Map_PP_ViewA';
import Map_PP_ViewB from '../components/maps/Map_PP_ViewB';
import Map_PP_ViewC from '../components/maps/Map_PP_ViewC';
import Map_PP_ViewD from '../components/maps/Map_PP_ViewD';
import Map_PWH_Floor from '../components/maps/Map_PWH_Floor';
import Map_PWH_RUP2_Rolling_1 from '../components/maps/Map_PWH_RUP2_Rolling_1';
import Map_PWH_RUP2_Rolling_2 from '../components/maps/Map_PWH_RUP2_Rolling_2';
import Map_PWH_ViewA from '../components/maps/Map_PWH_ViewA';
import Map_PWH_ViewA_Rolling from '../components/maps/Map_PWH_ViewA_Rolling';
import Map_PWH_ViewB from '../components/maps/Map_PWH_ViewB';
import Map_PWH_ViewC from '../components/maps/Map_PWH_ViewC';
import Map_SWH_Floor from '../components/maps/Map_SWH_Floor';
import Map_SWH_ViewA from '../components/maps/Map_SWH_ViewA';
import Map_SWH_ViewB from '../components/maps/Map_SWH_ViewB';

const MAP_COMPONENTS = {
  'Map_PWH_Floor': { name: 'Packing Warehouse - Main Floor', component: Map_PWH_Floor },
  'Map_PWH_ViewA': { name: 'Packing Warehouse - Rack View A', component: Map_PWH_ViewA },
  'Map_PWH_ViewA_Rolling': { name: 'Packing Warehouse - Rack View A (Rolling)', component: Map_PWH_ViewA_Rolling },
  'Map_PWH_ViewB': { name: 'Packing Warehouse - Rack View B', component: Map_PWH_ViewB },
  'Map_PWH_ViewC': { name: 'Packing Warehouse - Rack View C', component: Map_PWH_ViewC },
  'Map_PWH_RUP2_Rolling_1': { name: 'Packing Warehouse - RUP2 Rolling 1', component: Map_PWH_RUP2_Rolling_1 },
  'Map_PWH_RUP2_Rolling_2': { name: 'Packing Warehouse - RUP2 Rolling 2', component: Map_PWH_RUP2_Rolling_2 },
  
  'Map_SWH_Floor': { name: 'Storage Warehouse - Main Floor', component: Map_SWH_Floor },
  'Map_SWH_ViewA': { name: 'Storage Warehouse - Rack View A', component: Map_SWH_ViewA },
  'Map_SWH_ViewB': { name: 'Storage Warehouse - Rack View B', component: Map_SWH_ViewB },

  'Map_PP_ViewA': { name: 'Packing Warehouse - Pick & Pack Zone A', component: Map_PP_ViewA },
  'Map_PP_ViewB': { name: 'Packing Warehouse - Pick & Pack Zone B', component: Map_PP_ViewB },
  'Map_PP_ViewC': { name: 'Packing Warehouse - Pick & Pack Zone C', component: Map_PP_ViewC },
  'Map_PP_ViewD': { name: 'Packing Warehouse - Pick & Pack Zone D', component: Map_PP_ViewD },
};

export default function FacilityMapView() {
  const [selectedMapKey, setSelectedMapKey] = useState('Map_PWH_Floor');
  
  // Connect to Zustand store for map interactions
  const inventoryData = useStore(state => state.inventoryData);
  const heatmapMode = useStore(state => state.heatmapMode);
  const setSelectedSlot = useStore(state => state.setSelectedSlot);
  const fetchInventory = useStore(state => state.fetchInventory);
  
  React.useEffect(() => {
    // Load real data on mount
    if (!inventoryData) {
      fetchInventory();
    }
  }, [inventoryData, fetchInventory]);

  const handleSlotClick = (slotId) => {
    console.log("Clicked slot:", slotId);
    setSelectedSlot(slotId);
  };

  const SelectedMapComponent = MAP_COMPONENTS[selectedMapKey].component;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', paddingBottom: '20px' }}>
      
      {/* MAP SELECTOR HEADER */}
      <Card style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '1.25rem' }}>
            <i className="fas fa-map-marked-alt" style={{ color: '#4dabff', marginRight: '10px' }}></i>
            Interactive Facility Maps
          </h2>
          <p style={{ color: '#aaa', fontSize: '0.85rem', margin: 0 }}>
            Select a zone to view real-time inventory slots. Click any slot to view or edit details.
          </p>
        </div>
        
        <div style={{ minWidth: '250px' }}>
          <select 
            value={selectedMapKey} 
            onChange={(e) => setSelectedMapKey(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', background: '#111', color: 'white', border: '1px solid #4dabff', borderRadius: '6px', fontSize: '1rem', fontWeight: 'bold', outline: 'none', cursor: 'pointer' }}
          >
            {Object.entries(MAP_COMPONENTS).map(([key, mapInfo]) => (
              <option key={key} value={key}>{mapInfo.name}</option>
            ))}
          </select>
        </div>
      </Card>

      {/* MAP DISPLAY AREA */}
      <div id="map-container" style={{ flex: 1, background: '#000', borderRadius: '8px', border: '1px solid #333', overflow: 'hidden', position: 'relative' }}>
        
        {/* Heatmap Legend Overlay */}
        {heatmapMode && (
          <div style={{ position: 'absolute', bottom: '20px', left: '20px', background: 'rgba(20,20,20,0.85)', padding: '10px 15px', borderRadius: '6px', border: '1px solid #444', zIndex: 10 }}>
            <h4 style={{ margin: '0 0 8px 0', color: '#fff', fontSize: '0.85rem' }}>Aging Heatmap</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <div style={{ width: '14px', height: '14px', background: '#1b5e20', border: '1px solid #00e676' }}></div>
              <span style={{ color: '#aaa', fontSize: '0.75rem' }}>Fresh (&lt; 30 days)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <div style={{ width: '14px', height: '14px', background: '#e65100', border: '1px solid #ff9100' }}></div>
              <span style={{ color: '#aaa', fontSize: '0.75rem' }}>Mid (31 - 90 days)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '14px', height: '14px', background: '#b71c1c', border: '1px solid #ff1744' }}></div>
              <span style={{ color: '#aaa', fontSize: '0.75rem' }}>Stale (&gt; 90 days)</span>
            </div>
          </div>
        )}

        <div className="map-view" style={{ width: '100%', height: '100%', padding: '20px', boxSizing: 'border-box', overflow: 'auto' }}>
          <SelectedMapComponent 
            inventoryMap={inventoryData} 
            heatmapMode={heatmapMode} 
            onSlotClick={handleSlotClick} 
          />
        </div>
      </div>
      
    </div>
  );
}
