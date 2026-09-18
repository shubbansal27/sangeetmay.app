// ── YouTube Upload Configuration ─────────────────────────────────────────────
//
// To enable Google sign-in and YouTube uploads:
//
//  1. Go to https://console.cloud.google.com/
//  2. Create a project (or select an existing one)
//  3. Enable "YouTube Data API v3":
//       APIs & Services → Library → search "YouTube Data API v3" → Enable
//  4. Create OAuth 2.0 credentials:
//       APIs & Services → Credentials → Create Credentials → OAuth client ID
//       • Application type: Web application
//       • Authorised JavaScript origins:  http://localhost:9000
//       • Authorised redirect URIs:       http://localhost:9000/auth/callback
//         (change 9000 to the port you use if different)
//  5. Copy the Client ID below and save this file.
//
// ─────────────────────────────────────────────────────────────────────────────

window.PM_YT_CLIENT_ID = '19182038100-s6pu6n2kthvr7l1te42rgbqgm0tr7htd.apps.googleusercontent.com'; // ← paste your Client ID here
