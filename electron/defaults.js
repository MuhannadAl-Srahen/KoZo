'use strict'

// Built-in defaults so nobody has to paste keys to get the basics:
// - DISCORD_CLIENT_ID: KoZo's own Discord application (an ID, not a secret;
//   Discord has no usage limit on it). Rich Presence works with just the toggle.
// - STEAMGRIDDB_KEY: a SteamGridDB API key used for covers of non-Steam games
//   when the user hasn't set their own. Put KoZo's key here (Settings shows
//   "built in" once it is set). It ships inside the app, so use a key made for
//   KoZo, not a personal one you care about.
// A key the user enters in Settings → Accounts always wins over these.
// The Steam Web API key has no default: Steam limits each key to 100,000 calls
// a day and its terms don't allow sharing one, and public profiles don't need it.

module.exports = {
  DISCORD_CLIENT_ID: '1566355924489338952',
  STEAMGRIDDB_KEY: '',
}
