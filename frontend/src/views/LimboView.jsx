import React from 'react';
import Card from '../components/ui/Card';

export default function LimboView() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <Card>
        <h2><i className="fas fa-ghost" style={{ color: '#ba68c8', marginRight: '10px' }}></i> Limbo Buffer Zone</h2>
        <p style={{ color: '#aaa' }}>This view is a placeholder for the Limbo buffer area.</p>
      </Card>
    </div>
  );
}
