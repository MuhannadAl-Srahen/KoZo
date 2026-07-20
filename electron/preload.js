const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kozo', {
  api: {
    games: {
      list: () => ipcRenderer.invoke('games:list'),
      get: (id) => ipcRenderer.invoke('games:get', id),
      add: (data) => ipcRenderer.invoke('games:add', data),
      update: (id, data) => ipcRenderer.invoke('games:update', id, data),
      delete: (id) => ipcRenderer.invoke('games:delete', id),
      reorder: (orderedIds) => ipcRenderer.invoke('games:reorder', orderedIds),
      launch: (id) => ipcRenderer.invoke('games:launch', id),
    },
    sessions: {
      list: (filters) => ipcRenderer.invoke('sessions:list', filters),
      get: (id) => ipcRenderer.invoke('sessions:get', id),
      getForGame: (gameId) => ipcRenderer.invoke('sessions:getForGame', gameId),
      active: () => ipcRenderer.invoke('sessions:active'),
    },
    achievements: {
      hub: () => ipcRenderer.invoke('achievements:hub'),
      listForGame: (gameId) => ipcRenderer.invoke('achievements:listForGame', gameId),
      listAll: (filters) => ipcRenderer.invoke('achievements:listAll', filters),
      listUnlocksForGame: (gameId) => ipcRenderer.invoke('achievements:listUnlocksForGame', gameId),
      addUnlock: (data) => ipcRenderer.invoke('achievements:addUnlock', data),
      removeUnlock: (achievementId) => ipcRenderer.invoke('achievements:removeUnlock', achievementId),
      toggleManual: (achievementId) => ipcRenderer.invoke('achievements:toggleManual', achievementId),
      autoImport: (gameId) => ipcRenderer.invoke('achievements:autoImport', gameId),
    },
    gameList: {
      list: (filters) => ipcRenderer.invoke('gameList:list', filters),
      refreshUpcomingInfo: () => ipcRenderer.invoke('gameList:refreshUpcomingInfo'),
      get: (id) => ipcRenderer.invoke('gameList:get', id),
      add: (data) => ipcRenderer.invoke('gameList:add', data),
      update: (id, data) => ipcRenderer.invoke('gameList:update', id, data),
      delete: (id) => ipcRenderer.invoke('gameList:delete', id),
    },
    customLists: {
      list: () => ipcRenderer.invoke('customLists:list'),
      create: (data) => ipcRenderer.invoke('customLists:create', data),
      update: (id, data) => ipcRenderer.invoke('customLists:update', id, data),
      delete: (id) => ipcRenderer.invoke('customLists:delete', id),
      addGame: (listId, itemId) => ipcRenderer.invoke('customLists:addGame', listId, itemId),
      removeGame: (listId, itemId) => ipcRenderer.invoke('customLists:removeGame', listId, itemId),
      listsForItem: (itemId) => ipcRenderer.invoke('customLists:listsForItem', itemId),
    },
    genres: {
      distinct: () => ipcRenderer.invoke('genres:distinct'),
    },
    settings: {
      get: (key) => ipcRenderer.invoke('settings:get', key),
      set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
      getAll: () => ipcRenderer.invoke('settings:getAll'),
    },
    steam: {
      testKey: (key) => ipcRenderer.invoke('steam:testKey', key),
      search: (query) => ipcRenderer.invoke('steam:search', query),
      getStoreArt: (appId) => ipcRenderer.invoke('steam:getStoreArt', appId),
      resolveId: (input, apiKey) => ipcRenderer.invoke('steam:resolveId', input, apiKey),
      refresh: (gameId) => ipcRenderer.invoke('steam:refresh', gameId),
      refreshAllBanners: () => ipcRenderer.invoke('steam:refreshAllBanners'),
      bannerRefreshStatus: () => ipcRenderer.invoke('banners:refreshStatus'),
      detectUser: () => ipcRenderer.invoke('steam:detectUser'),
      signIn: () => ipcRenderer.invoke('steam:signIn'),
      storeDetails: (appId) => ipcRenderer.invoke('steam:storeDetails', appId),
      lastSyncError: (gameId) => ipcRenderer.invoke('steam:lastSyncError', gameId),
      getProfile: (overrides) => ipcRenderer.invoke('steam:getProfile', overrides),
      diagnose: (gameId) => ipcRenderer.invoke('steam:diagnose', gameId),
    },
    scanner: {
      getDefaultPaths: () => ipcRenderer.invoke('scanner:getDefaultPaths'),
      scan: (paths) => ipcRenderer.invoke('scanner:scan', paths),
      addGames: (games) => ipcRenderer.invoke('scanner:addGames', games),
    },
    crack: {
      scanGame: (gameId) => ipcRenderer.invoke('crack:scanGame', gameId),
      scanAll: () => ipcRenderer.invoke('crack:scanAll'),
      diagnose: (gameId) => ipcRenderer.invoke('crack:diagnose', gameId),
      enableAchievements: (gameId) => ipcRenderer.invoke('crack:enableAchievements', gameId),
    },
    shell: {
      openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
      openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    },
    saves: {
      find: (gameId) => ipcRenderer.invoke('saves:find', gameId),
      backup: (gameId, sourcePath) => ipcRenderer.invoke('saves:backup', gameId, sourcePath),
      listBackups: (gameId) => ipcRenderer.invoke('saves:listBackups', gameId),
      backupsDir: () => ipcRenderer.invoke('saves:backupsDir'),
      overview: () => ipcRenderer.invoke('saves:overview'),
      backupAll: () => ipcRenderer.invoke('saves:backupAll'),
      restore: (gameId, backupId, target) => ipcRenderer.invoke('saves:restore', gameId, backupId, target),
      deleteBackup: (gameId, backupId) => ipcRenderer.invoke('saves:deleteBackup', gameId, backupId),
      getAutoBackup: () => ipcRenderer.invoke('saves:getAutoBackup'),
      setAutoBackup: (enabled) => ipcRenderer.invoke('saves:setAutoBackup', enabled),
    },
    stats: {
      get: (period) => ipcRenderer.invoke('stats:get', period),
      dayActivity: (day) => ipcRenderer.invoke('stats:dayActivity', day),
      hourActivity: (hour) => ipcRenderer.invoke('stats:hourActivity', hour),
      xp: () => ipcRenderer.invoke('stats:xp'),
      xpHistory: (limit) => ipcRenderer.invoke('stats:xpHistory', limit),
    },
    watcher: {
      pause:  () => ipcRenderer.invoke('watcher:pause'),
      resume: () => ipcRenderer.invoke('watcher:resume'),
    },
    processes: {
      listRunning: () => ipcRenderer.invoke('processes:listRunning'),
    },
    dialog: {
      pickExe: (defaultPath) => ipcRenderer.invoke('dialog:pickExe', defaultPath),
      pickImageData: () => ipcRenderer.invoke('image:pickData'),
      saveCroppedImage: (payload) => ipcRenderer.invoke('image:saveCropped', payload),
      pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    },
    backup: {
      import: () => ipcRenderer.invoke('backup:import'),
      syncSetup: () => ipcRenderer.invoke('sync:setup'),
      syncStatus: () => ipcRenderer.invoke('sync:status'),
      syncRestore: () => ipcRenderer.invoke('sync:restore'),
    },
    diagnostics: {
      trackingSelfTest: () => ipcRenderer.invoke('tracking:selfTest'),
    },
    overlay: {
      hide: () => ipcRenderer.invoke('overlay:hide'),
      test: () => ipcRenderer.invoke('overlay:test'),
      ready: () => ipcRenderer.invoke('overlay:ready'),
      setInteractive: (v) => ipcRenderer.invoke('overlay:setInteractive', v),
      applyAccent: (hex) => ipcRenderer.invoke('overlay:applyAccent', hex),
    },
    app: {
      getStartup: () => ipcRenderer.invoke('app:getStartup'),
      setStartup: (enable) => ipcRenderer.invoke('app:setStartup', enable),
      getStartMinimized: () => ipcRenderer.invoke('app:getStartMinimized'),
      setStartMinimized: (enable) => ipcRenderer.invoke('app:setStartMinimized', enable),
      getVersion: () => ipcRenderer.invoke('app:getVersion'),
      checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    },
  },

  events: {
    onSessionStarted: (cb) => {
      ipcRenderer.on('session:started', (_, data) => cb(data))
    },
    onSessionEnded: (cb) => {
      ipcRenderer.on('session:ended', (_, data) => cb(data))
    },
    onSessionIdle: (cb) => {
      ipcRenderer.on('session:idle', (_, data) => cb(data))
    },
    onSessionDetected: (cb) => {
      ipcRenderer.on('session:detected', (_, data) => cb(data))
    },
    onSessionUndetected: (cb) => {
      ipcRenderer.on('session:undetected', (_, data) => cb(data))
    },
    onAchievementUnlocked: (cb) => {
      ipcRenderer.on('achievement:unlocked', (_, data) => cb(data))
    },
    onGameUpdated: (cb) => {
      ipcRenderer.on('game:updated', (_, gameId) => cb(gameId))
    },
    onBannerRefreshProgress: (cb) => {
      ipcRenderer.on('banners:refreshProgress', (_, state) => cb(state))
    },
    onAchievementOverlay: (cb) => {
      ipcRenderer.on('achievement:overlay', (_, data) => cb(data))
    },
    onSessionOverlay: (cb) => {
      ipcRenderer.on('session:overlay', (_, data) => cb(data))
    },
    onStatusOverlay: (cb) => {
      ipcRenderer.on('status:overlay', (_, data) => cb(data))
    },
    onXpOverlay: (cb) => {
      ipcRenderer.on('xp:overlay', (_, data) => cb(data))
    },
    onSessionEndOverlay: (cb) => {
      ipcRenderer.on('sessionEnd:overlay', (_, data) => cb(data))
    },
    onXpLevelUp: (cb) => {
      ipcRenderer.on('xp:levelup', (_, data) => cb(data))
    },
    onAccentChanged: (cb) => {
      ipcRenderer.on('accent:changed', (_, hex) => cb(hex))
    },
    onUnknownProcess: (cb) => {
      ipcRenderer.on('unknown-process', (_, data) => cb(data))
    },
    removeAll: (channel) => {
      ipcRenderer.removeAllListeners(channel)
    },
  },
})