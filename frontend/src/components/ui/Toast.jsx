import React from 'react';

// A simple global toast would typically use Zustand or Context to manage state.
// For now, this is a stateless presentational Toast.
export default function Toast({ message, type = 'info', isVisible, onClose }) {
  if (!isVisible) return null;

  const bg = type === 'error' ? '#c62828' : type === 'success' ? '#2e7d32' : '#333';

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: bg,
      color: '#fff',
      padding: '12px 24px',
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      gap: '12px'
    }}>
      <span>{message}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.2rem' }}>&times;</button>
    </div>
  );
}
