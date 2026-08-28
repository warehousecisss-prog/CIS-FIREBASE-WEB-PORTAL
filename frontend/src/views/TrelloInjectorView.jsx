import React, { useState, useEffect } from 'react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataGrid from '../components/ui/DataGrid';
import { API } from '../api';

export default function TrelloInjectorView() {
  const [boards, setBoards] = useState([]);
  const [lists, setLists] = useState([]);
  const [cards, setCards] = useState([]);
  
  const [selectedBoard, setSelectedBoard] = useState('');
  const [selectedList, setSelectedList] = useState('');
  const [selectedCard, setSelectedCard] = useState('');

  const [poLines, setPoLines] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);

  // New Feature State: Email Notifications
  const [notifyEmails, setNotifyEmails] = useState('');
  const [ccEmails, setCcEmails] = useState('');

  // Dummy fetch for boards - will connect to API later
  useEffect(() => {
    // API.getTrelloBoards().then(setBoards);
    setBoards([{ id: 'b1', name: 'Purchase Orders' }, { id: 'b2', name: 'Inbound Freight' }]);
  }, []);

  const handleBoardChange = (e) => {
    const boardId = e.target.value;
    setSelectedBoard(boardId);
    setSelectedList('');
    setSelectedCard('');
    
    // Auto-populate default email CC based on board
    if (boardId === 'b1') {
      setNotifyEmails('purchasing@cis.local');
      setCcEmails('warehouse@cis.local');
    } else {
      setNotifyEmails('receiving@cis.local');
      setCcEmails('');
    }

    // Dummy fetch lists
    if (boardId) {
      setLists([{ id: 'l1', name: 'Ordered' }, { id: 'l2', name: 'In Transit' }]);
    } else {
      setLists([]);
    }
  };

  const handleListChange = (e) => {
    const listId = e.target.value;
    setSelectedList(listId);
    setSelectedCard('');

    // Dummy fetch cards
    if (listId) {
      setCards([{ id: 'c1', name: 'PO 3585 - Custom Parts' }]);
    } else {
      setCards([]);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    setStatusMessage({ type: 'info', text: 'Uploading and parsing PDF...' });

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Data = event.target.result.split(',')[1];
        
        try {
          const res = await API.processUploadedPOFile({
            base64Data,
            fileName: file.name
          });

          if (res.success) {
            setPoLines(res.data.lineItems || []);
            setStatusMessage({ type: 'success', text: `Successfully parsed PO: ${res.data.poNumber}` });
          } else {
            setStatusMessage({ type: 'error', text: res.message });
          }
        } catch (err) {
          setStatusMessage({ type: 'error', text: 'Error calling parsing API: ' + err.message });
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'Failed to read file.' });
    } finally {
      setIsUploading(false);
    }
  };

  const submitInjection = async () => {
    if (!selectedBoard || (!selectedCard && poLines.length === 0)) return;
    
    setStatusMessage({ type: 'info', text: 'Injecting PO into Trello...' });
    
    // TODO: Connect to backend injection endpoint, passing the email config
    const payload = {
      boardId: selectedBoard,
      listId: selectedList,
      cardId: selectedCard,
      lineItems: poLines,
      emailConfig: {
        to: notifyEmails,
        cc: ccEmails
      }
    };
    
    setTimeout(() => {
      setStatusMessage({ type: 'success', text: `Successfully injected ${poLines.length} items and notified ${notifyEmails}!` });
      setPoLines([]);
    }, 1000);
  };

  const columns = [
    { header: 'Part Number', accessor: 'partNumber' },
    { header: 'Canonical SKU', accessor: 'canonicalSku' },
    { header: 'Description', accessor: 'description' },
    { header: 'Qty', accessor: 'qty' }
  ];

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ margin: 0 }}>Trello PO Injector</h1>
          <p style={{ color: '#aaa', margin: '4px 0 0 0' }}>Extract QuickBooks PDFs and inject directly into Trello.</p>
        </div>
      </div>

      <Card style={{ marginBottom: '24px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px' }}>1. Upload QuickBooks PO PDF</h3>
        <div 
          style={{ border: '2px dashed #0079bf', borderRadius: '8px', padding: '32px', textAlign: 'center', cursor: 'pointer', background: 'rgba(0,121,191,0.05)' }}
          onClick={() => document.getElementById('po-upload').click()}
        >
          <p style={{ fontWeight: 'bold', margin: '0 0 8px 0' }}>Click or Drop PDF Here</p>
          <p style={{ color: '#aaa', margin: 0, fontSize: '0.85rem' }}>Auto-extracts PO #, Vendor, SKUs, and Freight Mode</p>
          <input id="po-upload" type="file" accept="application/pdf" style={{ display: 'none' }} onChange={handleFileUpload} />
        </div>
      </Card>

      {statusMessage && (
        <div style={{ padding: '12px', borderRadius: '6px', marginBottom: '24px', background: statusMessage.type === 'error' ? 'rgba(235,90,70,0.2)' : statusMessage.type === 'success' ? 'rgba(97,189,79,0.2)' : 'rgba(0,121,191,0.2)', border: `1px solid ${statusMessage.type === 'error' ? '#eb5a46' : statusMessage.type === 'success' ? '#61bd4f' : '#0079bf'}`, color: '#fff' }}>
          {statusMessage.text}
        </div>
      )}

      <Card style={{ marginBottom: '24px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px' }}>2. Destination Routing</h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '8px', textTransform: 'uppercase' }}>Trello Board</label>
            <select style={{ width: '100%', padding: '10px', background: '#1a1a1a', color: 'white', border: '1px solid #333', borderRadius: '4px' }} value={selectedBoard} onChange={handleBoardChange}>
              <option value="">-- Choose a Board --</option>
              {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '8px', textTransform: 'uppercase' }}>Trello List</label>
            <select disabled={!selectedBoard} style={{ width: '100%', padding: '10px', background: '#1a1a1a', color: 'white', border: '1px solid #333', borderRadius: '4px' }} value={selectedList} onChange={handleListChange}>
              <option value="">-- Choose a List --</option>
              {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '8px', textTransform: 'uppercase' }}>Link to Existing Card (Optional)</label>
          <div style={{ display: 'flex', gap: '12px' }}>
            <select disabled={!selectedList} style={{ flex: 1, padding: '10px', background: '#1a1a1a', color: 'white', border: '1px solid #333', borderRadius: '4px' }} value={selectedCard} onChange={e => setSelectedCard(e.target.value)}>
              <option value="">-- Create New Card Automatically --</option>
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: '24px', border: '1px solid #0079bf', background: 'rgba(0,121,191,0.05)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '8px' }}>3. Automation & Email Notifications</h3>
        <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '16px' }}>Emails will be sent when this PO is successfully uploaded or when marked delivered.</p>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '8px', textTransform: 'uppercase' }}>Send Notifications To</label>
            <input type="email" value={notifyEmails} onChange={e => setNotifyEmails(e.target.value)} style={{ width: '100%', padding: '10px', background: '#1a1a1a', color: 'white', border: '1px solid #333', borderRadius: '4px' }} placeholder="e.g. purchasing@cis.local" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '8px', textTransform: 'uppercase' }}>CC</label>
            <input type="text" value={ccEmails} onChange={e => setCcEmails(e.target.value)} style={{ width: '100%', padding: '10px', background: '#1a1a1a', color: 'white', border: '1px solid #333', borderRadius: '4px' }} placeholder="e.g. warehouse@cis.local" />
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: '24px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px' }}>4. Parsed Line Items</h3>
        <DataGrid columns={columns} data={poLines} />
      </Card>

      <Button variant="primary" style={{ width: '100%', padding: '14px', fontSize: '1.1rem' }} onClick={submitInjection} disabled={isUploading || poLines.length === 0}>
        Commit PO to Trello Workflow
      </Button>
    </div>
  );
}
