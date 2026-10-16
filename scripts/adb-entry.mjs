// Se arma con: npx esbuild scripts/adb-entry.mjs --bundle --minify --format=iife --target=es2020 --outfile=vendor/adb-webusb.min.js
// (paquetes: @yume-chan/adb@2.6.4, @yume-chan/adb-daemon-webusb@2.3.2, @yume-chan/adb-credential-web@2.1.0)
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

async function readAdb(log = () => {}) {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error('Este navegador no tiene WebUSB. Usa Chrome o Edge en una PC.');
  log('Elige el teléfono en la ventana de Chrome…');
  const device = await manager.requestDevice();
  if (!device) throw new Error('No elegiste ningún equipo.');
  let connection;
  try {
    connection = await device.connect();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/busy|claim|in use/i.test(msg)) throw new Error('El puerto ADB está ocupado por otro programa (adb.exe, UnlockTool, box). Ciérralo, desconecta y vuelve a conectar el cable.');
    if (/access denied|SecurityError|NotAllowed/i.test(msg)) throw new Error('Windows no deja usar este equipo. Instala el «Google USB Driver» (WinUSB) para este teléfono.');
    throw new Error('No se pudo abrir el equipo: ' + msg);
  }
  log('Acepta «¿Permitir depuración USB?» en el teléfono…');
  const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: new AdbWebCredentialStore('212 VIP') });
  const adb = new Adb(transport);
  try {
    const text = await adb.subprocess.noneProtocol.spawnWaitText('getprop');
    const p = {};
    for (const m of text.matchAll(/^\[([^\]]+)\]:\s*\[([\s\S]*?)\]\s*$/gm)) p[m[1]] = m[2];
    return { props: p, banner: transport.banner || {} };
  } finally {
    await adb.close().catch(() => {});
  }
}
window.SimtecAdb = { readAdb };
