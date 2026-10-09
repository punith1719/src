// NTLM client for on-prem Business Central OData v4.
// Uses axios-ntlm, which handles the NTLM handshake (something plain
// fetch/axios can't do) — this is why this has to run as a local
// service instead of a Supabase Edge Function.

require("dotenv").config();
const { NtlmClient } = require("axios-ntlm");

const BC_BASE_URL = process.env.BC_BASE_URL;

const client = NtlmClient(
  {
    username: process.env.BC_USERNAME,
    password: process.env.BC_PASSWORD,
    domain: process.env.BC_DOMAIN || "",
    workstation: process.env.BC_WORKSTATION || "",
  },
  {
    baseURL: BC_BASE_URL,
    headers: { "Content-Type": "application/json" },
  },
);

// GET a single record or list. `path` is relative to BC_BASE_URL,
// e.g. "/FixedAsset" or "/FixedAsset(No='FA000010')"
async function bcGet(path) {
  const res = await client.get(path);
  return res.data;
}

async function bcPost(path, body) {
  const res = await client.post(path, body);
  return res.data;
}

// PATCH requires the current @odata.etag via If-Match — fetch the
// record first (bcGet) to get it before calling this.
async function bcPatch(path, body, etag) {
  const res = await client.patch(path, body, {
    headers: { "If-Match": etag },
  });
  return res.data;
}

// GET all pages of a list endpoint, following @odata.nextLink until
// exhausted. Used for bulk pulls like "get every Fixed Asset".
async function bcGetAllPages(path) {
  let all = [];
  let next = path;
  while (next) {
    const res = await client.get(next);
    all = all.concat(res.data.value || []);
    next = res.data["@odata.nextLink"] || null;
  }
  return all;
}

module.exports = { bcGet, bcGetAllPages, bcPost, bcPatch };
