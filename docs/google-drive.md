# Google Drive sign-in (one-time, for the app maker)

KoZo can copy saves and the library to each user's own Google Drive, so it costs
you nothing and nobody shares space. Google only allows that through an OAuth
client the app maker creates once.

Nothing here is needed for KoZo's backups to work. Without it, the Google row
stays hidden, and users have Settings > Backups > **Your own cloud folder** (Google
Drive for Desktop, Dropbox, MEGA, iCloud, any folder or USB stick) and **Save to a
file** (one `.kozo` file).

## 1. Make the client

1. Open <https://console.cloud.google.com/projectcreate> and create a project.
2. Turn on the Google Drive API:
   <https://console.cloud.google.com/apis/library/drive.googleapis.com>.
3. Google Auth Platform > **Branding**: set the app name, your support email and
   the developer contact email. `Publish app` stays greyed out until this page is
   complete.
4. Google Auth Platform > **Clients** > Create client > type **Desktop app**. Copy
   the Client ID and the Client secret.

## 2. Use it on your own PC now

1. Google Auth Platform > **Audience** > **Test users** > add your Gmail.
2. In KoZo: Settings > Connections > Advanced > **Use your own Google client**.
   It is saved on that PC only and never exported.

While the status says "Testing", only listed test users can sign in (anyone else
gets `Error 403: access_denied`), the limit is 100 people, and Google signs them out
every 7 days. Adding emails is only for this stage. Nobody adds anyone once the app
is published.

## 3. Open it to everyone

Press **Publish app** on the **Audience** page. An app "In production" is "available
to any user with a Google Account", so no email lists any more and no 7-day sign-out.

KoZo only asks for `drive.file`, a non-sensitive scope, and Google says verification
"is not mandatory" for apps that use only non-sensitive scopes. So publishing may not
need to wait for the website. Google's pages don't say whether anything blocks the
button or what the sign-in screen shows without verification, so try it on your
account and check the screen. You can switch it back to Testing.

### What the website adds

Showing KoZo's name and logo on the sign-in screen needs **brand verification**, which
needs a website:

- A public **homepage** that describes what KoZo does. It can't be only a login
  page, and it must link to the privacy policy.
- A **privacy policy** on the same domain, saying how KoZo uses Google data: it
  asks only for `drive.file` (files it created itself), uses them only for the
  user's own backups, and has no server of its own.
- A **domain you own**, verified in Google Search Console and listed under
  Authorized domains. Google's docs don't say whether a `github.io` address counts,
  so try a free one first; a custom domain is the fallback.

Remove any logo from Branding until you're ready to submit, because a logo requires
verification. Then:

1. **Branding**: add the homepage, privacy policy and authorized domain.
2. **Verification Center**: submit for review.

This is the lighter check. The stricter review is only for sensitive scopes.

## 4. Build it into releases

The repo is public, so the client is not written in the code. In the GitHub repo,
open Settings > Secrets and variables > Actions and add:

- `KOZO_GOOGLE_CLIENT_ID`
- `KOZO_GOOGLE_CLIENT_SECRET`

`release.yml` writes them to `electron/defaults.local.js` (gitignored) before
building, so Settings > Connections and Settings > Backups show **Sign in with
Google**. Add them only after the app is published, or everyone else gets the 403
above. Google treats a desktop app's secret as not really secret, and the sign-in
also uses PKCE.
