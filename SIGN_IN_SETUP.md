# Setting up "Sign in with Google / Microsoft"

The app works without this: everyone is a guest with a private, per-browser library. Set up one or both providers to let people sign in and keep their library across devices.

You register the app once with each provider and get a **client ID** (public) and a **client secret** (private, treat it like a password).

> **Use your personal Google/Microsoft account for this, not a work account.** This is a personal learning project, so keep its app registrations out of your employer's cloud organization.

## Important: always open the app at `http://localhost:8766`

Use `localhost`, not `127.0.0.1`. The sign-in callback comes back to `localhost`, and the browser only sends the app's cookies to the exact host you started on. Mixing the two makes sign-in fail with "you're still a guest".

---

## Google

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "pdf-assistant").
2. Open **Google Auth Platform** (called "OAuth consent screen" in older menus):
   - **Branding:** app name "PDF Assistant", your email as support and developer contact.
   - **Audience:** choose **External**. While the app is in **Testing**, add your own Google address under **Test users**. Only test users can sign in until you publish the app.
   - **Data access:** the default `openid`, `email` and `profile` scopes are all the app needs.
3. Open **Clients → Create client**:
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:8766/auth/google/callback`
4. Copy the **Client ID** and **Client secret**.

## Microsoft

1. Go to <https://entra.microsoft.com/> (or the Azure portal) → **App registrations → New registration**.
   - Name: "PDF Assistant"
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: platform **Web**, `http://localhost:8766/auth/microsoft/callback`
2. On the app's **Overview** page, copy the **Application (client) ID**.
3. **Certificates & secrets → New client secret.** Copy the secret's **Value** right away (it's shown once; the "Secret ID" is not the secret). Note the expiry date; sign-in stops working when it expires.

---

## Run the app with sign-in switched on

Put the values in a private `.env` file in the project folder. The app reads it on start-up, and `.gitignore` keeps it out of Git.

```bash
cd project2-pdf-assistant   # this folder
cp .env.example .env
open -e .env
```

Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (and the Microsoft pair if you set it up), save, then restart the server:

```bash
../.venv/bin/uvicorn api:app --port 8766
```

Open <http://localhost:8766>. A **Sign in** button appears top right with the providers you set up.

**Keep secrets out of your code, Git and chats.** Only the `.env` file should contain them.

## When you deploy

1. Add the deployed callback URLs to each provider, e.g. `https://your-app.example.com/auth/google/callback`.
2. Set these on the server as well as the client IDs and secrets:
   - `PUBLIC_URL=https://your-app.example.com`: builds the right callback URL and turns on HTTPS-only cookies.
   - `SESSION_SECRET=<a long random string>`: keeps people signed in across restarts and server copies.
3. On Google, move the app from **Testing** to **In production** so people other than test users can sign in.

## What happens on sign-in

1. You pick Google or Microsoft, sign in on **their** page (the app never sees your password), and get sent back.
2. The app checks the sign-in token: the provider's signature, that it was issued for this app, the issuer, expiry, and a one-time `nonce`.
3. Your library ID comes from the provider's **permanent user ID**, never your email, because emails can change or be reassigned.
4. Any PDFs you uploaded as a guest in this browser move into your account.
5. **Sign out** turns the browser back into a new, empty guest. Your account's PDFs stay in your account.

## Troubleshooting

| Message or symptom | Likely cause |
|---|---|
| "Sign-in didn't complete, so you're still a guest" | You opened the app on `127.0.0.1` but the callback went to `localhost` (or the other way round), you cancelled, or you took over 10 minutes. |
| Google: `redirect_uri_mismatch` | The redirect URI in Google's console doesn't exactly match `http://localhost:8766/auth/google/callback`. |
| Google: "Access blocked: app is in testing" | Add your address as a **Test user**. |
| Microsoft: `AADSTS50011` | The redirect URI in the app registration doesn't match. |
| Microsoft: `AADSTS7000215` | Wrong client secret: you probably copied the Secret ID instead of its Value. |
| No **Sign in** button | Both the client ID and secret need to be set for that provider, and the server restarted afterwards. |
