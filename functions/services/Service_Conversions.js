const SS_API = require('./Service_SheetsAPI');
const logger = require('firebase-functions/logger');
const {
  primeQbNameIndex,
  getQbNameIndex_,
  canonicalNameKey_,
  namesMatch_
} = require('./Shared_Classifiers');

/**
 * ============================================================================
 * CIS WAREHOUSE PORTAL - UNIT -> CASE CONVERSION AT PUT-AWAY
 * PORTED TO NODE.JS (FIREBASE CLOUD FUNCTIONS)
 * ============================================================================
 * THE PROBLEM THIS SOLVES (confirmed against the live workbook 2026-08-13):
 * Inventory holds the SAME five Burlington products under TWO different SKU
 * vocabularies and two different units of measure:
 *
 *   Floor (racks)  -> case SKUs   e.g. "Burlington 3.5\" Siren Tag Case", 538
 *   ZONE-BUFFER    -> unit SKUs   e.g. "CIS NT510-2/2A 3.5\"",         20,000
 *
 * The floor rows predate the receiving feature and were entered by hand as the
 * customer-facing case SKU. receivePOCardItems() writes the SUPPLIER's unit SKU
 * into ZONE-BUFFER. Nothing reconciled the two, so getInventoryTotals() counts
 * them as unrelated products and outbound demand (quoted in cases) can never net
 * against buffer stock (quoted in units).
 *
 * DECISION (user, 2026-08-13): the floor stays in CASES. The conversion happens
 * at exactly one point -- put-away from ZONE-BUFFER to a real floor location --
 * because that is the moment units physically become cases, it is already a
 * deliberate human action, and it is the only place the ratio is unambiguous.
 *
 * WHAT THIS DOES NOT DO: it does not convert anything already on the floor, and
 * it does not touch QuickBooks. QuickBooks remains the authority on the
 * commercial unit->case conversion; this only keeps the portal's own picture of
 * the floor internally consistent.
 *
 * Parity with SRC/src/Service_Conversions.js.
 */

const CASE_CONVERSIONS_SHEET = "CASE_CONVERSIONS";
const CASE_CONVERSIONS_HEADERS = ["Unit_SKU_Prefix", "Case_SKU", "Units_Per_Case", "Notes"];

/**
 * Locations that hold received-but-not-put-away stock in SUPPLIER units.
 * A move OUT of one of these INTO a real floor location is a put-away, and is
 * the only transition that triggers conversion.
 */
const BUFFER_LOCATIONS = ["ZONE-BUFFER"];

/**
 * SRC caches this "per execution" -- one request. Here the module-level cache
 * lives for the life of the CONTAINER, so an edit to CASE_CONVERSIONS is not
 * picked up until it recycles. Same trade and same mitigation as
 * Service_Dates' lane table: acceptable for a tiny, rarely-edited table, and
 * clearable via clearCaseConversionsCache().
 */
let CASE_CONVERSIONS_CACHE_ = null;

/**
 * Reads the conversion table.
 *
 * NOTE (2026-08-26, still true): this sheet does NOT exist in the live
 * workbook -- setupCaseConversions() was written but never run -- so this
 * returns [] and every path that depends on it alone is dormant.
 * resolveUnitsPerCase_ has a second source (FLOOR_CASE_SKUS_) for that reason.
 *
 * @return {Promise<Array<{unitPrefix: string, caseSku: string, unitsPerCase: number}>>}
 */
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
    }))
    // A row missing any of the three is unusable. Dropping it silently is
    // correct here (the validator reports it); acting on a half-filled row
    // would mint wrong quantities.
    .filter(r => r.unitPrefix && r.caseSku && r.unitsPerCase > 0);

    return CASE_CONVERSIONS_CACHE_;
  } catch (e) {
    logger.error("getCaseConversions failed", { error: e.message });
    CASE_CONVERSIONS_CACHE_ = [];
    return CASE_CONVERSIONS_CACHE_;
  }
}

/** Drops the memoized conversion table. No SRC counterpart -- see the cache. */
function clearCaseConversionsCache() {
  CASE_CONVERSIONS_CACHE_ = null;
}

/**
 * Finds the conversion rule whose Unit_SKU_Prefix starts the given SKU.
 *
 * WHAT CHANGED IN SRC 2026-08-26, AND WAS MISSING HERE: this used to
 * prefix-match the raw Inventory SKU string directly. That worked only while
 * Inventory held the full QB name -- and since 2026-08-11 receivePOCardItems()
 * writes the NICKNAME there instead. A nickname does not start with the
 * supplier code, so the rule silently stopped firing for everything received
 * after that date: no error, no log, the put-away conversion just never
 * happened. Confirmed against the live PRODUCT sheet: both `NT525S/2AMF`
 * products are nicknamed "2 Alarm SMALL Scorpion Tag", which shares no prefix
 * with the rule at all.
 *
 * Resolving the SKU back to its QB name first makes the rule fire for either
 * shape -- legacy rows still holding raw QB text, and new rows holding the
 * nickname -- without the conversion table being rewritten or the Inventory
 * column backfilled.
 *
 * `primeQbNameIndex()` is awaited here because the port splits SRC's
 * synchronous PRODUCT-sheet read into an async prime plus a sync cache read
 * (PHASE_2_NOTES.md §1). Without the prime the index is empty and this
 * degrades right back to the raw-prefix behaviour above. It memoizes, so the
 * second call onward is free.
 *
 * @param {string} unitSku
 * @return {Promise<?{unitPrefix: string, caseSku: string, unitsPerCase: number}>}
 */
async function findCaseConversion(unitSku) {
  const raw = String(unitSku || "").trim();
  if (!raw) return null;
  const rules = await getCaseConversions();
  if (rules.length === 0) return null;

  await primeQbNameIndex();
  const index = getQbNameIndex_() || {};
  // The QB name if the SKU resolves to a product; otherwise the raw text, so an
  // unrecognised SKU still behaves exactly as it did before.
  const qbName = index[canonicalNameKey_(raw)] || raw;
  const candidates = [qbName.toUpperCase()];
  if (qbName !== raw) candidates.push(raw.toUpperCase());

  for (let i = 0; i < rules.length; i++) {
    const pre = rules[i].unitPrefix.toUpperCase();
    for (let c = 0; c < candidates.length; c++) {
      if (candidates[c].indexOf(pre) === 0) return rules[i];
    }
  }
  return null;
}

/**
 * The four SKUs whose FLOOR rows are counted in whole cases. Everything else --
 * including supplier names that merely carry "(N per case)" in their text -- is
 * counted in eaches and must NOT be broken down.
 *
 * WHY A FIXED LIST (2026-08-28): this used to scrape "(N per case)" out of the
 * product's QuickBooks name. That was tolerable while Inventory held bare
 * nicknames, but the 2026-08-28 name rewrite folded the full QB spec into every
 * Inventory SKU string, so the scrape started firing on ADM Full Coverage
 * Adhesive packs (sold as the pack -> rendered qty x 100) and Epson ERC ribbons
 * (stored as individual ribbons -> rendered qty x 48/144). No string rule
 * separates "48 loose ribbons live in this box" from "the box of 48 IS the
 * unit"; it is a per-product fact, so it is listed here by hand.
 *
 * `prefix` is matched at the START of the SKU string, which absorbs all three
 * shapes the rewrite left behind: the folded form
 * `Burlington Scorpion Tag Case (Burlington Scorpion Tag Case (25 units...))`,
 * the bare form `Burlington Scorpion Tag Case` still used by Master-Hub F/B
 * bucket rows, and the CAP-TRUNCATED 3.5" form that ends in "...per 1 ca...".
 */
const FLOOR_CASE_SKUS_ = [
  { prefix: 'Burlington 48" Siren Tag Case',  unitsPerCase: 20  },
  { prefix: 'Burlington 3.5" Siren Tag Case', unitsPerCase: 50  },
  { prefix: 'Burlington Milli Tag Case',      unitsPerCase: 500 },
  { prefix: 'Burlington Scorpion Tag Case',   unitsPerCase: 25  }
];

/**
 * How many units are in one case of this product, or null if unknown.
 *
 * Two sources, in priority order:
 *
 *  1. The CASE_CONVERSIONS sheet, when it exists. It does not today (see
 *     getCaseConversions above). Kept first in precedence so that running the
 *     setup later takes over cleanly.
 *  2. The FLOOR_CASE_SKUS_ list above -- the four Burlington case SKUs, matched
 *     by prefix against the SKU string (resolved through the name index first,
 *     so a nickname still reaches the canonical text).
 *
 * Returns null rather than guessing. Every caller must render unit counts alone
 * when it does -- an invented case count on a shipping document is worse than
 * no case count.
 *
 * @param {string} name
 * @return {Promise<?number>}
 */
async function resolveUnitsPerCase_(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;

  await primeQbNameIndex();

  const rules = await getCaseConversions();
  for (let i = 0; i < rules.length; i++) {
    if (namesMatch_(rules[i].caseSku, raw)) return rules[i].unitsPerCase;
  }

  const index = getQbNameIndex_() || {};
  const qbName = index[canonicalNameKey_(raw)] || raw;
  for (let i = 0; i < FLOOR_CASE_SKUS_.length; i++) {
    const p = FLOOR_CASE_SKUS_[i].prefix;
    if (raw.indexOf(p) === 0 || qbName.indexOf(p) === 0) return FLOOR_CASE_SKUS_[i].unitsPerCase;
  }
  return null;
}

/**
 * Breaks a quantity into units and cases for display.
 *
 * `qtyUnit` says what the incoming number counts, because the two sides of the
 * app disagree and always have:
 *   'cases' -- floor Inventory rows carrying a case SKU hold a CASE count
 *              (see this file's header: 538 means 538 cases)
 *   'units' -- the SHIPMENTS sheet's column is literally "# of Units"
 *
 * Output always carries both, so callers can render the unit count as the
 * headline with the case count beneath it (the format agreed with the user
 * 2026-08-26: on-order vs on-hand is compared in UNITS, never by comparing a
 * case number against a unit number).
 *
 * @param {string} name
 * @param {*} qty
 * @param {string} qtyUnit 'cases' or 'units'.
 * @return {Promise<{units: number, cases: ?number, remainder: number,
 *     unitsPerCase: ?number, hasRule: boolean}>}
 */
async function caseBreakdown_(name, qty, qtyUnit) {
  const n = Number(qty) || 0;
  const per = await resolveUnitsPerCase_(name);
  if (!per) return { units: n, cases: null, remainder: 0, unitsPerCase: null, hasRule: false };

  if (qtyUnit === 'cases') {
    return { units: n * per, cases: n, remainder: 0, unitsPerCase: per, hasRule: true };
  }
  const cases = Math.floor(n / per);
  return { units: n, cases: cases, remainder: n - (cases * per), unitsPerCase: per, hasRule: true };
}

/**
 * One-line "1,250 units (50 cases)" rendering of caseBreakdown_, for plain-text
 * surfaces like the Trello shipping-card description. Returns just the unit
 * count when no ratio is known.
 *
 * DELIBERATE DEVIATION: the thousands separators are pinned to 'en-US' rather
 * than left to the runtime's default locale as SRC does. Apps Script runs under
 * the script's own locale; a Cloud Functions container's default is whatever
 * the image says, and this string is written into a Trello card that people
 * read. "1.250" meaning one thousand two hundred and fifty is a genuinely
 * dangerous thing to render on a shipping document.
 *
 * @param {string} name
 * @param {*} qty
 * @param {string} qtyUnit
 * @return {Promise<string>}
 */
async function formatQtyWithCases_(name, qty, qtyUnit) {
  const b = await caseBreakdown_(name, qty, qtyUnit);
  const units = b.units.toLocaleString('en-US');
  if (!b.hasRule || !b.cases) return units;
  let out = units + " (" + b.cases.toLocaleString('en-US') + " case" + (b.cases === 1 ? "" : "s");
  if (b.remainder > 0) out += " + " + b.remainder.toLocaleString('en-US');
  return out + ")";
}

/**
 * @param {string} locId
 * @return {boolean}
 */
function isBufferLocation(locId) {
  return BUFFER_LOCATIONS.indexOf(String(locId || "").trim().toUpperCase()) !== -1;
}

/**
 * Decides whether a given move is a converting put-away, and if so works out
 * the arithmetic. Pure -- no sheet writes -- so the caller stays in control of
 * ordering and can refuse cleanly.
 *
 * PARTIAL CASES: whole cases only. Received quantities are not always clean
 * multiples (the live buffer holds 5,142 units of a 25-per-case product = 205
 * cases + 17 loose), so the remainder STAYS IN THE BUFFER as units rather than
 * being rounded away or written as a fractional case. Fractional cases would be
 * a lie about a physical object; silently dropping 17 units would be worse.
 *
 * @param {string} fromLoc
 * @param {string} toLoc
 * @param {string} sku
 * @param {*} requestedQty
 * @return {Promise<Object>} one of:
 *   {convert:false}                           - not a put-away, move normally
 *   {convert:false, refuse:true, error:"..."} - is a put-away but can't complete
 *   {convert:true, caseSku, cases, unitsConsumed, remainder, unitsPerCase}
 */
async function planCaseConversion(fromLoc, toLoc, sku, requestedQty) {
  if (!isBufferLocation(fromLoc)) return { convert: false };
  // Buffer -> buffer isn't a put-away.
  if (isBufferLocation(toLoc)) return { convert: false };

  const rule = await findCaseConversion(sku);
  if (!rule) return { convert: false }; // e.g. CIS GEN6SR BB, which has no case SKU

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

/**
 * One-off setup -- creates the CASE_CONVERSIONS sheet seeded with the five
 * Burlington mappings confirmed with the user 2026-08-13. Safe to re-run: it
 * will not overwrite existing data rows, only create the sheet and headers if
 * missing and append any seed row whose Case_SKU isn't already present.
 *
 * NOTE the deliberate omission: CIS GEN6SR BB (Burlington Bar) has NO case SKU
 * -- the customer orders it in units of 1 at arbitrary counts (20, 27, 150) and
 * it arrives from the supplier in packs of 5. It must stay out of this table so
 * put-away moves it as units, unconverted.
 *
 * No route, deliberately: it has no client call site in SRC (it is a manual
 * editor action) and it creates a sheet.
 *
 * @return {Promise<Object>}
 */
async function setupCaseConversions() {
  try {
    let created = false;
    let existingCaseSkus = [];

    let meta = null;
    try {
      meta = await SS_API.getSheetMetadata(CASE_CONVERSIONS_SHEET);
    } catch (e) {
      meta = null; // tab absent -- created below
    }

    if (!meta) {
      await SS_API.batchUpdateSheet([
        { addSheet: { properties: { title: CASE_CONVERSIONS_SHEET } } }
      ]);
      SS_API.clearSheetMetadataCache();
      const fresh = await SS_API.getSheetMetadata(CASE_CONVERSIONS_SHEET);
      await SS_API.batchUpdateValues([
        { range: `${CASE_CONVERSIONS_SHEET}!A1:D1`, values: [CASE_CONVERSIONS_HEADERS] }
      ]);
      await SS_API.batchUpdateSheet([
        {
          repeatCell: {
            range: {
              sheetId: fresh.sheetId, startRowIndex: 0, endRowIndex: 1,
              startColumnIndex: 0, endColumnIndex: CASE_CONVERSIONS_HEADERS.length
            },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold"
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId: fresh.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        }
      ]);
      created = true;
    } else {
      const rows = await SS_API.getSheetValues(`${CASE_CONVERSIONS_SHEET}!B2:B`);
      existingCaseSkus = (rows || []).map(r => String(r[0] || "").trim().toUpperCase());
    }

    // [Unit_SKU_Prefix, Case_SKU, Units_Per_Case, Notes]
    //
    // Unit_SKU_Prefix is the shortest string that uniquely identifies the
    // supplier SKU, chosen to sit BEFORE any truncation or inch-mark character.
    //
    // Case_SKU must be the EXACT string already used by the floor rows. This is
    // load-bearing: the whole point of this table is to stop the floor
    // fragmenting into multiple names for one product, so a wrong string here
    // creates a THIRD vocabulary instead of joining the existing one.
    //
    // UNVERIFIED -- CHECK BEFORE RUNNING: the 3.5" row was previously
    // documented as matching a QuickBooks-truncated live floor string ending in
    // a literal "..."; that exact truncated form was never captured anywhere
    // retrievable, so this seed uses the clean untruncated name instead. Open
    // the live Inventory tab and confirm the real floor-row string for the 3.5"
    // case BEFORE running this -- if it is truncated, fix column B after
    // seeding to match exactly.
    const seed = [
      ["CIS NT510/2A S 12",  "Burlington 12\" Siren Tag Case",   25,  "12\" HD padlock tag. Case name not yet on the floor — this sets it."],
      ["CIS NT510-2/2A 3.5", "Burlington 3.5\" Siren Tag Case",  50,  "Called 5\" on the floor (cable 5\", tag body 3.5\"). UNVERIFIED against live sheet — see note above, may need to match a QB-truncated string instead."],
      ["CIS NT510/2A S 48",  "Burlington 48\" Siren Tag Case",   20,  "48\" HD padlock tag"],
      ["CIS ST-11 M",        "Burlington Milli Tag Case",        500, "Milli / stick tag"],
      ["NT525S/2AMF",        "Burlington Scorpion Tag Case",     25,  "Small scorpion tag, 90cm"]
    ];

    const toAppend = seed.filter(
        row => existingCaseSkus.indexOf(String(row[1]).trim().toUpperCase()) === -1);
    if (toAppend.length > 0) {
      await SS_API.batchAppendRows(CASE_CONVERSIONS_SHEET, toAppend);
    }

    CASE_CONVERSIONS_CACHE_ = null;
    logger.info("setupCaseConversions: " + toAppend.length + " row(s) added, " +
      (seed.length - toAppend.length) + " already present.");
    return {
      success: true,
      sheetCreated: created,
      added: toAppend.length,
      alreadyPresent: seed.length - toAppend.length,
      warning: "Confirm the 3.5\" Case_SKU against the live Inventory tab — the seed " +
               "uses the clean untruncated name and the floor row may be QB-truncated."
    };
  } catch (e) {
    logger.error("setupCaseConversions failed", { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Reports how much buffer stock is currently convertible, and what the floor
 * total would become. Read-only -- run it before and after a put-away session to
 * sanity-check, or to quantify the outstanding reconciliation gap.
 *
 * DEVIATION: SRC streams this to `Logger.log`. There is no Logger to read here,
 * so it RETURNS the report as data and logs a one-line summary. Same numbers,
 * usable by a caller.
 *
 * @return {Promise<Object>}
 */
async function reportConversionGap() {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");
    if (!data) return { success: false, error: "Inventory sheet not found." };

    const rules = await getCaseConversions();
    if (rules.length === 0) {
      return {
        success: false,
        error: "No conversion rules — the CASE_CONVERSIONS sheet is empty or absent. " +
               "Run setupCaseConversions() first."
      };
    }

    const report = {};
    rules.forEach(r => {
      report[r.caseSku] = { bufferUnits: 0, floorCases: 0, unitsPerCase: r.unitsPerCase };
    });

    for (let i = 1; i < data.length; i++) {
      const loc = String(data[i][0] || "").trim();
      const sku = String(data[i][1] || "").trim();
      const qty = Number(data[i][2]) || 0;
      if (!sku || sku === "Vacant" || qty <= 0) continue;

      if (isBufferLocation(loc)) {
        const rule = await findCaseConversion(sku);
        if (rule) report[rule.caseSku].bufferUnits += qty;
      } else {
        const skuUpper = sku.toUpperCase();
        rules.forEach(r => {
          if (skuUpper.indexOf(r.caseSku.toUpperCase()) === 0) report[r.caseSku].floorCases += qty;
        });
      }
    }

    const lines = Object.keys(report).map(caseSku => {
      const r = report[caseSku];
      const convertible = Math.floor(r.bufferUnits / r.unitsPerCase);
      const remainder = r.bufferUnits - (convertible * r.unitsPerCase);
      return {
        caseSku: caseSku,
        floorCasesNow: r.floorCases,
        bufferUnits: r.bufferUnits,
        unitsPerCase: r.unitsPerCase,
        convertibleCases: convertible,
        looseUnitsLeftInBuffer: remainder,
        floorCasesAfter: r.floorCases + convertible
      };
    });

    logger.info("reportConversionGap: " + lines.length + " rule(s), " +
      lines.reduce((a, l) => a + l.convertibleCases, 0) + " case(s) convertible.");
    return { success: true, report: lines };
  } catch (e) {
    logger.error("reportConversionGap failed", { error: e.message });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  CASE_CONVERSIONS_SHEET,
  CASE_CONVERSIONS_HEADERS,
  BUFFER_LOCATIONS,
  FLOOR_CASE_SKUS_,
  getCaseConversions,
  clearCaseConversionsCache,
  findCaseConversion,
  resolveUnitsPerCase_,
  caseBreakdown_,
  formatQtyWithCases_,
  isBufferLocation,
  planCaseConversion,
  setupCaseConversions,
  reportConversionGap
};
