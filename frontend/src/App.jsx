import { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { useStore } from './store/useStore';
import './App.css';
import TopNav from './components/TopNav';
import ViewMenu from './components/ViewMenu';
import SidePanel from './components/SidePanel';
import DashboardView from './views/DashboardView';
import FedExView from './views/FedExView';
import LimboView from './views/LimboView';
import StagedView from './views/StagedView';
import TrelloInjectorView from './views/TrelloInjectorView';
import FacilityMapView from './views/FacilityMapView';

function App() {
  const isMenuOpen = useStore(state => state.isMenuOpen);
  const isSidePanelOpen = useStore(state => state.isSidePanelOpen);
  const toggleMenu = useStore(state => state.toggleMenu);
  const closeMenu = useStore(state => state.closeMenu);
  const toggleSidePanel = useStore(state => state.toggleSidePanel);
  const closeSidePanel = useStore(state => state.closeSidePanel);
  const toggleHeatmapMode = useStore(state => state.toggleHeatmapMode);
  
  const navigate = useNavigate();

  const changeView = (viewPath) => {
    navigate(viewPath);
    closeMenu();
  };

  return (
    <div className="App" style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
      <TopNav 
        toggleViewMenu={toggleMenu} 
        changeView={changeView} 
        toggleHeatmapMode={toggleHeatmapMode} 
      />
      
      <div style={{ display: 'flex', flex: 1, position: 'relative', overflow: 'hidden' }}>
        <ViewMenu isVisible={isMenuOpen} changeView={changeView} />
        
        <main id="main-container" style={{ flex: 1, padding: '20px', color: 'white', overflowY: 'auto' }}>
          <Routes>
            <Route path="/" element={<DashboardView />} />
            <Route path="/fedex" element={<FedExView />} />
            <Route path="/limbo" element={<LimboView />} />
            <Route path="/staged" element={<StagedView />} />
            <Route path="/trello-injector" element={<TrelloInjectorView />} />
            <Route path="/maps" element={<FacilityMapView />} />
            <Route path="*" element={<div><h2>404 Not Found</h2></div>} />
          </Routes>
        </main>

        <SidePanel isVisible={isSidePanelOpen} closeDrawer={closeSidePanel} />
      </div>
    </div>
  );
}

export default App;
