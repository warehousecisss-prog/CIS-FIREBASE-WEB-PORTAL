import React from 'react';

export default function DataGrid({ columns, data, onRowClick }) {
  return (
    <div className="table-wrapper">
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
        <thead style={{ background: '#1a1a1a', borderBottom: '2px solid #333' }}>
          <tr>
            {columns.map((col, idx) => (
              <th key={idx} style={{ padding: '12px', color: '#aaa', fontWeight: 'bold' }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                No data available
              </td>
            </tr>
          ) : (
            data.map((row, rowIdx) => (
              <tr 
                key={rowIdx} 
                className="logistics-row" 
                style={{ borderBottom: '1px solid #2a2a2a', cursor: onRowClick ? 'pointer' : 'default' }}
                onClick={() => onRowClick && onRowClick(row)}
              >
                {columns.map((col, colIdx) => (
                  <td key={colIdx} style={{ padding: '12px', color: '#e0e0e0' }}>
                    {col.render ? col.render(row) : row[col.accessor]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
