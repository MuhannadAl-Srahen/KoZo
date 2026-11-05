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
needs a public site on a domain you own. That's `site/`, at <https://kozoapp.cloud>:

| Branding field | Value |
|---|---|
| Application home page | `https://kozoapp.cloud/` |
| Application privacy policy link | `https://kozoapp.cloud/privacy.html` |
| Application terms of service link | `https://kozoapp.cloud/terms.html` (optional for Google) |
| Authorized domains | `kozoapp.cloud` |

Google's rules, which the site meets: the homepage describes what KoZo does, isn't only
a login page, and links the same privacy address as the consent screen. The privacy
policy is on the same domain and says how KoZo uses Google data. The domain must be
verified in Google Search Console by an owner or editor of the Google project.

Remove any logo from Branding until you're ready to submit, because a logo requires
verification. Then:

1. Connect the domain and publish the site (below), and check the three links open.
2. **Google Search Console**: add `kozoapp.cloud` as a Domain property and add the TXT
   record it gives you in Hostinger.
3. **Branding**: enter the table above.
4. **Verification Center**: submit for review. An automated review usually takes
   minutes, a manual one 2 to 3 business days. Branding can't be edited during it, and
   after it passes you have 7 days to publish the branding.

This is the lighter check. The stricter review is only for sensitive scopes.

### Connecting kozoapp.cloud to GitHub Pages

The order matters: GitHub says to add the domain in its settings before pointing DNS at it.

1. GitHub > your profile > Settings > Pages > **Add a domain**: `kozoapp.cloud`. Add the
   TXT record it gives you in Hostinger, then press Verify. This stops anyone else from
   using the domain on GitHub.
2. The repo > Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. Publish: `.github/workflows/site.yml` runs when `site/` changes on `main`.
4. The same page > Custom domain: `kozoapp.cloud` > Save. A CNAME file does nothing with
   a workflow like this one.
5. Hostinger > Domains > kozoapp.cloud > DNS / Nameservers > DNS records. Remove any
   existing `A` record at `@` and `CNAME` at `www`, then add:

   | Type | Name | Points to |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | AAAA | @ | 2606:50c0:8000::153 |
   | AAAA | @ | 2606:50c0:8001::153 |
   | AAAA | @ | 2606:50c0:8002::153 |
   | AAAA | @ | 2606:50c0:8003::153 |
   | CNAME | www | muhannadal-srahen.github.io |

   Never add a wildcard (`*`) record: GitHub warns it allows a takeover even on a
   verified domain. Changes can take up to 24 hours.
6. Back on GitHub's Pages page, tick **Enforce HTTPS** when it becomes available (up to
   24 hours).

## Two PCs on one Google account

Each KoZo install keeps its own library file on Drive, so two PCs never overwrite each
other. Signing in on a PC when the account already holds another PC's backup asks three
questions, one after another: add the Game List, add the Library, add the game saves.
Nothing comes down until the answer is yes, and games already here aren't added twice.

Later, when the other PC has something new, a bar at the top of KoZo says so, and its
button opens the same three questions. KoZo looks once an hour when no game is running.

Both PCs must use the same Google client. `drive.file` only shows files made by that
same client, so a PC using a client pasted under **Use your own Google client** can't
see what a release build uploaded with the built-in one, and the other way round. It
just looks like an empty account.

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
