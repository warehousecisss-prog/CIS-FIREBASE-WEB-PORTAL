import React from 'react';
import Card from '../components/ui/Card';

export default function StagedView() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <Card>
        <h2><i className="fas fa-truck-loading" style={{ color: '#ff9800', marginRight: '10px' }}></i> Outbound Staging Aggregator</h2>
        <p style={{ color: '#aaa' }}>This view is a placeholder for the outbound staging aggregator.</p>
      </Card>
    </div>
  );
}
