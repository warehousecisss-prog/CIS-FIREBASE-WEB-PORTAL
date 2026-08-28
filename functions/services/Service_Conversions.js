const SS_API = require('./Service_SheetsAPI');
const logger = require('firebase-functions/logger');

/**
 * ============================================================================
 * CIS WAREHOUSE PORTAL - UNIT -> CASE CONVERSION AT PUT-AWAY
 * PORTED TO NODE.JS (FIREBASE CLOUD FUNCTIONS)
 * ============================================================================
 */

const CASE_CONVERSIONS_SHEET = "CASE_CONVERSIONS";
const BUFFER_LOCATIONS = ["ZONE-BUFFER"];

let CASE_CONVERSIONS_CACHE_ = null;

async function getCaseConversions() {
  if (CASE_CONVERSIONS_CACHE_) return CASE_CONVERSIONS_CACHE_;
  try {
    const data = await SS_API.getSheetValues(`${CASE_CONVERSIONS_SHEET}!A2:C`);
    if (!data || data.length === 0) {
      CASE_CONVERSIONS_CACHE_ = [];
      return CASE_CONVERSIONS_CACHE_;
    }

    CASE_CONVERSIONS_CACHE_ = data.map(row => ({
      unitPrefix: String(row[0] || "").trim(),
      caseSku: String(row[1] || "").trim(),
      unitsPerCase: Number(row[2])
    })).filter(r => r.unitPrefix && r.caseSku && r.unitsPerCase > 0);

    return CASE_CONVERSIONS_CACHE_;
  } catch (e) {
    logger.error("getCaseConversions failed", { error: e.message });
    CASE_CONVERSIONS_CACHE_ = [];
    return CASE_CONVERSIONS_CACHE_;
  }
}

async function findCaseConversion(unitSku) {
  const clean = String(unitSku || "").trim().toUpperCase();
  if (!clean) return null;
  const rules = await getCaseConversions();
  for (let i = 0; i < rules.length; i++) {
    if (clean.indexOf(rules[i].unitPrefix.toUpperCase()) === 0) return rules[i];
  }
  return null;
}

function isBufferLocation(locId) {
  return BUFFER_LOCATIONS.indexOf(String(locId || "").trim().toUpperCase()) !== -1;
}

async function planCaseConversion(fromLoc, toLoc, sku, requestedQty) {
  if (!isBufferLocation(fromLoc)) return { convert: false };
  if (isBufferLocation(toLoc)) return { convert: false };

  const rule = await findCaseConversion(sku);
  if (!rule) return { convert: false };

  const qty = Number(requestedQty);
  if (!(qty > 0)) return { convert: false };

  const cases = Math.floor(qty / rule.unitsPerCase);
  if (cases < 1) {
    return {
      convert: false,
      refuse: true,
      error: `Not enough units to make a full case. ${rule.unitsPerCase} units = 1 "${rule.caseSku}"; you're moving ${qty}. Move at least ${rule.unitsPerCase}, or put these away without conversion.`
    };
  }

  const unitsConsumed = cases * rule.unitsPerCase;
  return {
    convert: true,
    caseSku: rule.caseSku,
    cases: cases,
    unitsConsumed: unitsConsumed,
    remainder: qty - unitsConsumed,
    unitsPerCase: rule.unitsPerCase
  };
}

module.exports = {
  getCaseConversions,
  findCaseConversion,
  isBufferLocation,
  planCaseConversion
};
