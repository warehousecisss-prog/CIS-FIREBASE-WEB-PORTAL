import { create } from 'zustand';
import { API } from '../api';

export const useStore = create((set, get) => ({
  // Core UI State
  isMenuOpen: false,
  isSidePanelOpen: false,
  heatmapMode: false,
  theme: 'dark', // match legacy default

  // Core Data State
  inventoryData: null,
  logisticsData: null,
  trelloBoards: [],
  userEmail: '',
  selectedSlotId: null,

  // Actions
  toggleMenu: () => set((state) => ({ isMenuOpen: !state.isMenuOpen })),
  closeMenu: () => set({ isMenuOpen: false }),
  
  toggleSidePanel: () => set((state) => ({ isSidePanelOpen: !state.isSidePanelOpen })),
  closeSidePanel: () => set({ isSidePanelOpen: false, selectedSlotId: null }),

  setSelectedSlot: (slotId) => set({ selectedSlotId: slotId, isSidePanelOpen: true }),

  toggleHeatmapMode: () => set((state) => ({ heatmapMode: !state.heatmapMode })),

  setInventoryData: (data) => set({ inventoryData: data }),
  setLogisticsData: (data) => set({ logisticsData: data }),
  setUserEmail: (email) => set({ userEmail: email }),

  fetchInventory: async () => {
    try {
      const data = await API.getInventory();
      set({ inventoryData: data });
    } catch (e) {
      console.error("Failed to fetch inventory from API", e);
    }
  },

  fetchLogisticsData: async () => {
    try {
      const data = await API.getLogisticsDashboardData();
      set({ logisticsData: data });
    } catch (e) {
      console.error("Failed to fetch logistics data from API", e);
    }
  },

  // Dummy Fetch for Testing
  fetchDummyInventory: () => set({
    inventoryData: {
      'SWH-RACKA-SEC-04-L-01': { status: 'Occupied', sku: 'WIDGET-X-100', qty: 45, agingDays: 12 },
      'SWH-RACKA-SEC-04-L-02': { status: 'Staged', sku: 'GIZMO-Y-200', qty: 10, agingDays: 45 },
      'SWH-RACKA-SEC-04': { status: 'Reserved', sku: 'BULK-PALLET-A', qty: 1, agingDays: 100 },
      'PWH-STAGING-01': { status: 'Labeled', sku: 'PACK-BOX-50', qty: 5, agingDays: 2 }
    }
  })
}));
