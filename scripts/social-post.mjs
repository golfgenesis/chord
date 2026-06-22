// Social auto-distribution — posts a link to the channels you've configured
// (Telegram, Facebook Page, LINE Official Account, X). This is white-hat SEO
// help: it drives REAL readers and gives search engines fresh links to discover
// the page (NOT fake traffic). Each channel fires only if its env vars are set,
// so the script is safe to run before any account exists — it no-ops per channel.
//
// Usage:
//   node scripts/social-post.mjs <url> "<title>" ["<summary>"]   → post that page
//
// Env (set in your shell / a private .env — NEVER commit tokens):
//   Telegram (easiest, recommended first):  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Facebook Page:                           FB_PAGE_ID, FB_PAGE_TOKEN
//   LINE Official Account (broadcast):       LINE_CHANNEL_TOKEN
//   X / Twitter (needs user-context OAuth):  X_BEARER_TOKEN   (see note below)
//
// Best-effort: logs per channel and never exits non-zero, so it can't block a
// publish pipeline. Ported from the tetono project (article/news lookup removed —
// chord has no markdown content, so it takes an explicit URL).

import { SITE_NAME } from "./_site.mjs";

// ---- compose the post text (pure) -------------------------------------------
function compose({ url, title, summary }) {
  const parts = [title.trim() || url];
  if (summary && summary.trim()) parts.push(summary.trim());
  parts.push(url);
  parts.push(`\n— ${SITE_NAME}`);
  return parts.join("\n\n");
}

// ---- channels (each no-ops unless its env is present) -----------------------
async function postTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
  });
  console.log(`  telegram: HTTP ${res.status}`);
}

async function postFacebook(text, url) {
  const id = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_TOKEN;
  if (!id || !token) return;
  const body = new URLSearchParams({ message: text, link: url, access_token: token });
  const res = await fetch(`https://graph.facebook.com/v21.0/${id}/feed`, { method: "POST", body });
  console.log(`  facebook: HTTP ${res.status}`);
}

async function postLine(text) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  if (!token) return;
  // Messaging API broadcast → reaches the OA's followers.
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  console.log(`  line: HTTP ${res.status}`);
}

async function postX(text) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return;
  // NOTE: POST /2/tweets needs a USER-CONTEXT token (OAuth 2.0 PKCE or OAuth 1.0a),
  // not an app-only bearer — an app bearer returns 403. Wire your user token here.
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: text.slice(0, 280) }),
  });
  console.log(`  x: HTTP ${res.status}`);
}

async function main() {
  const [url, title, summary] = process.argv.slice(2);
  if (!url) {
    return console.log('social: nothing to post. Pass <url> "<title>" ["<summary>"].');
  }

  const text = compose({ url, title: title ?? "", summary: summary ?? "" });
  console.log(`social: posting → ${url}`);
  // Run channels independently; one failing must not stop the others.
  const results = await Promise.allSettled([
    postTelegram(text),
    postFacebook(text, url),
    postLine(text),
    postX(text),
  ]);
  for (const r of results)
    if (r.status === "rejected") console.warn("  channel error:", r.reason?.message ?? r.reason);
  const anyConfigured =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.FB_PAGE_TOKEN ||
    process.env.LINE_CHANNEL_TOKEN ||
    process.env.X_BEARER_TOKEN;
  if (!anyConfigured) console.log("  (no channels configured — set tokens in env to enable)");
}

main().catch((err) => console.warn("social: skipped —", err.message));
