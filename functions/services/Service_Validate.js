const SS_API = require('./Service_SheetsAPI');
const logger = require('firebase-functions/logger');

/**
 * ============================================================================
 * REGISTRY VALIDATION (PORTED TO NODE.JS)
 * ============================================================================
 */

async function validateRegistrySheets() {
  const results = [];
  results.push(...(await validateCustomerRegistry_()));
  results.push(...(await validateBrandItemCatalog_()));
  await writeValidationResults_(results);
  return results;
}

async function validateCustomerRegistry_() {
  const issues = [];
  
  // Replace SpreadsheetApp.getActiveSpreadsheet().getSheetByName() with SS_API.getSheetValues
  const data = await SS_API.getSheetValues("CUSTOMER_REGISTRY!A:G");
  if (!data || data.length === 0) {
    issues.push({ sheet: "CUSTOMER_REGISTRY", row: "-", rule: "sheet exists", detail: "Sheet not found or empty." });
    return issues;
  }

  const header = data[0] || [];
  const expectedHeader = ["Parent_Account", "Brand_ID", "Brand_Name", "Regex_Aliases", "Target_Board_ID", "Warehouse_Type", "Handling_Type"];
  for (let c = 0; c < expectedHeader.length; c++) {
    const actual = String(header[c] || "").trim();
    const isKnownMislabel = (c === 5 && actual.indexOf("Warehouse_Type") === 0);
    if (actual !== expectedHeader[c] && !isKnownMislabel) {
      issues.push({
        sheet: "CUSTOMER_REGISTRY", row: 1, rule: "header matches expected map",
        detail: `Column ${String.fromCharCode(65 + c)} expected "${expectedHeader[c]}", found "${actual}"`
      });
    }
  }

  const rows = data.slice(1);
  const seenRowSignatures = {}; // signature -> first sheet row number

  rows.forEach((row, idx) => {
    const sheetRow = idx + 2;
    const parentAccount = String(row[0] || "").trim();
    const brandId = String(row[1] || "").trim();
    const brandName = String(row[2] || "").trim();
    const regexAliases = String(row[3] || "").trim();
    const targetBoardId = String(row[4] || "").trim();

    if (!parentAccount && !brandId) return; // fully blank row, skip

    if (!brandName) {
      issues.push({
        sheet: "CUSTOMER_REGISTRY", row: sheetRow, rule: "Brand_Name non-empty",
        detail: `Brand_ID "${brandId}" has no Brand_Name.`
      });
    }

    if (!regexAliases) {
      issues.push({
        sheet: "CUSTOMER_REGISTRY", row: sheetRow, rule: "Regex_Aliases non-empty",
        detail: `Brand_ID "${brandId}" has no Regex_Aliases.`
      });
    } else {
      try {
        new RegExp(regexAliases, 'i');
      } catch (e) {
        issues.push({
          sheet: "CUSTOMER_REGISTRY", row: sheetRow, rule: "Regex_Aliases compiles",
          detail: `Pattern "${regexAliases}" failed to compile: ${e.message}`
        });
      }
    }

    const sig = [parentAccount, brandId, brandName, regexAliases].join("||");
    if (seenRowSignatures[sig] !== undefined) {
      issues.push({
        sheet: "CUSTOMER_REGISTRY", row: sheetRow, rule: "no duplicate rows",
        detail: `Identical Parent_Account/Brand_ID/Brand_Name/Regex_Aliases to row ${seenRowSignatures[sig]}.`
      });
    } else {
      seenRowSignatures[sig] = sheetRow;
    }
    
    // Notice: targetBoardId checking against Script Properties (PropertiesService.getScriptProperties())
    // In Firebase, we would use process.env to hold these properties.
    if (targetBoardId) {
      targetBoardId.split(',').map(s => s.trim()).filter(s => s.length > 0).forEach(name => {
        if (/^[A-Z][A-Z0-9_]*$/.test(name) && process.env[name] === undefined) {
          issues.push({
            sheet: "CUSTOMER_REGISTRY", row: sheetRow, rule: "Target_Board_ID resolves to a Environment Variable",
            detail: `References "${name}", which has no matching ENV var currently set.`
          });
        }
      });
    }
  });

  // Shadowing check
  for (let j = 0; j < rows.length; j++) {
    const laterBrandName = String(rows[j][2] || "").trim().toUpperCase();
    const laterBrandId = String(rows[j][1] || "").trim().toUpperCase();
    const laterOwnRegex = String(rows[j][3] || "").trim();
    const sampleTexts = [laterBrandName, laterBrandId].filter(t => t.length > 0);
    if (sampleTexts.length === 0) continue;

    for (let i = 0; i < j; i++) {
      const earlierRegex = String(rows[i][3] || "").trim();
      if (!earlierRegex || earlierRegex === laterOwnRegex) continue;

      let rgx;
      try { rgx = new RegExp(earlierRegex, 'i'); } catch (e) { continue; }

      const matchedSample = sampleTexts.find(t => rgx.test(t));
      if (matchedSample) {
        issues.push({
          sheet: "CUSTOMER_REGISTRY", row: j + 2, rule: "no earlier regex shadows a later one",
          detail: `Row ${i + 2}'s pattern "${earlierRegex}" already matches "${matchedSample}" — this row (Brand_ID "${String(rows[j][1] || "").trim()}") may be unreachable.`
        });
      }
    }
  }

  return issues;
}

async function validateBrandItemCatalog_() {
  const issues = [];
  const data = await SS_API.getSheetValues("BRAND_ITEM_CATALOG!A:D");
  if (!data || data.length === 0) {
    issues.push({ sheet: "BRAND_ITEM_CATALOG", row: "-", rule: "sheet exists", detail: "Sheet not found or empty." });
    return issues;
  }

  const rows = data.slice(1);

  let productSkuSet = null;
  const productData = await SS_API.getSheetValues("PRODUCT!A:A");
  if (productData && productData.length > 0) {
    productSkuSet = {};
    productData.slice(1).forEach(r => {
      const sku = String(r[0] || "").trim();
      if (sku) productSkuSet[sku] = true;
    });
  }

  rows.forEach((row, idx) => {
    const sheetRow = idx + 2;
    const brandId = String(row[0] || "").trim();
    const canonicalSku = String(row[1] || "").trim();
    const keywords = String(row[2] || "").trim();
    const defaultQty = row[3];

    if (!brandId && !canonicalSku) return; // fully blank row

    if (!keywords) {
      issues.push({
        sheet: "BRAND_ITEM_CATALOG", row: sheetRow, rule: "Keywords non-empty",
        detail: `Brand_ID "${brandId}" / SKU "${canonicalSku}" has no Keywords.`
      });
    }

    if (!(Number(defaultQty) > 0)) {
      issues.push({
        sheet: "BRAND_ITEM_CATALOG", row: sheetRow, rule: "Default_Qty numeric > 0",
        detail: `Default_Qty is "${defaultQty}" (expected a positive number).`
      });
    }

    if (productSkuSet && canonicalSku && !productSkuSet[canonicalSku]) {
      issues.push({
        sheet: "BRAND_ITEM_CATALOG", row: sheetRow, rule: "Canonical_SKU exists in PRODUCT",
        detail: `Canonical_SKU "${canonicalSku}" was not found in PRODUCT column A.`
      });
    }
  });

  return issues;
}

async function writeValidationResults_(results) {
  if (results.length === 0) {
    logger.info("✅ Registry validation passed — no issues found.");
    return;
  }

  const now = new Date().toISOString();
  const rows = results.map(r => [now, r.sheet, r.row, r.rule, r.detail]);
  
  await SS_API.batchAppendRows("Validation_Log", rows);
  logger.warn(`⚠️ Registry validation found ${results.length} issue(s) — appended to Validation_Log tab.`);
}

module.exports = {
  validateRegistrySheets
};
