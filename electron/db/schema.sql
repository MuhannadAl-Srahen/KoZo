CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_app_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  exe_name TEXT NOT NULL,
  install_path TEXT,
  banner_url TEXT,
  banner_local_path TEXT,
  source TEXT NOT NULL,
  is_installed BOOLEAN DEFAULT 1,
  total_playtime_seconds INTEGER DEFAULT 0,
  first_played_at TIMESTAMP,
  last_played_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  duration_seconds INTEGER,
  achievements_unlocked INTEGER DEFAULT 0,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  steam_api_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  icon_url TEXT,
  icon_locked_url TEXT,
  global_unlock_percent REAL,
  is_hidden BOOLEAN DEFAULT 0,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  UNIQUE(game_id, steam_api_name)
);

CREATE TABLE IF NOT EXISTS achievement_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  achievement_id INTEGER NOT NULL,
  session_id INTEGER,
  -- Nullable: Steam reports unlocktime 0 for achievements it has no date for.
  -- The row's existence means unlocked; this column is only the display date.
  unlocked_at TIMESTAMP,
  source TEXT NOT NULL,
  FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  UNIQUE(achievement_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  steam_app_id INTEGER,
  name TEXT NOT NULL,
  banner_url TEXT,
  category_id INTEGER,
  status TEXT NOT NULL,
  rating REAL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- Spotify-playlist-style user lists; a game_list item can belong to many lists.
CREATE TABLE IF NOT EXISTS custom_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT,
  color TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_list_games (
  list_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (list_id, item_id),
  FOREIGN KEY (list_id) REFERENCES custom_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES game_list(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS scan_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT 1,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
