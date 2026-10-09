require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { bcGetAllPages, bcPost } = require("./bcClient");

// BC OData special characters (', (, )) inside a $filter string value
// must be percent-encoded, and a literal single quote inside an OData
// string literal is escaped by doubling it ('' not \').
function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------
// POST /pull-assets
// Imports every Fixed Asset from Business Central into assets_bc
// (the same table the UI reads). Safe to run repeatedly: rows are
// matched on the BC Fixed Asset "No." and only the BC-owned columns
// are refreshed, so edits made inside the app (stored in `data`)
// are never overwritten.
// ---------------------------------------------------------------
app.post("/pull-assets", async (req, res) => {
  try {
    const bcAssets = await bcGetAllPages("/FixedAsset");
    const now = new Date().toISOString();

    const rows = bcAssets.map((a) => ({
      id: a.No,
      bc_object_id: a.No,
      asset_name: a.Description || null,
      // "Asset type" (used for access control) = BC FA subclass, e.g. CAR, MACHINE
      object_type: a.FA_Subclass_Code || a.FA_Class_Code || null,
      functional_location: a.FA_Location_Code || null,
      lifecycle_state: a.Blocked
        ? "Down"
        : a.Under_Maintenance
        ? "Under maintenance"
        : a.Inactive
        ? "Idle"
        : "Operational",
      object_active: !a.Inactive && !a.Blocked,
      serial_id: a.Serial_No || null,
      bc_class_code: a.FA_Class_Code || null,
      bc_subclass_code: a.FA_Subclass_Code || null,
      updated_at: now,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("assets_bc")
        .upsert(rows.slice(i, i + 500), { onConflict: "id" });
      if (error) throw error;
    }

    res.json({ success: true, totalFromBC: rows.length });
  } catch (err) {
    console.error("pull-assets failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------------------------------------------------------------
// POST /pull-resources
// Imports every BC Resource of Type "Person" (/ResourcesDetails) into
// workers_bc, so the Technician dropdown on a work order is populated
// with real BC technicians instead of being empty. Resources of Type
// "Machine" are skipped — only people get assigned as technicians.
// Safe to run repeatedly: matched on personnel_number (the BC Resource
// "No."), so re-running just refreshes name/group.
// ---------------------------------------------------------------
app.post("/pull-resources", async (req, res) => {
  try {
    const resources = await bcGetAllPages("/ResourcesDetails");
    const now = new Date().toISOString();

    const rows = resources
      .filter((r) => r.Type === "Person")
      .map((r) => ({
        personnel_number: r.No,
        worker_name: r.Name,
        worker_group: r.Resource_Group_No || null,
        updated_at: now,
      }));

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("workers_bc")
        .upsert(rows.slice(i, i + 500), { onConflict: "personnel_number" });
      if (error) throw error;
    }

    res.json({ success: true, totalFromBC: rows.length });
  } catch (err) {
    console.error("pull-resources failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------------------------------------------------------------
// POST /sync-workorder-to-bc
//
// Fires when a Manager approves a breakdown report in the app. Creates
// the work order's header record in Business Central as a Sales Order
// (BC's /SalesOrdercard — a customized Sales Order page carrying extra
// work-order fields: Work_Order_Type, Fixed_Asset_No, Reported_By,
// Precedence, WorkDescription, etc.), then one line on it (BC's
// /SalesLinesDetails) of Type "Fixed Asset" pointing at the same asset —
// using the asset's own BC No. means this never hits an "item/resource
// not found" error, since it's already a number we pulled from BC
// ourselves. The line failing doesn't undo the header: the response
// reports both outcomes and the app logs whichever happened.
//
// Body: { reportNumber, title, description, maintenanceType, bcAssetId,
//          requestedBy }
// Requires BC_INTERNAL_CUSTOMER_NO in .env — a real BC Customer "No."
// (plain code like "10000", not a GUID) used as Sell_to_Customer_No,
// since BC's Sales Order always needs a customer.
// ---------------------------------------------------------------
app.post("/sync-workorder-to-bc", async (req, res) => {
  const customerNo = process.env.BC_INTERNAL_CUSTOMER_NO;
  if (!customerNo) {
    return res.status(500).json({ error: "BC_INTERNAL_CUSTOMER_NO is not set in .env" });
  }

  const { reportNumber, title, description, maintenanceType, bcAssetId, requestedBy } = req.body;
  let order;

  try {
    order = await bcPost("/SalesOrdercard", {
      Sell_to_Customer_No: customerNo,
      External_Document_No: reportNumber || "",
      Work_Order_Type: maintenanceType === "Preventive" ? "Preventive" : "Breakdown",
      Fixed_Asset_No: bcAssetId || "",
      Reported_By: requestedBy || "",
      Posting_Description: title || "",
      WorkDescription: description || "",
      Precedence: "Normal",
    });
  } catch (err) {
    console.error("sync-workorder-to-bc (header) failed:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }

  // Header is created at this point. The line is best-effort: if it
  // fails (or there's no bcAssetId to put on it), the header sync still
  // counts as a success — the app can always add the line manually in BC.
  let lineCreated = false;
  let lineError = null;
  if (bcAssetId) {
    try {
      await bcPost("/SalesLinesDetails", {
        Document_Type: "Order",
        Document_No: order.No,
        Line_No: 10000,
        Type: "Fixed Asset",
        No: bcAssetId,
        Description: title || "",
        Quantity: 1,
      });
      lineCreated = true;
    } catch (err) {
      lineError = err.response?.data?.error?.message || err.message;
      console.error("sync-workorder-to-bc (line) failed:", lineError);
    }
  } else {
    lineError = "No bcAssetId available — asset may not be synced to BC yet";
  }

  res.json({ success: true, bcWorkOrderId: order.No, status: order.Status, lineCreated, lineError });
});

// ---------------------------------------------------------------
// Shared helper: append ONE NEW Sales Line to an existing Sales Order
// (Document_Type "Order"). Used by both /sync-labor-to-bc (Type
// "Resource") and /sync-material-to-bc (Type "Item") below. Reads the
// order's current highest Line_No and adds 10000, so every call
// appends a fresh line rather than overwriting a previous one — the
// same order can end up with the asset line (created at approval
// time), one or more Resource lines, and one or more Item lines.
// ---------------------------------------------------------------
async function appendSalesLine({ documentNo, type, lineNo, description, quantity }) {
  const filter = `Document_Type eq 'Order' and Document_No eq '${odataEscape(documentNo)}'`;
  const existingLines = await bcGetAllPages(
    `/SalesLinesDetails?$filter=${encodeURIComponent(filter)}`
  );
  const maxLineNo = existingLines.reduce((max, l) => Math.max(max, l.Line_No || 0), 0);
  const nextLineNo = maxLineNo + 10000;

  const line = await bcPost("/SalesLinesDetails", {
    Document_Type: "Order",
    Document_No: documentNo,
    Line_No: nextLineNo,
    Type: type,
    No: lineNo,
    Description: description || "",
    Quantity: quantity,
  });

  return { nextLineNo, line };
}

// ---------------------------------------------------------------
// POST /sync-labor-to-bc
//
// Fires every time a technician's hours are logged in the Technician
// Labor Log ("Add" button). Adds a Sales Line of Type "Resource"
// (No = the technician's BC Resource No.) to the work order's existing
// Sales Order — the same order created by /sync-workorder-to-bc when
// the manager approved the report.
//
// Body: { documentNo, resourceNo, hours, description? }
// ---------------------------------------------------------------
app.post("/sync-labor-to-bc", async (req, res) => {
  const { documentNo, resourceNo, hours, description } = req.body;
  if (!documentNo || !resourceNo || !hours) {
    return res.status(400).json({ error: "documentNo, resourceNo and hours are required" });
  }

  try {
    const { nextLineNo, line } = await appendSalesLine({
      documentNo,
      type: "Resource",
      lineNo: resourceNo,
      description,
      quantity: hours,
    });
    res.json({ success: true, lineNo: nextLineNo, line });
  } catch (err) {
    console.error("sync-labor-to-bc failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------------------------------------------------------------
// POST /sync-material-to-bc
//
// Fires every time a part is logged in Material Consumption
// ("+ Add Material" button). Adds a Sales Line of Type "Item"
// (No = the BC Item No. picked in the Select Material dropdown) to
// the work order's existing Sales Order.
//
// Body: { documentNo, itemNo, quantity, description? }
// ---------------------------------------------------------------
app.post("/sync-material-to-bc", async (req, res) => {
  const { documentNo, itemNo, quantity, description } = req.body;
  if (!documentNo || !itemNo || !quantity) {
    return res.status(400).json({ error: "documentNo, itemNo and quantity are required" });
  }

  try {
    const { nextLineNo, line } = await appendSalesLine({
      documentNo,
      type: "Item",
      lineNo: itemNo,
      description,
      quantity,
    });
    res.json({ success: true, lineNo: nextLineNo, line });
  } catch (err) {
    console.error("sync-material-to-bc failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------------------------------------------------------------
// POST /pull-items
// Imports item master data (No + Description) into bc_items, used by
// the Material Consumption "Select Material" dropdown. Reads BC's
// /itemDetailsData, which is real Item master data (unlike
// /ItemInventory, which is just ledger entries with blank
// descriptions) — so this always has a proper name per item.
// ---------------------------------------------------------------
app.post("/pull-items", async (req, res) => {
  try {
    const bcItems = await bcGetAllPages("/itemDetailsData");
    const now = new Date().toISOString();

    const rows = bcItems
      .filter((i) => i.No)
      .map((i) => ({
        item_id: i.No,
        product_name: i.Description || i.No,
        updated_at: now,
      }));

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("bc_items")
        .upsert(rows.slice(i, i + 500), { onConflict: "item_id" });
      if (error) throw error;
    }

    res.json({ success: true, totalFromBC: rows.length });
  } catch (err) {
    console.error("pull-items failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------------------------------------------------------------
// Admin helpers (need the service_role key, so they live here)
// ---------------------------------------------------------------
app.get("/users", async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;
    res.json({ users: data.users.map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at })) });
  } catch (err) {
    console.error("list users failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Body: { email, password, name?, role? } — creates a login and its
// profile row, so it shows up on the Team page straight away.
app.post("/users", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    const { error: profileError } = await supabase.from("profiles").upsert({
      id: data.user.id,
      name: name || email,
      email,
      role: role || "user",
    });
    if (profileError) throw profileError;

    res.json({ success: true, user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    console.error("create user failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`bc-local-sync listening on http://localhost:${PORT}`));
