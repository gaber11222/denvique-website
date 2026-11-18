const {
  app, BrowserWindow, ipcMain, shell, dialog,
  session
}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {autoUpdater}=require(require.resolve('electron-updater',{paths:[app.getAppPath()]}));

const execFileAsync=promisify(execFile);
const APP_ORIGIN='https://csconweb-remote.hatchable.site';
const PARTITION='persist:denvique-desktop-monitor';
const API_BASE=APP_ORIGIN;
const DEVICE_FILE=()=>path.join(app.getPath('userData'),'device.json');
const EXTENSION_PORT=43189;
const APP_INSTANCE_ID=crypto.randomUUID();
const APP_INSTANCE_STARTED_AT=Date.now();
const HEARTBEAT_INTERVAL_MS=300*1000;
const APP_POLL_INTERVAL_MS=15*1000;

let mainWindow=null;
let loginWindow=null;
let loginPoll=null;
let heartbeatTimer=null;
let appPollTimer=null;
let monitoringSessionId=null;
let monitoringActive=false;
let portalAccessActive=false;
let portalAccessSessionId=null;
let portalAccessDesired=false;
let breakActive=false;
let currentState=null;
let currentUser=null;
let currentAppName='';
let currentSiteDomain='';
let browserPermissionNoticeShown=false;
let browserExtensionSeenAt=0;
let localServer=null;
const localToken=crypto.randomBytes(32).toString('hex');
let deviceId='';

function getPartition(){return session.fromPartition(PARTITION)}
function cookieHeader(cookie){
  if(!cookie)return '';
  let value=String(cookie.value||'');
  try{value=decodeURIComponent(value)}catch(_){}
  return 'denvique_auth0_session='+encodeURIComponent(value);
}
async function getCookieHeader(){
  const cookies=await getPartition().cookies.get({url:APP_ORIGIN,name:'denvique_auth0_session'});
  return cookieHeader(cookies[0]);
}
async function apiRequest(route,options){
  const cookie=await getCookieHeader();
  if(!cookie)throw new Error('Sign in with your DENVique employee account first.');
  const headers={Accept:'application/json',Origin:APP_ORIGIN,Cookie:cookie,'Cache-Control':'no-store'};
  const init={method:options&&options.method||'GET',headers};
  if(options&&options.form)init.body=options.form;
  else if(options&&options.body){headers['Content-Type']='application/json';init.body=JSON.stringify(options.body)}
  const response=await fetch(API_BASE+route,init);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||data.message||('DENVique returned HTTP '+response.status));
  return data;
}
async function verifyLogin(){
  const cookie=await getCookieHeader();
  if(!cookie)return null;
  const response=await fetch(API_BASE+'/api/auth0/session',{
    method:'GET',headers:{Accept:'application/json',Origin:APP_ORIGIN,Cookie:cookie,'Cache-Control':'no-store'}
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.authenticated||!data.user)return null;
  if(!['employee','team_leader','quality_analyst','trainer','operations_manager','account_manager'].includes(data.user.role)||data.user.status!=='active')throw new Error('Only active DENVique staff accounts can use this application.');
  currentUser=data.user;
  return currentUser;
}
function emitState(notice){
  if(!mainWindow||mainWindow.isDestroyed())return;
  mainWindow.webContents.send('monitor:state',buildUiState());
  if(notice)mainWindow.webContents.send('monitor:notice',notice);
}
function buildUiState(){
  const state=currentState||{};
  return {
    authenticated:!!currentUser,
    user:currentUser?{full_name:currentUser.full_name||currentUser.name||'DENVique staff',email:currentUser.email||'',role:currentUser.role||''}:null,
    platform:process.platform==='darwin'?'macOS':process.platform==='win32'?'Windows':process.platform,
    runtime_version:global.__DENViqueRuntimeMeta?.version||app.getVersion(),
    state:state.state||'unknown',
    shift:state.shift||null,
    agent_connected:state.agent_connected===true,
    monitoring_active:monitoringActive,
    portal_access_active:portalAccessActive,
    work_monitoring_required:!!currentUser&&currentUser.role==='employee'&&!!currentState&&['pre_shift','in_shift'].includes(currentState.state)&&!breakActive,
    break_active:breakActive,
    session_id:monitoringSessionId,
    device_id:deviceId,
    browser_extension_connected:browserExtensionSeenAt>0&&Date.now()-browserExtensionSeenAt<=90000,
    browser_extension_required:false,
    status_detail:state.state==='outside_shift'?'No current shift is scheduled.':state.state==='pre_shift'?'Your scheduled shift is approaching.':state.state==='on_break'?'Monitoring is paused for your recorded break.':state.state==='in_shift'?'Your scheduled shift is in progress.':'',
  };
}
function readOrCreateDeviceId(){
  try{
    const folder=path.dirname(DEVICE_FILE());
    fs.mkdirSync(folder,{recursive:true});
    const existing=JSON.parse(fs.readFileSync(DEVICE_FILE(),'utf8'));
    if(existing&&/^[a-zA-Z0-9_-]{12,100}$/.test(String(existing.device_id||'')))return existing.device_id;
  }catch(_){}
  const id=crypto.randomUUID();
  try{fs.writeFileSync(DEVICE_FILE(),JSON.stringify({device_id:id},null,2),{mode:0o600})}catch(_){}
  return id;
}
function platformName(){return process.platform==='darwin'?'macOS':process.platform==='win32'?'Windows':process.platform}
function appVersion(){return app.getVersion()}
async function sendAccessActivity(eventType,itemName,source,eventAction='opened'){
  if(!portalAccessActive||!portalAccessSessionId||!currentUser)return false;
  if(!['app','site'].includes(eventType)||!['opened','closed'].includes(eventAction))return false;
  try{
    await apiRequest('/api/desktop-monitor',{method:'POST',body:{
      action:'access_activity',event_type:eventType,event_action:eventAction,
      item_name:String(itemName||'').slice(0,180),
      domain:eventType==='site'?String(itemName||'').slice(0,180).toLowerCase():null,
      source:source||'desktop-agent',device_id:deviceId,
      process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT
    }});
    return true;
  }catch(error){
    if(!/not actively connected|session is no longer active/i.test(error.message)){
      emitState('Activity update could not be saved: '+error.message);
    }
    return false;
  }
}
async function endAccessActivity(eventType,source){
  return sendAccessActivity(eventType,'',source||'desktop-agent','closed');
}
async function browserDomainForMac(appName){
  if(process.platform!=='darwin')return '';
  const scripts={
    'Safari':'tell application "Safari" to get URL of current tab of front window',
    'Google Chrome':'tell application "Google Chrome" to get URL of active tab of front window',
    'Google Chrome Helper':'tell application "Google Chrome" to get URL of active tab of front window',
    'Microsoft Edge':'tell application "Microsoft Edge" to get URL of active tab of front window'
  };
  const script=scripts[appName];
  if(!script)return '';
  try{
    const result=await execFileAsync('/usr/bin/osascript',['-e',script],{timeout:5000,maxBuffer:1024*1024});
    const url=new URL(String(result.stdout||'').trim());
    if(!['http:','https:'].includes(url.protocol))return '';
    return url.hostname.toLowerCase().slice(0,180);
  }catch(error){
    const message=String(error&&error.message||error);
    if(!browserPermissionNoticeShown&&/not authorized|(-1743)|not permitted/i.test(message)){
      browserPermissionNoticeShown=true;
      emitState('macOS may ask you to allow DENVique Desktop Monitor to read the active browser tab so it can record the website domain.');
    }
    return '';
  }
}
async function foregroundApplication(){
  try{
    let name='';
    if(process.platform==='darwin'){
      const result=await execFileAsync('/usr/bin/osascript',['-e','tell application "System Events" to get name of first application process whose frontmost is true'],{timeout:5000,maxBuffer:1024*1024});
      name=String(result.stdout||'').trim();
    }else if(process.platform==='win32'){
      const ps="$src='using System; using System.Runtime.InteropServices; public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid); }'; Add-Type $src; $hwnd=[FG]::GetForegroundWindow(); [uint32]$processId=0; [void][FG]::GetWindowThreadProcessId($hwnd,[ref]$processId); if($processId -gt 0){(Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName}";
      const result=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{timeout:7000,maxBuffer:1024*1024,windowsHide:true});
      name=String(result.stdout||'').trim();
    }
    if(!name||name==='osascript'||name==='powershell'||name==='pwsh')return;
    return name.replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,120);
  }catch(error){
    const message=String(error&&error.message||error);
    if(process.platform==='darwin'&&/not authorized|(-1743)|assistive/i.test(message)){
      emitState('macOS requires Accessibility / Automation permission to read the foreground application name. You can grant it in System Settings → Privacy & Security.');
    }
    return '';
  }
}
async function pollForegroundApp(){
  if(!portalAccessActive||!portalAccessSessionId){
    currentAppName='';
    currentSiteDomain='';
    return;
  }
  const name=await foregroundApplication();
  if(name&&name!==currentAppName){
    if(await sendAccessActivity('app',name,'desktop-agent')){
      currentAppName=name;
      emitState('Foreground application activity updated.');
    }
  }
  if(process.platform==='darwin'){
    const domain=await browserDomainForMac(name);
    if(domain&&domain!==currentSiteDomain){
      if(await sendAccessActivity('site',domain,'macos-browser-automation'))currentSiteDomain=domain;
    }else if(!domain&&currentSiteDomain){
      if(await endAccessActivity('site','macos-browser-automation'))currentSiteDomain='';
    }
  }
}
function startActivityTimer(){
  if(appPollTimer)clearInterval(appPollTimer);
  appPollTimer=setInterval(pollForegroundApp,APP_POLL_INTERVAL_MS);
  pollForegroundApp();
}
function stopActivityTimer(){
  if(appPollTimer){clearInterval(appPollTimer);appPollTimer=null}
  const hadApp=!!currentAppName,hadSite=!!currentSiteDomain;
  currentAppName='';
  currentSiteDomain='';
  const closing=[];
  if(hadApp)closing.push(endAccessActivity('app','desktop-agent'));
  if(hadSite)closing.push(endAccessActivity('site',process.platform==='darwin'?'macos-browser-automation':'browser-extension'));
  return Promise.all(closing);
}
async function refreshState(){
  if(!currentUser)return buildUiState();
  let heartbeat=await apiRequest('/api/desktop-monitor',{method:'POST',body:{
    action:'heartbeat',device_id:deviceId,platform:platformName(),app_version:appVersion(),
    process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT,session_id:monitoringSessionId||0
  }});
  if(portalAccessDesired&&heartbeat.portal_access_active!==true){
    const reconnect=await apiRequest('/api/desktop-monitor',{method:'POST',body:{
      action:'portal_start',accepted:true,device_id:deviceId,platform:platformName(),app_version:appVersion(),
      process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT
    }});
    heartbeat={...heartbeat,...reconnect};
  }
  currentState=heartbeat;
  const returnedSession=heartbeat.session&&Number(heartbeat.session.id);
  if(returnedSession)monitoringSessionId=returnedSession;
  else if(heartbeat.state==='outside_shift')monitoringSessionId=null;
  const previousPortalSessionId=portalAccessSessionId;
  portalAccessActive=heartbeat.portal_access_active===true&&
    heartbeat.access_session?.process_id===APP_INSTANCE_ID&&
    Number(heartbeat.access_session?.process_started_at||0)===APP_INSTANCE_STARTED_AT;
  portalAccessSessionId=portalAccessActive?Number(heartbeat.access_session?.id||0)||null:null;
  const portalSessionChanged=!!portalAccessSessionId&&portalAccessSessionId!==previousPortalSessionId;
  breakActive=heartbeat.state==='on_break'||heartbeat.break_active===true;
  monitoringActive=currentUser.role==='employee'&&heartbeat.monitoring_active===true&&!breakActive;

  // The activity radar follows explicit Desktop Monitor activation, not the shift.
  // It therefore remains active outside shifts and during recorded breaks.
  if(!portalAccessActive){
    void stopActivityTimer();
  }else if(portalSessionChanged){
    if(appPollTimer)clearInterval(appPollTimer);
    appPollTimer=null;
    currentAppName='';
    currentSiteDomain='';
    startActivityTimer();
  }else if(!appPollTimer){
    startActivityTimer();
  }
  emitState();
  return buildUiState();
}
async function heartbeatLoop(){
  if(!currentUser)return;
  try{await refreshState()}catch(error){monitoringActive=false;portalAccessActive=false;void stopActivityTimer();emitState('Connection lost: '+error.message)}
}
function startHeartbeatLoop(){
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  heartbeatLoop();
  heartbeatTimer=setInterval(heartbeatLoop,HEARTBEAT_INTERVAL_MS);
}
async function startMonitoring(){
  if(!currentUser)throw new Error('Sign in first.');
  if(!currentState)await refreshState();

  // Explicit activation records foreground app names and active website domains.
  // No screen capture, screen recording permission, or image upload is used.
  const access=await apiRequest('/api/desktop-monitor',{method:'POST',body:{
    action:'portal_start',accepted:true,device_id:deviceId,platform:platformName(),
    app_version:appVersion(),process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT
  }});
  portalAccessDesired=true;
  currentState=access;
  portalAccessActive=access.portal_access_active===true;
  portalAccessSessionId=Number(access.access_session?.id||access.access_session_id||0)||null;
  if(!portalAccessActive)throw new Error('The server did not confirm the active Desktop Monitor connection.');
  breakActive=access.state==='on_break'||access.break_active===true;
  startActivityTimer();

  const workSessionRequired=currentUser.role==='employee'&&
    ['pre_shift','in_shift'].includes(access.state)&&access.break_active!==true;

  if(!workSessionRequired){
    monitoringActive=false;
    monitoringSessionId=null;
    emitState(access.state==='outside_shift'
      ?'Desktop Monitor is active. App and website activity radar is running outside scheduled shifts.'
      :'Desktop Monitor is active. App and website activity radar is running; shift-session monitoring is not due yet.');
    return buildUiState();
  }

  if(monitoringActive&&monitoringSessionId){
    emitState('Desktop Monitor app and website activity radar is active. Shift monitoring is also active.');
    return buildUiState();
  }

  const result=await apiRequest('/api/desktop-monitor',{method:'POST',body:{
    action:'start',accepted:true,device_id:deviceId,platform:platformName(),app_version:appVersion(),
    process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT
  }});
  currentState=result;
  monitoringSessionId=Number(result.session&&result.session.id)||null;
  if(!monitoringSessionId)throw new Error('DENVique did not return a monitoring session identifier.');
  portalAccessActive=result.portal_access_active===true||portalAccessActive;
  breakActive=false;
  monitoringActive=true;
  if(!appPollTimer)startActivityTimer();
  emitState('Desktop Monitor app and website activity radar is active, including outside the shift.');
  return buildUiState();
}
async function stopMonitoring(reason='employee_stopped'){
  portalAccessDesired=false;
  if(currentUser&&monitoringSessionId){
    try{await apiRequest('/api/desktop-monitor',{method:'POST',body:{action:'stop',session_id:monitoringSessionId,device_id:deviceId,process_id:APP_INSTANCE_ID,reason:reason||'employee_stopped'}})}catch(error){emitState('Shift monitoring could not be stopped cleanly: '+error.message)}
  }
  if(currentUser&&portalAccessActive){
    try{await apiRequest('/api/desktop-monitor',{method:'POST',body:{action:'portal_stop',device_id:deviceId,process_id:APP_INSTANCE_ID,reason:reason||'employee_stopped'}})}catch(error){emitState('Desktop Monitor connection could not be closed cleanly: '+error.message)}
  }
  monitoringActive=false;
  portalAccessActive=false;
  portalAccessSessionId=null;
  breakActive=false;
  monitoringSessionId=null;
  await stopActivityTimer();
  emitState('Desktop Monitor connection and app / website activity radar stopped.');
  return buildUiState();
}
function stopLoginPoll(){
  if(loginPoll){clearInterval(loginPoll);loginPoll=null}
}
async function signIn(){
  const existing=await verifyLogin();
  if(existing){startHeartbeatLoop();emitState('Already signed in.');return buildUiState()}
  if(loginWindow&&!loginWindow.isDestroyed()){loginWindow.focus();return {ok:true}}
  loginWindow=new BrowserWindow({
    width:520,height:760,minWidth:430,minHeight:620,show:true,
    title:'Sign in to DENVique',
    webPreferences:{partition:PARTITION,contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  loginWindow.on('closed',()=>{loginWindow=null;stopLoginPoll()});
  await loginWindow.loadURL(APP_ORIGIN+'/login.html');
  stopLoginPoll();
  loginPoll=setInterval(async()=>{
    try{
      const user=await verifyLogin();
      if(user){
        stopLoginPoll();
        if(loginWindow&&!loginWindow.isDestroyed())loginWindow.close();
        startHeartbeatLoop();
        emitState('DENVique staff account connected.');
      }
    }catch(error){emitState(error.message)}
  },1200);
  return {ok:true};
}
async function signOut(){
  try{await stopMonitoring('signed_out')}catch(_){}
  await stopActivityTimer();
  if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}
  const cookie=await getCookieHeader();
  if(cookie){
    try{await fetch(API_BASE+'/api/auth0/session',{method:'DELETE',headers:{Origin:APP_ORIGIN,Cookie:cookie,Accept:'application/json'}})}catch(_){}
  }
  try{await getPartition().cookies.remove(APP_ORIGIN,'denvique_auth0_session')}catch(_){}
  currentUser=null;currentState=null;monitoringActive=false;portalAccessActive=false;portalAccessSessionId=null;portalAccessDesired=false;breakActive=false;monitoringSessionId=null;
  emitState('Signed out.');
  return buildUiState();
}
async function openLocalServer(){
  if(localServer)return;
  localServer=http.createServer(async(req,res)=>{
    const origin=String(req.headers.origin||'');
    const extensionAllowed=/^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const siteAllowed=origin===APP_ORIGIN;
    const allowed=extensionAllowed||siteAllowed;
    if(allowed){
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, x-denvique-token');
      res.setHeader('Access-Control-Allow-Private-Network','true');
      res.setHeader('Access-Control-Max-Age','600');
    }
    if(req.method==='OPTIONS'){res.writeHead(allowed?204:403);return res.end()}
    if(siteAllowed&&req.method==='GET'&&req.url==='/portal-state'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(JSON.stringify({
        running:true,authenticated:!!currentUser,
        current_user_id:currentUser?String(currentUser.user_id||currentUser.id||''):'',
        portal_active:portalAccessActive===true,
        monitoring_active:monitoringActive===true,
        device_id:deviceId,process_id:APP_INSTANCE_ID,process_started_at:APP_INSTANCE_STARTED_AT
      }));
    }
    if(!extensionAllowed){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'extension_origin_required'}))}
    if(req.method==='GET'&&req.url==='/config'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({token:localToken}));
    }
    if(req.method==='GET'&&req.url==='/state'){
      browserExtensionSeenAt=Date.now();
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({active:portalAccessActive,session_id:portalAccessSessionId,foreground_app:currentAppName}));
    }
    if(req.method==='POST'&&req.url==='/event'){
      if(String(req.headers['x-denvique-token']||'')!==localToken){res.writeHead(403);return res.end()}
      let raw='';
      req.on('data',chunk=>{raw+=chunk;if(raw.length>8192)req.destroy()});
      req.on('end',async()=>{
        try{
          const body=JSON.parse(raw||'{}');
          if(!portalAccessActive||!portalAccessSessionId)throw new Error('monitoring_not_active');
          if(body.event_type==='site_end'){
            await endAccessActivity('site','browser-extension');
            currentSiteDomain='';
            res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,closed:true}));
            return;
          }
          if(body.event_type!=='site')throw new Error('site_event_required');
          const domain=String(body.domain||body.item_name||'').toLowerCase();
          if(!/^[a-z0-9.-]{1,180}$/.test(domain))throw new Error('valid_domain_required');
          const saved=await sendAccessActivity('site',domain,'browser-extension');
          res.writeHead(saved?200:409,{'Content-Type':'application/json'});
          res.end(JSON.stringify(saved?{ok:true}:{error:'activity_not_saved'}));
        }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}
      });
      return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{
    localServer.once('error',reject);
    localServer.listen(EXTENSION_PORT,'127.0.0.1',()=>{localServer.removeListener('error',reject);resolve()});
  });
}
let updaterCheckTimer=null;
let updaterInitialTimer=null;
let signedWindowsUpdateCheck=null;
function isNewerDesktopVersion(candidate,current){
  const a=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(candidate||''));
  const b=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(current||''));
  if(!a||!b)return false;
  for(let i=1;i<=3;i++){if(Number(a[i])>Number(b[i]))return true;if(Number(a[i])<Number(b[i]))return false;}
  return false;
}
function approveSignedUpdateManifest(version,windowsAsset){
  if(!/^\d+\.\d+\.\d+$/.test(String(version||'')) ||
     !windowsAsset || windowsAsset.file!=='DENVique-Monitor-Setup.exe' ||
     !/^[a-f0-9]{64}$/i.test(String(windowsAsset.sha256||'')))return false;
  global.__DENViqueSignedUpdateVersion=String(version);
  global.__DENViqueWindowsUpdateApproval={
    version:String(version),
    file:windowsAsset.file,
    sha256:String(windowsAsset.sha256).toLowerCase()
  };
  if(signedWindowsUpdateCheck)signedWindowsUpdateCheck();
  return true;
}
function setupAutoUpdater(){
  if(!app.isPackaged||process.platform!=='win32')return;
  autoUpdater.autoDownload=true;
  autoUpdater.autoInstallOnAppQuit=false;
  autoUpdater.allowPrerelease=false;
  autoUpdater.on('checking-for-update',()=>console.log('Checking for DENVique updates.'));
  autoUpdater.on('update-available',info=>{
    console.log('DENVique update available:',info.version);
    emitState('A DENVique update is downloading in the background. It will install when you close the app.');
  });
  autoUpdater.on('update-not-available',info=>console.log('DENVique is up to date:',info.version));
  autoUpdater.on('update-downloaded',async info=>{
    try{
      const approval=global.__DENViqueWindowsUpdateApproval;
      const helper=autoUpdater.downloadedUpdateHelper;
      const downloadedFile=helper&&helper.file;
      if(!approval||String(info.version)!==approval.version||!downloadedFile||
         path.basename(downloadedFile)!==approval.file){
        throw new Error('Downloaded installer does not match the signed release manifest.');
      }
      const digest=crypto.createHash('sha256');
      await new Promise((resolve,reject)=>{
        const stream=fs.createReadStream(downloadedFile);
        stream.on('error',reject);
        stream.on('data',chunk=>digest.update(chunk));
        stream.on('end',resolve);
      });
      if(digest.digest('hex')!==approval.sha256){
        try{fs.unlinkSync(downloadedFile)}catch(_){}
        if(helper&&typeof helper.clear==='function')await helper.clear();
        throw new Error('Downloaded Windows installer SHA-256 does not match the signed manifest.');
      }
      autoUpdater.autoInstallOnAppQuit=true;
      console.log('Signed DENVique Windows installer verified:',info.version);
      emitState('A verified DENVique update is ready. It will install automatically after you close the app.');
    }catch(error){
      autoUpdater.autoInstallOnAppQuit=false;
      console.error('DENVique Windows update rejected:',String(error&&error.message||error));
      emitState('A downloaded DENVique update failed verification and was not installed. The current version remains active.');
    }
  });
  autoUpdater.on('error',error=>console.error('DENVique automatic update error:',String(error&&error.message||error).slice(0,500)));
  const check=()=>{
    const signedVersion=String(global.__DENViqueSignedUpdateVersion||'');
    if(!isNewerDesktopVersion(signedVersion,app.getVersion())){
      console.log('Windows updater waiting for a newer Ed25519-verified DENVique release.');
      return Promise.resolve();
    }
    return autoUpdater.checkForUpdates().catch(error=>{
      console.error('DENVique update check failed:',String(error&&error.message||error).slice(0,500));
    });
  };
  signedWindowsUpdateCheck=check;
  updaterInitialTimer=setTimeout(check,20000);
  updaterCheckTimer=setInterval(check,5*60*1000);
  app.on('will-quit',()=>{
    if(updaterInitialTimer)clearTimeout(updaterInitialTimer);
    if(updaterCheckTimer)clearInterval(updaterCheckTimer);
  });
}

function makeMainWindow(){
  if(mainWindow&&!mainWindow.isDestroyed()){
    if(mainWindow.isMinimized())mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if(process.platform==='darwin'){try{app.focus({steal:true})}catch(_){}}
    return;
  }
  mainWindow=new BrowserWindow({
    width:820,height:790,minWidth:520,minHeight:650,
    title:'DENVique Desktop Monitor',
    show:false,
    center:true,
    backgroundColor:'#f3f4ed',
    autoHideMenuBar:true,
    webPreferences:{preload:path.join(app.getAppPath(),'preload.js'),partition:PARTITION,contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  let firstPageLoaded=false;
  let fallbackStarted=false;
  const revealWindow=()=>{
    if(!mainWindow||mainWindow.isDestroyed())return;
    if(mainWindow.isMinimized())mainWindow.restore();
    if(!mainWindow.isVisible())mainWindow.show();
    mainWindow.focus();
    if(process.platform==='darwin'){try{app.focus({steal:true})}catch(_){}}
  };
  const loadBundledFallback=async(reason)=>{
    if(!mainWindow||mainWindow.isDestroyed()||fallbackStarted)return;
    fallbackStarted=true;
    console.error('Remote DENVique interface unavailable; loading bundled fallback:',String(reason&&reason.message||reason||'startup timeout'));
    try{
      await mainWindow.loadFile(path.join(app.getAppPath(),'index.html'));
      firstPageLoaded=true;
      revealWindow();
    }catch(error){
      revealWindow();
      dialog.showErrorBox('DENVique Desktop Monitor could not open',String(error&&error.message||error));
    }
  };
  const startupFallback=setTimeout(()=>{
    if(!firstPageLoaded)loadBundledFallback(new Error('The DENVique workspace did not respond during startup.'));
  },8000);
  mainWindow.once('ready-to-show',()=>{if(firstPageLoaded||fallbackStarted)clearTimeout(startupFallback);revealWindow()});
  mainWindow.webContents.on('did-finish-load',()=>{
    firstPageLoaded=true;
    clearTimeout(startupFallback);
    if(typeof global.__DENViqueMarkUpdateStartupSuccess==='function'){
      global.__DENViqueMarkUpdateStartupSuccess();
    }
    setTimeout(revealWindow,150);
  });
  mainWindow.webContents.on('did-fail-load',(_event,errorCode,errorDescription,validatedURL,isMainFrame)=>{
    if(!isMainFrame)return;
    console.error('DENVique main view failed to load:',errorCode,errorDescription,validatedURL);
  });
  mainWindow.webContents.on('render-process-gone',(_event,details)=>{
    console.error('DENVique renderer stopped:',details);
    dialog.showErrorBox('DENVique Desktop Monitor stopped unexpectedly','The app window stopped responding. Close and reopen the application. If this repeats, contact DENVique support.');
  });
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{
    try{
      const target=new URL(url);
      if(target.origin!==APP_ORIGIN||target.pathname!=='/desktop-monitor-app')event.preventDefault();
    }catch(_){event.preventDefault()}
  });
  mainWindow.webContents.on('will-redirect',(event,url)=>{
    try{
      const target=new URL(url);
      if(target.origin!==APP_ORIGIN||target.pathname!=='/desktop-monitor-app')event.preventDefault();
    }catch(_){event.preventDefault()}
  });
  mainWindow.loadURL(APP_ORIGIN+'/desktop-monitor-app').catch(loadBundledFallback);
  mainWindow.on('close',event=>{
    if((!portalAccessActive&&!monitoringSessionId)||quitting)return;
    event.preventDefault();
    dialog.showMessageBox(mainWindow,{
      type:'warning',buttons:['Keep app open','Disconnect and close'],defaultId:0,cancelId:0,
      title:'DENVique Desktop Monitor is connected',
      message:'Disconnect Desktop Monitor before closing the application. DENVique workspaces will lock until you reconnect.'
    }).then(result=>{
      if(result.response===1)stopMonitoring('app_closed').then(()=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.destroy()}).catch(error=>emitState(error.message));
    });
  });
  mainWindow.on('closed',()=>{clearTimeout(startupFallback);mainWindow=null});
}
function extensionFolder(){
  return app.isPackaged?path.join(process.resourcesPath,'extension'):path.join(__dirname,'extension');
}
ipcMain.handle('monitor:get-state',async()=>{if(!currentUser){try{await verifyLogin()}catch(error){emitState(error.message)}}if(currentUser){try{await refreshState()}catch(error){emitState(error.message)}}return buildUiState()});
ipcMain.handle('monitor:sign-in',()=>signIn());
ipcMain.handle('monitor:sign-out',()=>signOut());
ipcMain.handle('monitor:start',()=>startMonitoring());
ipcMain.handle('monitor:stop',()=>stopMonitoring('employee_stopped'));
ipcMain.handle('monitor:refresh',()=>heartbeatLoop().then(()=>buildUiState()));
ipcMain.handle('monitor:open-checkin',()=>shell.openExternal(APP_ORIGIN+'/checkin-verification'));
ipcMain.handle('monitor:open-extension-folder',()=>shell.openPath(extensionFolder()));

app.whenReady().then(async()=>{
  app.setAsDefaultProtocolClient('denvique-monitor');
  deviceId=readOrCreateDeviceId();

  // Open the employee window before network checks or the local browser bridge.
  makeMainWindow();
  openLocalServer().catch(error=>console.error('Local extension bridge unavailable:',error.message));
  setupAutoUpdater();

  try{
    const user=await verifyLogin();
    if(user)startHeartbeatLoop();
  }catch(error){emitState(error.message)}

  app.on('activate',()=>{
    makeMainWindow();
    if(mainWindow&&!mainWindow.isDestroyed()){
      if(mainWindow.isMinimized())mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}).catch(error=>{
  console.error('DENVique startup failed:',error);
  dialog.showErrorBox('DENVique Desktop Monitor could not start',String(error&&error.stack||error));
});
app.on('open-url',(event,url)=>{event.preventDefault();if(url.startsWith('denvique-monitor:')){makeMainWindow();if(loginWindow&& !loginWindow.isDestroyed())loginWindow.focus()}});
let quitting=false;
app.on('before-quit',event=>{
  if(quitting)return;
  if(portalAccessActive||monitoringSessionId){
    event.preventDefault();
    stopMonitoring('app_closed').finally(()=>{quitting=true;app.quit()});
  }
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin'&&!monitoringActive)app.quit()});

function notifyRuntimeUpdateReady(version){
  emitState('A verified DENVique monitoring update ('+String(version||'new version')+') is ready. It will activate automatically the next time you reopen the app; no new installer is needed.');
}
function notifyMacAppUpdateReady(version){
  emitState('A complete DENVique app update ('+String(version||'new version')+') is ready. It will install automatically when you close the app, then reopen it.');
}

module.exports={notifyRuntimeUpdateReady,notifyMacAppUpdateReady,approveSignedUpdateManifest};