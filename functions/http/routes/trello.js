/**
 * Trello board / list / card routes -- everything TrelloInjector.html calls,
 * plus the two receiving-flow reads JS_Handlers.html shares with it.
 *
 * Path shape follows the Trello resource tree (boards -> lists -> cards) so a
 * reader can tell at a glance which id a route needs. Ids arrive as path
 * params on reads and in the body on writes.
 *
 * NOTE ON FAILURE SHAPE: Service_Read returns `{success:false, message}`, not
 * `{success:false, error}`. The wrapper normalises both -- see
 * functions/http/wrappers.js rule 2.
 */

const express = require('express');

const Service_Read = require('../../services/Service_Read');
const Service_Write = require('../../services/Service_Write');
const {runQuery, runMutation} = require('../wrappers');

const router = express.Router();

/* ------------------------------------------------------------------ reads */

// SRC: TrelloInjector.html:892 `.getTrelloBoards()`.
router.get('/trello/boards', runQuery('Trello boards', () => Service_Read.getTrelloBoards()));

// SRC: TrelloInjector.html:938,1326 `.getTrelloLists(boardId)`.
router.get('/trello/boards/:boardId/lists', runQuery('Trello lists', (req) => Service_Read.getTrelloLists(req.params.boardId)));

// SRC: TrelloInjector.html:947 `.getTrelloBoardLabels(boardId)`.
router.get('/trello/boards/:boardId/labels', runQuery('Trello board labels', (req) => Service_Read.getTrelloBoardLabels(req.params.boardId)));

// SRC: TrelloInjector.html:499 `.getInboundPoBoardLabels()`.
// Its own route rather than the caller resolving the inbound-PO board id
// first: getInboundPoBoardId_() reads config, and making the client supply
// that id would let a stale value in the browser point label edits at the
// wrong board.
router.get('/trello/inbound-po-board/labels', runQuery('Inbound PO board labels', () => Service_Read.getInboundPoBoardLabels()));

// SRC: TrelloInjector.html:983 `.getTrelloCardsByList(listId)`.
router.get('/trello/lists/:listId/cards', runQuery('Trello cards by list', (req) => Service_Read.getTrelloCardsByList(req.params.listId)));

// SRC: TrelloInjector.html:1047 `.getCardLabels(cardId)`.
router.get('/trello/cards/:cardId/labels', runQuery('Card labels', (req) => Service_Read.getCardLabels(req.params.cardId)));

// SRC: JS_Handlers.html:5494, TrelloInjector.html:1072
//      `.getExistingCardChecklist(cardId)`.
router.get('/trello/cards/:cardId/checklist', runQuery('Card checklist', (req) => Service_Read.getExistingCardChecklist(req.params.cardId)));

// SRC: TrelloInjector.html:1033 `.getCardShippingReference(cardId)`.
router.get('/trello/cards/:cardId/shipping-reference', runQuery('Card shipping reference', (req) => Service_Read.getCardShippingReference(req.params.cardId)));

/* -------------------------------------------------------------- mutations */

// SRC: TrelloInjector.html:1207 `.createTrelloCard(listId, cardName)`.
router.post('/trello/cards', runMutation('Create Trello card', (req) => {
  const {listId, cardName} = req.body;
  return Service_Read.createTrelloCard(listId, cardName);
}));

// SRC: TrelloInjector.html:1361 `.moveTrelloCard(cardId, listId, boardId)`.
router.post('/trello/cards/move', runMutation('Move Trello card', (req) => {
  const {cardId, idList, idBoard} = req.body;
  return Service_Read.moveTrelloCard(cardId, idList, idBoard);
}));

// SRC: TrelloInjector.html:1165 `.updateCardLabels(cardId, checked)`.
router.post('/trello/cards/labels', runMutation('Update card labels', (req) => {
  const {cardId, labelIds} = req.body;
  return Service_Read.updateCardLabels(cardId, labelIds);
}));

// SRC: TrelloInjector.html:1114 `.setCardShippingReference(cardId, value)`.
router.post('/trello/cards/shipping-reference', runMutation('Set card shipping reference', (req) => {
  const {cardId, referenceNumber} = req.body;
  return Service_Read.setCardShippingReference(cardId, referenceNumber);
}));

// SRC: TrelloInjector.html:786
//   `.findOrCreatePOCardAndInject(po, document.getElementById('po-label-input').value)`
// That 2nd argument is idLabel -- an explicit pick from the ingest UI's
// Customer Label dropdown. The port had dropped it; see PHASE_3_NOTES.md
// finding F3.
router.post('/trello/po-card/find-or-create', runMutation('Find or create PO card', (req) => {
  const {parsedPO, idLabel} = req.body;
  return Service_Read.findOrCreatePOCardAndInject(parsedPO, idLabel);
}));

// SRC: TrelloInjector.html:1436 `.injectPOChecklist(cardId, lineItems)`.
router.post('/trello/po-card/inject-checklist', runMutation('Inject PO checklist', (req) => {
  const {cardId, lineItems} = req.body;
  return Service_Read.injectPOChecklist(cardId, lineItems);
}));

/* ------------------------------------- receiving + outbound card handling */

// SRC: JS_Handlers.html:5694
//   `.receivePOCardItems(activeReceivingCardId, cardName, backendPayload)`.
// Writes Inventory AND edits the Trello checklist, so it can partially
// succeed: it returns `trelloSynced:false` + `failedItems[]` with
// `success:true`, deliberately, because the stock is physically on the floor
// once the Inventory write lands (PHASE_2_NOTES.md §3.2). The wrapper echoes
// the whole result object, so those fields survive to the client.
router.post('/receiving/po-card-items', runMutation('Receive PO card items', (req) => {
  const {cardId, cardName, itemsReceived} = req.body;
  return Service_Write.receivePOCardItems(cardId, cardName, itemsReceived, req);
}));

// SRC: JS_Handlers.html:6150 `.processPackedOutboundCard(cardId)`.
router.post('/outbound/process-packed-card', runMutation('Process packed outbound card', (req) => {
  return Service_Write.processPackedOutboundCard(req.body.cardId);
}));

module.exports = router;
