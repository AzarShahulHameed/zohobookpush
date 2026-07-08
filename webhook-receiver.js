/**
 * Webhook receiver for Zoho People -> Zoho Books invoice automation
 * Zoho People's Workflow Rule calls this endpoint (POST) when:
 *   Status = Completed AND Billing Model = Fixed Billing AND Invoice Pushed = False
 * Zoho passes Zoho_ID as a URL query parameter (configured in the webhook's
 * "URL query parameters" section: Zoho_ID = Zoho ID (Projects)).
 *
 * This script does NOT handle T&M (runs on its own schedule, not status-triggered)
 * or Milestone (separate workflow watching Milestone Master, not this form).
 */

require("dotenv").config();
console.log("ZOHO_IN_CLIENT_ID present:", !!process.env.ZOHO_IN_CLIENT_ID);
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Config: env vars, fill these in ----
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

// ---- Token helpers ----
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

// ---- Zoho People: fetch full project record by Zoho_ID ----
async function getProjectById(zohoId) {
  const accessToken = await getAccessToken("in", PEOPLE_CLIENT_ID, PEOPLE_CLIENT_SECRET, PEOPLE_REFRESH_TOKEN);
  const url = `https://people.zoho.in/people/api/forms/P_TimesheetJobsList/getRecords`;

  let sIndex = 1;
  const pageSize = 200;
  let record = null;
  let totalScanned = 0;

  while (!record) {
    const resp = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params: { sIndex, limit: pageSize },
    });

    const result = resp.data.response.result;
    if (!result || !Array.isArray(result) || result.length === 0) break;

    for (const item of result) {
      const [recordId, arr] = Object.entries(item)[0];
      totalScanned++;
      if (recordId === String(zohoId)) {
        record = arr[0];
        record._recordId = recordId;
        break;
      }
    }

    if (record || result.length < pageSize) break;
    sIndex += pageSize;
  }

  console.log(`Total scanned: ${totalScanned}, found: ${!!record}`);
  if (!record) throw new Error(`No project found for Zoho_ID ${zohoId}`);
  return record;
}
// ---- Zoho People: mark invoice_pushed = true ----
async function markInvoicePushed(zohoId) {
  const accessToken = await getAccessToken("in", PEOPLE_CLIENT_ID, PEOPLE_CLIENT_SECRET, PEOPLE_REFRESH_TOKEN);
  const url = `https://people.zoho.in/people/api/forms/P_TimesheetJobsList/updateRecord`;
  await axios.post(url, null, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: {
      recordId: zohoId,
      inputData: JSON.stringify({ invoice_pushed: true }),
    },
  });
}

// ---- Zoho Books: push draft invoice ----
const CURRENCY_ID_MAP = {
  "NoblQ India": {
    INR: "PASTE_INR_CURRENCY_ID_FROM_BOOKS",
  },
  "NoblQ USA": {
    USD: "PASTE_USD_CURRENCY_ID_FROM_BOOKS",
  },
};

async function resolveCurrencyId(currencyCode, entity, config) {
  const currencyId = CURRENCY_ID_MAP[entity]?.[currencyCode];
  if (!currencyId) {
    throw new Error(`No currency_id mapping for "${currencyCode}" in entity "${entity}". Fetch it from GET /books/v3/settings/currencies and add it to CURRENCY_ID_MAP.`);
  }
  return currencyId;
}

async function pushFixedInvoice(project) {
  const entity = project.billing_entity;
  const config = BOOKS_CONFIG[entity];
  if (!config) throw new Error(`No Books config for entity: ${entity}`);
  if (!config.orgId) throw new Error(`Missing org_id for entity: ${entity}`);

  const revenue = Number(project.project_revenue);
  if (!revenue) throw new Error(`Project ${project._recordId} has no project_revenue set. Skipping.`);
  if (!project.currency) throw new Error(`Project ${project._recordId} has no currency set. Skipping until backfilled.`);

  const accessToken = await getAccessToken(config.dc, config.clientId, config.clientSecret, config.refreshToken);
  const customerId = await resolveCustomerId(project.ClientId, config);
  const currencyId = await resolveCurrencyId(project.currency, entity, config);

  const invoicePayload = {
    customer_id: customerId,
    invoice_number: generateInvoiceNumber(),
    currency_id: currencyId,
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
function generateInvoiceNumber() {
  const now = Date.now().toString(36).toUpperCase(); // base36 timestamp, compact
  return `INV-${now}`; // e.g. INV-M1A2B3C4 — well under 16 chars
}
// ---- STUB: resolve People client name -> Books contact_id ----
// This is the actual missing piece. You need a mapping table between
// project.ClientId (a name/CRM reference in People) and a real contact_id
// in the correct Books org. Do not guess-match by string name - build this
// as an explicit lookup (a config file, a Zoho People form, or a DB table)
// before this function can safely run in production.
// ---- People client name -> Books contact_id mapping ----
const CLIENT_TO_CUSTOMER_ID = {
  "Golden Chicken Farms and Company": "3842356000003627629",
};

async function resolveCustomerId(clientName, config) {
  const customerId = CLIENT_TO_CUSTOMER_ID[clientName];
  if (!customerId) {
    throw new Error(`No customer_id mapping for client "${clientName}" in org ${config.orgId}. Add it to CLIENT_TO_CUSTOMER_ID.`);
  }
  return customerId;
}

// ---- Webhook endpoint ----
app.post("/webhook/project-completed", async (req, res) => {
  const zohoId = req.query.Zoho_ID || req.body.Zoho_ID;
  if (!zohoId) {
    console.error("Webhook called with no Zoho_ID");
    return res.status(400).send("Missing Zoho_ID");
  }

  console.log(`Received webhook for project ${zohoId}`);

  try {
    const project = await getProjectById(zohoId);

    if (project.invoice_pushed === "true" || project.invoice_pushed === true) {
      console.log(`Project ${zohoId} already invoiced. Skipping.`);
      return res.status(200).send("Already invoiced");
    }
    if (project.billing_model !== "Fixed Billing") {
      console.log(`Project ${zohoId} is not Fixed Billing (${project.billing_model}). Skipping.`);
      return res.status(200).send("Not Fixed Billing, skipped");
    }

    const invoice = await pushFixedInvoice(project);
    await markInvoicePushed(zohoId);

    console.log(`Pushed draft invoice ${invoice.invoice_number} for project ${zohoId}`);
    res.status(200).send(`Invoice ${invoice.invoice_number} created as draft`);
  } catch (err) {
  const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  console.error(`Failed to process project ${zohoId}:`, detail);
  res.status(500).send(detail);
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook receiver listening on port ${PORT}`));
