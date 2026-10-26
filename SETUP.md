# Setup

## Google sign-in and Drive (optional)

The app works as a guest without any of this. To let people sign in and save results to their own Google Drive you
need a Google OAuth Client ID that belongs to you. Everything runs in the browser, so there is no server or secret to
look after.

1. Open <https://console.cloud.google.com/>, create a project (for example "Reskin Mockups").
2. **APIs & Services > Library**: enable the **Google Drive API**.
3. **APIs & Services > OAuth consent screen**: choose **External**, fill in the app name, support email and
   your domain (`reskin.in`). Add the scopes `openid`, `email`, `profile` and
   `https://www.googleapis.com/auth/drive.file`. `drive.file` is a non-sensitive scope: the app can only see files and
   folders it creates itself, and never the rest of a user's Drive. While the app is in *Testing* mode only the test
   users you list can sign in; click **Publish app** when you are ready for everyone.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**. Under
   **Authorized JavaScript origins** add:
   - `https://reskin.in`
   - `http://localhost:5173` (for development)
5. Copy the client ID into `.env.local` next to `package.json`:

   ```
   VITE_GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
   ```

6. Restart `npm run dev`, or run `npm run build` for production. The client ID is public by design; it is not a secret.

### What signing in changes

- Mockups uploaded while signed in are kept until removed. Guest uploads are deleted after 24 hours.
- Signing in adopts the guest files already in the browser. Signing out puts kept files back on the 24-hour timer.
- Bulk exports and single images can be saved to a **Reskin Mockups** folder in the user's Drive.
- Signed-in users can switch on **Back up original PSDs to my Google Drive**. Each PSD is uploaded to the same folder after it
  is added (one at a time, resumable). It is off by default, and removing a mockup never deletes the Drive copy.
- Access tokens live in memory only and last about an hour. After a reload the app remembers who you were and asks
  Google for a fresh token the next time you use Drive.

## AI editing

No setup. Each user pastes their own Gemini API key (free from <https://aistudio.google.com/apikey>). The key stays in
their browser and is sent only to `generativelanguage.googleapis.com`. If they would rather use another tool, the
**Edit in your AI space** menu copies the image to the clipboard, saves it, and opens Gemini, ChatGPT, Claude, Copilot or
Firefly.
