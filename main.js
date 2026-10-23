const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const pageName = 'employee_attendance_location_verification_system (2).html';

app.whenReady().then(() => {
  const appSession = session.defaultSession;

  appSession.setPermissionCheckHandler((_webContents, permission) => permission === 'geolocation');
  appSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'geolocation');
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, pageName));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});