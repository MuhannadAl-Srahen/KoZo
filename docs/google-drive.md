# Google Drive for every KoZo user (one-time, for the app maker)

KoZo copies saves and the library to the user's own Google Drive. Google only
lets an app do that through an OAuth client that the app maker creates once.
After you put that client into KoZo, users see one button, **Sign in with
Google**, and never a setup step.

## 1. Make the client (about five minutes)

1. Open <https://console.cloud.google.com/projectcreate> and create a project
   (for example "KoZo").
2. Turn on the Google Drive API:
   <https://console.cloud.google.com/apis/library/drive.googleapis.com>.
3. Google Auth Platform > **Branding**: set the app name (KoZo), your support
   email and the developer contact email.
4. Google Auth Platform > **Audience**: User type **External**, then press
   **Publish app** so the status reads **In production**.
   - While it says "Testing", only the emails listed under Test users can sign
     in (everyone else gets `Error 403: access_denied`), and sign-ins expire
     after 7 days.
   - KoZo only asks for `drive.file` (it sees only the files it made). That
     scope is not sensitive, so publishing needs no Google review.
5. Google Auth Platform > **Clients** > Create client > type **Desktop app**.
   Copy the Client ID and the Client secret.

## 2. Put it into KoZo

In `electron/defaults.js`:

```js
GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
GOOGLE_CLIENT_SECRET: 'GOCSPX-...',
```

A desktop app's client secret is not really secret (Google says so for
installed apps); the sign-in also uses PKCE.

Build and release. Settings > Connections and Settings > Backups now show
**Sign in with Google**, and a new PC gets everything back with
**Get everything back > From Google Drive**.

To try a client without rebuilding: Settings > Connections > Advanced >
**Use your own Google client** (saved on that PC only, never exported).

## Without Google

Settings > Backups > **Save to a file** writes one `.kozo` file with the
library, playtime and every save backup. On a new PC, **From a KoZo file**
(also offered on the first run) brings it all back.
