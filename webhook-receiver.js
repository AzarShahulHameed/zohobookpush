/**
 * People -> Books invoice automation for Fixed Billing projects.
 *
 * PRIMARY mechanism: polling. Every 5 minutes, scans all Projects records,
 * finds ones where Status=Completed and Billing Model=Fixed Billing,
 * and pushes a draft invoice for each - UNLESS a Books invoice already
 * exists for that project (checked via reference_number, not People's
 * invoice_pushed field, since People's updateRecord endpoint returns a
 * persistent 7201 error and could not be made to work).
 *
 * If an invoice already exists but the project's current project_revenue
 * no longer matches the invoiced total (e.g. someone corrected the amount
 * after the invoice was created), this is logged loudly as a MISMATCH and
 * counted as a failure - it is NEVER auto-corrected. A human must decide
 * whether to issue a credit note, a new invoice, or a manual adjustment.
 *
 * SECONDARY mechanism: webhook endpoint kept as a dormant fallback in case
 * the Zoho-side workflow trigger issue ever gets resolved. Not relied on.
 *
 * No hardcoded client-to-contact or currency mappings. Both are resolved
 * live against Books contacts on every run, with a short cache.
 *
 * Does NOT handle T&M (needs period-based billing, not status-triggered)
 * or Milestone (separate form, separate logic - not built yet).
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Config ----
const PEOPLE_CLIENT_ID = process.env.ZOHO_IN_CLIENT_ID;
const PEOPLE_CLIENT_SECRET = process.env.ZOHO_IN_CLIENT_SECRET;
const PEOPLE_REFRESH_TOKEN = process.env.ZOHO_PEOPLE_REFRESH_TOKEN;

const BOOKS_CONFIG = {
  "NoblQ India": {
    dc: "in",
    orgId: process.env.ZOHO_BOOKS_INDIA_ORG_ID,
    clientId: process.env.ZOHO_IN_CLIENT_ID,
    clientSecret: process.env.ZOHO_IN_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_BOOKS_INDIA_REFRESH_TOKEN,
  },
  "NoblQ USA": {
    dc: "com",
    orgId: process.env.ZOHO_BOOKS_US_ORG_ID,
    clientId: process.env.ZOHO_US_CLIENT_ID,
    clientSecret: process.env.ZOHO_US_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_BOOKS_US_REFRESH_TOKEN,
  },
};

// ---- Token helper ----
async function getAccessToken(dc, clientId, clientSecret, refreshToken) {
  const url = `https://accounts.zoho.${dc}/oauth/v2/token`;
  const resp = await axios.post(url, null, {
    params: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  if (!resp.data.access_token) throw new Error("Refresh failed: " + JSON.stringify(resp.data));
  return resp.data.access_token;
}

// ---- Zoho People: paginate through all Projects records ----
async function getAllProjects() {
  const accessToken = await getAccessToken("in", PEOPLE_CLIENT_ID, PEOPLE_CLIENT_SECRET, PEOPLE_REFRESH_TOKEN);
  const url = `https://people.zoho.in/people/api/forms/P_TimesheetJobsList/getRecords`;

  let sIndex = 1;
  const pageSize = 200;
  const all = [];

  while (true) {
    const resp = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params: { sIndex, limit: pageSize },
    });

    const result = resp.data.response.result;
    if (!result || !Array.isArray(result) || result.length === 0) break;

    for (const item of result) {
      const [recordId, arr] = Object.entries(item)[0];
      const record = arr[0];
      record._recordId = recordId;
      all.push(record);
    }

    if (result.length < pageSize) break;
    sIndex += pageSize;
  }

  return all;
}

// ---- Books contacts cache (per org, short-lived) ----
const contactsCache = {};
const CACHE_TTL_MS = 4 * 60 * 1000;

async function getAllContacts(config) {
  const cacheKey = config.orgId;
  const cached = contactsCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  const accessToken = await getAccessToken(config.dc, config.clientId, config.clientSecret, config.refreshToken);
  let page = 1;
  let allContacts = [];
  let hasMore = true;

  while (hasMore) {
    const resp = await axios.get(
      `https://www.zohoapis.${config.dc}/books/v3/contacts?organization_id=${config.orgId}&page=${page}&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
    );
    allContacts.push(...resp.data.contacts);
    hasMore = resp.data.page_context?.has_more_page || false;
    page++;
  }

  contactsCache[cacheKey] = { data: allContacts, fetchedAt: Date.now() };
  return allContacts;
}

// ---- Dynamic customer_id resolution — EXACT match only ----
async function resolveCustomerId(clientName, config) {
  if (!clientName) throw new Error("Project has no Client Name set.");
  const contacts = await getAllContacts(config);
  const normalized = clientName.trim().toLowerCase();
  const matches = contacts.filter(
    c => c.contact_type === "customer" && c.contact_name.trim().toLowerCase() === normalized
  );

  if (matches.length === 0) {
    throw new Error(
      `No Books customer contact found matching "${clientName}" in org ${config.orgId}. ` +
      `Create the contact in Books with this exact name first.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Books contacts match "${clientName}" in org ${config.orgId} ` +
      `(IDs: ${matches.map(m => m.contact_id).join(", ")}). Resolve the duplicate manually.`
    );
  }
  return matches[0].contact_id;
}

// ---- Dynamic currency_id resolution ----
async function resolveCurrencyId(currencyCode, config) {
  if (!currencyCode) throw new Error("Project has no Currency set.");
  const contacts = await getAllContacts(config);
  const match = contacts.find(c => c.currency_code === currencyCode);
  if (!match) {
    throw new Error(
      `No existing Books contact in org ${config.orgId} uses currency "${currencyCode}".`
    );
  }
  return match.currency_id;
}

// ---- Dedup + reconciliation check ----
// Returns { exists: bool, amountMismatch: bool, existingInvoice: obj|null }
// If exists=true, the caller must NOT push a new invoice - dedup by
// reference_number (the People record ID) is authoritative.
// If amountMismatch=true, the current project_revenue no longer matches
// what was actually invoiced. This is logged loudly and never auto-fixed.
async function checkExistingInvoice(project, config) {
  const accessToken = await getAccessToken(config.dc, config.clientId, config.clientSecret, config.refreshToken);
  const resp = await axios.get(
    `https://www.zohoapis.${config.dc}/books/v3/invoices?organization_id=${config.orgId}&reference_number=${project._recordId}`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );
  const invoices = resp.data.invoices || [];
  if (invoices.length === 0) {
    return { exists: false, amountMismatch: false, existingInvoice: null };
  }

  const existing = invoices[0];
  const currentRevenue = Number(project.project_revenue) || 0;
  const amountMismatch = Math.abs(existing.total - currentRevenue) > 0.01;

  if (amountMismatch) {
    console.warn(
      `MISMATCH: Project ${project._recordId} (${project.Project_Name}) has invoice ` +
      `${existing.invoice_number} for ${existing.total}, but current project_revenue is ` +
      `${currentRevenue}. NOT auto-correcting. Review manually - possible credit note or ` +
      `new invoice needed.`
    );
  }

  return { exists: true, amountMismatch, existingInvoice: existing };
}

// ---- Invoice numbering (16-char limit, manual numbering org) ----
function generateInvoiceNumber() {
  const now = Date.now().toString(36).toUpperCase();
  return `INV-${now}`;
}

// ---- Push a Fixed Billing draft invoice for one project ----
async function pushFixedInvoice(project) {
  const entity = project.billing_entity;
  const config = BOOKS_CONFIG[entity];
  if (!config) throw new Error(`No Books config for entity: "${entity}"`);
  if (!config.orgId) throw new Error(`Missing org_id for entity: "${entity}"`);

  const revenue = Number(project.project_revenue);
  if (!revenue) throw new Error(`Project has no project_revenue set. Skipping.`);

  const accessToken = await getAccessToken(config.dc, config.clientId, config.clientSecret, config.refreshToken);
  const customerId = await resolveCustomerId(project.ClientId, config);
  const currencyId = await resolveCurrencyId(project.currency, config);

  const invoicePayload = {
    customer_id: customerId,
    invoice_number: generateInvoiceNumber(),
    currency_id: currencyId,
    reference_number: project._recordId,
    line_items: [
      {
        name: `${project.Project_Name} - Fixed Billing`,
        rate: revenue,
        quantity: 1,
      },
    ],
  };

  const url = `https://www.zohoapis.${config.dc}/books/v3/invoices?organization_id=${config.orgId}`;
  const resp = await axios.post(url, invoicePayload, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" },
  });
  return resp.data.invoice;
}

// ---- Poll cycle ----
async function pollAndPushFixedInvoices() {
  console.log(`[${new Date().toISOString()}] Starting poll cycle...`);
  let processed = 0;
  let failed = 0;
  let mismatches = 0;

  const allProjects = await getAllProjects();

  for (const project of allProjects) {
    const isCompleted = project.Status === "Completed" || project.status1 === "Completed";
    const isFixed = project.billing_model === "Fixed Billing";
    if (!(isCompleted && isFixed)) continue;

    const config = BOOKS_CONFIG[project.billing_entity];
    if (!config) continue;

    try {
      const check = await checkExistingInvoice(project, config);

      if (check.exists) {
        if (check.amountMismatch) mismatches++;
        continue; // never re-push, never auto-correct
      }

      console.log(`Pushing invoice for ${project._recordId} (${project.Project_Name})`);
      const invoice = await pushFixedInvoice(project);
      console.log(`  -> Success: ${invoice.invoice_number}`);
      processed++;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  -> Failed for ${project._recordId}: ${detail}`);
      failed++;
    }
  }

  console.log(`Poll cycle complete. Pushed: ${processed}, Failed: ${failed}, Mismatches flagged: ${mismatches}`);
}

// ---- Dormant webhook endpoint (fallback) ----
app.post("/webhook/project-completed", async (req, res) => {
  const zohoId = req.query.Zoho_ID || req.body.Zoho_ID;
  if (!zohoId) return res.status(400).send("Missing Zoho_ID");

  try {
    const allProjects = await getAllProjects();
    const project = allProjects.find(p => p._recordId === String(zohoId));
    if (!project) throw new Error(`No project found for Zoho_ID ${zohoId}`);
    if (project.billing_model !== "Fixed Billing") {
      return res.status(200).send("Not Fixed Billing, skipped");
    }

    const config = BOOKS_CONFIG[project.billing_entity];
    if (!config) throw new Error(`No Books config for entity: "${project.billing_entity}"`);

    const check = await checkExistingInvoice(project, config);
    if (check.exists) {
      return res.status(200).send(
        check.amountMismatch
          ? `Already invoiced (${check.existingInvoice.invoice_number}) but amount MISMATCH - review manually.`
          : "Already invoiced."
      );
    }

    const invoice = await pushFixedInvoice(project);
    res.status(200).send(`Invoice ${invoice.invoice_number} created as draft`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(detail);
  }
});

// ---- Start polling ----
setInterval(pollAndPushFixedInvoices, 5 * 60 * 1000);
pollAndPushFixedInvoices().catch(err => console.error("Initial poll failed:", err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));