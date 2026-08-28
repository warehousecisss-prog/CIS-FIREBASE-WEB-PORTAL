const { logger } = require('firebase-functions');
const pdfParse = require('pdf-parse');
const { getProductMap, getBrandItemCatalog, getCustomerRegistry } = require('./Service_Read');
const { sendWithAttachments } = require('./Service_Email');

async function processUploadedPOFile(payload) {
  try {
    if (!payload || !payload.base64Data) {
      return { success: false, message: "No PDF file data provided." };
    }

    const decodedBuffer = Buffer.from(payload.base64Data, 'base64');
    
    let rawText = '';
    try {
      const data = await pdfParse(decodedBuffer);
      rawText = data.text;
    } catch (e) {
      logger.error("pdfParse failed", { error: e.toString() });
      return { success: false, message: "Could not extract readable text from PDF." };
    }

    if (!rawText || rawText.trim().length === 0) {
      return { success: false, message: "Could not extract readable text from PDF." };
    }

    let parsedPO = parseQuickBooksPOText(rawText);

    const registry = await getCustomerRegistry();
    const brandMatch = resolveBrandFromPOText(rawText, registry);
    if (brandMatch) {
      parsedPO.vendor = brandMatch.Brand_Name || brandMatch.Parent_Account || "";
      parsedPO.brandId = brandMatch.Brand_ID || "";
    }

    await resolveSkusAgainstCatalogs(parsedPO);

    return {
      success: true,
      data: parsedPO
    };

  } catch (err) {
    logger.error("Error in processUploadedPOFile", { error: err.stack });
    return { success: false, message: "Parsing failed: " + err.message };
  }
}

async function reresolvePOForVendor(parsedPO, brandId, vendorName) {
  try {
    if (!parsedPO) return { success: false, message: 'No parsed PO data provided.' };
    parsedPO.vendor = vendorName || "";
    parsedPO.brandId = brandId || "";
    parsedPO.labelColor = null;
    await resolveSkusAgainstCatalogs(parsedPO);
    return { success: true, data: parsedPO };
  } catch (err) {
    return { success: false, message: 'Re-resolving vendor failed: ' + err.message };
  }
}

async function resolveSkusAgainstCatalogs(parsedPO) {
  const productMap = await getProductMap() || {};
  const productMapUpper = {};
  const productNameEntries = [];
  
  Object.keys(productMap).forEach(k => {
    productMapUpper[k.toUpperCase()] = productMap[k];
    const nickname = productMap[k].nickname;
    if (nickname) {
      productNameEntries.push({ nameUpper: nickname.toUpperCase(), productId: k, nickname: nickname });
    }
  });

  const brandCatalogAll = await getBrandItemCatalog() || [];
  const brandCatalog = parsedPO.brandId
    ? brandCatalogAll.filter(row => row.Brand_ID === parsedPO.brandId)
    : brandCatalogAll;

  const labelColorCounts = {};

  if (parsedPO.lineItems && parsedPO.lineItems.length > 0) {
    parsedPO.lineItems.forEach(item => {
      item.canonicalSku = null;
      item.catalogDesc = null;
      item.matchSource = null;

      const cleanPart = String(item.partNumber || "").toUpperCase().trim();
      const productHit = cleanPart ? productMapUpper[cleanPart] : null;

      if (productHit) {
        item.canonicalSku = cleanPart;
        item.catalogDesc = productHit.nickname || item.description;
        item.matchSource = 'PRODUCT';
        return;
      }

      const descUpper = String(item.description || "").toUpperCase();
      const nameHit = descUpper
        ? productNameEntries.find(p => descUpper.indexOf(p.nameUpper) !== -1)
        : null;
        
      if (nameHit) {
        item.canonicalSku = nameHit.productId;
        item.catalogDesc = nameHit.nickname;
        item.matchSource = 'PRODUCT_KEYWORD';
        return;
      }

      if (brandCatalog.length > 0) {
        const matched = matchCatalogSKU(item.partNumber, brandCatalog);
        if (matched) {
          item.canonicalSku = matched.Canonical_SKU;
          item.catalogDesc = matched.Item_Description || item.description;
          item.matchSource = 'BRAND_ITEM_CATALOG';
          if (matched.Label_Color) {
            const colorKey = String(matched.Label_Color).toLowerCase().trim();
            labelColorCounts[colorKey] = (labelColorCounts[colorKey] || 0) + 1;
          }
        }
      }
    });
  }

  let topColor = null, topCount = 0;
  Object.keys(labelColorCounts).forEach(c => {
    if (labelColorCounts[c] > topCount) { topColor = c; topCount = labelColorCounts[c]; }
  });
  parsedPO.labelColor = topColor || null;

  return parsedPO;
}

function parseQuickBooksPOText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  const result = {
    poNumber: "",
    poDate: "",
    vendor: "",
    shipTo: "CIS Security Solutions, Inc.",
    transitModeHint: "SEA",
    lineItems: []
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/P\.?O\.?\s*No\.?/i.test(line) && i + 1 < lines.length) {
      const poMatch = lines[i + 1].match(/\b(\d{4,6})\b/);
      if (poMatch) result.poNumber = poMatch[1];
    }

    if (/Date/i.test(line) && i + 1 < lines.length) {
      const dateMatch = lines[i + 1].match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
      if (dateMatch) result.poDate = dateMatch[1];
    }

    if (/VIA AIR|AIRFREIGHT|AIR/i.test(line)) {
      result.transitModeHint = "AIR";
    } else if (/VIA SEA|SEA|OCEAN/i.test(line)) {
      result.transitModeHint = "SEA";
    }
  }

  let tableStartIndex = -1;
  for (let j = 0; j < lines.length; j++) {
    if (/Item\s+Description\s+Qty/i.test(lines[j])) {
      tableStartIndex = j + 1;
      break;
    }
  }

  if (tableStartIndex !== -1) {
    const itemLines = [];
    for (let k = tableStartIndex; k < lines.length; k++) {
      const currentLine = lines[k];
      if (/^Total\b/i.test(currentLine) || /^\$[\d,]+\.\d{2}$/.test(currentLine)) break;
      itemLines.push(currentLine);
    }
    const blob = itemLines.join(' ').replace(/\s+/g, ' ');

    const tripletRegex = /([\d,]+)\s+(\d+\.\d{2})\s+([\d,]+\.\d{2})/g;
    let cursor = 0;
    let tripletMatch;
    
    while ((tripletMatch = tripletRegex.exec(blob)) !== null) {
      const leadText = blob.slice(cursor, tripletMatch.index).trim();
      cursor = tripletRegex.lastIndex;

      const qty = parseInt(tripletMatch[1].replace(/,/g, ''), 10);
      const rate = parseFloat(tripletMatch[2]);

      if (!(qty > 0 && rate > 0)) continue;

      const skuMatch = leadText.match(/^([A-Z0-9][A-Z0-9\-\/]{2,29})\s+(.*)$/i);
      if (!skuMatch) continue;

      result.lineItems.push({
        partNumber: skuMatch[1].trim(),
        description: skuMatch[2].trim(),
        qty: qty,
        rate: rate
      });
    }
  }

  return result;
}

function resolveBrandFromPOText(text, registry) {
  if (!text || !registry || registry.length === 0) return null;
  const upperText = String(text).toUpperCase();
  
  for (let i = 0; i < registry.length; i++) {
    const row = registry[i];
    const aliasPattern = row ? row.Regex_Aliases : "";
    if (!aliasPattern) continue;
    try {
      const rgx = new RegExp(aliasPattern, 'i');
      if (rgx.test(upperText)) return row;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function matchCatalogSKU(partNumber, catalog) {
  if (!partNumber || !catalog) return null;
  const cleanPart = partNumber.toUpperCase().trim();

  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i];
    const cSku = String(item.Canonical_SKU || "").toUpperCase().trim();
    if (cSku === cleanPart) return item;

    if (item.Keywords) {
      const keywords = item.Keywords.split(/[|,]/);
      for (let k = 0; k < keywords.length; k++) {
        if (keywords[k].toUpperCase().trim() === cleanPart) return item;
      }
    }
  }
  return null;
}

/**
 * Emails the original uploaded PO PDF to a supplier (and an optional CC), from
 * the Trello Injector's "Ingest PO PDF" flow.
 *
 * This exists because these POs are generated in QuickBooks and then have to be
 * separately, manually emailed to the supplier -- an easy step to forget or to
 * duplicate, since nothing otherwise ties "sent to Trello" together with
 * "actually emailed to the supplier". Optional and non-blocking: it is only
 * ever called from the prompt shown AFTER a successful Trello send, and is
 * never required to complete that send.
 *
 * SRC builds a Blob with `Utilities.newBlob` and hands it to
 * `MailApp.sendEmail(..., {attachments:[blob]})`. Here the base64 is decoded to
 * a Buffer and passed to nodemailer, which takes the same three fields
 * (filename, content, contentType).
 *
 * Parity with SRC/src/Service_PO_Ingest.js:350-375.
 *
 * @param {{base64Data: string, fileName?: string, poNumber?: string,
 *          toEmail: string, ccEmail?: string}} payload
 * @return {Promise<{success: boolean, message?: string}>}
 */
async function emailPOPdfToSupplier(payload) {
  try {
    if (!payload || !payload.base64Data) {
      return { success: false, message: 'No PDF data available to email.' };
    }
    const toEmail = String(payload.toEmail || '').trim();
    if (!toEmail) {
      return { success: false, message: 'No recipient email provided.' };
    }

    const content = Buffer.from(payload.base64Data, 'base64');
    if (content.length === 0) {
      return { success: false, message: 'The PDF attachment decoded to nothing.' };
    }

    const subject = 'Purchase Order' + (payload.poNumber ? ' #' + payload.poNumber : '');
    const ccEmail = String(payload.ccEmail || '').trim();

    return await sendWithAttachments({
      to: toEmail,
      cc: ccEmail || undefined,
      subject: subject,
      text: 'Please see the attached Purchase Order PDF.',
      attachments: [{
        filename: payload.fileName || 'PO.pdf',
        content: content,
        contentType: 'application/pdf'
      }]
    }, 'PO PDF to supplier');
  } catch (e) {
    return { success: false, message: 'Failed to send email: ' + e.message };
  }
}

module.exports = {
  processUploadedPOFile,
  reresolvePOForVendor,
  emailPOPdfToSupplier
};

