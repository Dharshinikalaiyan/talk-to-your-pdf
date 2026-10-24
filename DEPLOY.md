# Deploy to Hugging Face Spaces (free)

Hugging Face Spaces gives the app a free server (2 CPUs, 16 GB RAM) and an HTTPS link that
works on phones, including the mic. Use your **personal** account
for every step here, never a work account.

What to expect on the free tier:
- The Space **sleeps after ~48 hours** with no visitors. The next visitor waits about a minute while it wakes.
- **Uploads don't survive a restart**, and they're deleted after 24 hours anyway (`UPLOAD_TTL_HOURS`).
  That's deliberate for a public demo: strangers' files don't pile up.

## 1. Create the Space

1. Sign up at https://huggingface.co/join with your **personal email** and confirm the email.
2. Go to https://huggingface.co/new-space and fill in:
   - **Space name:** `talk-to-your-pdf`
   - **License:** MIT (or leave empty)
   - **SDK:** Docker → **Blank**
   - **Hardware:** CPU basic (free)
   - **Visibility:** Public
3. Click **Create Space**. Your app's address will be:
   `https://<your-username>-talk-to-your-pdf.hf.space`

## 2. Add the settings and secrets

In the Space: **Settings → Variables and secrets**.

| Name | Type | Value |
|---|---|---|
| `SESSION_SECRET` | **Secret** | a long random string. Make one with: `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `PUBLIC_URL` | Variable | `https://<your-username>-talk-to-your-pdf.hf.space` (no slash at the end) |
| `GOOGLE_CLIENT_ID` | **Secret** | from Google Cloud (the same ones as in your `.env`) |
| `GOOGLE_CLIENT_SECRET` | **Secret** | from Google Cloud |
| `GROQ_API_KEY` | **Secret** | optional. Leave it out to stay 100% free (local answers) |

Paste values straight into Hugging Face. Don't put them in a file you commit, and don't paste them in a chat.

Already set in the Dockerfile (change them here if you like): `UPLOAD_TTL_HOURS=24`, `MAX_DOCS_PER_USER=20`.

## 3. Push the code

1. Make a token: https://huggingface.co/settings/tokens → **Create new token** → type **Write** → copy it.
2. In a terminal:

```bash
cd project2-pdf-assistant   # this folder
git remote add space https://huggingface.co/spaces/<your-username>/talk-to-your-pdf
git push --force space main
```

When git asks: **username** = your Hugging Face username, **password** = the token.
(`--force` replaces the placeholder README the new Space starts with.)

3. Open the Space page and watch **Logs → Build**. The first build takes about 10 minutes
   (it installs everything and downloads ~450 MB of models). When it says **Running**, you're live.

To update later: commit your changes, then `git push space main`.

## 4. Let Google sign-in work on the new address

In https://console.cloud.google.com (personal account), project you made for this app:

1. **APIs & Services → Credentials →** your OAuth client:
   - **Authorized JavaScript origins:** add `https://<your-username>-talk-to-your-pdf.hf.space`
   - **Authorized redirect URIs:** add `https://<your-username>-talk-to-your-pdf.hf.space/auth/google/callback`
   - Keep the `localhost` ones too, so it still works on your laptop. **Save.**
2. **OAuth consent screen** (Google Auth Platform → Audience): **Publish app** → status **In production**.
   While it says "Testing", only the test users you listed can sign in. The app only asks for
   name and email (`openid email profile`), so Google doesn't need to review it.

Changes can take a few minutes to apply.

## 5. Check it, then share

Open the link on your laptop **and your phone**:
- [ ] "Let's talk" opens the chat, the **L's** logo beats with the music
- [ ] Try the sample manual, ask "How long is the warranty?", tap **Page 5**: the PDF shows page 5
- [ ] Mic: tap, ask, tap again (allow the microphone when asked)
- [ ] Sign in with Google shows your name

**Share the direct link:** `https://<your-username>-talk-to-your-pdf.hf.space`.
Don't share the `huggingface.co/spaces/...` page: it shows the app inside a frame, where phone
browsers block the cookie that keeps each visitor's PDFs private, so uploads would seem to vanish.

## If something goes wrong

| What you see | Fix |
|---|---|
| Build fails | Logs → Build shows the error. Send it to me. |
| "Runtime error", out of memory | Unlikely on 16 GB; restart the Space (Settings → Restart). |
| Google says `redirect_uri_mismatch` | The redirect URI in step 4 doesn't exactly match `PUBLIC_URL` + `/auth/google/callback`. |
| Google says "access blocked" / "not a test user" | Step 4.2: publish the app. |
| Everyone gets logged out after a restart | `SESSION_SECRET` isn't set (step 2). |
