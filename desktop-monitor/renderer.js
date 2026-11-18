(function(){
'use strict';
const api=window.denviqueMonitor;
const $=id=>document.getElementById(id);
const el={
 signedOut:$('signed-out'),signedIn:$('signed-in'),signIn:$('sign-in'),signOut:$('sign-out'),
 stateTitle:$('state-title'),stateDetail:$('state-detail'),dot:$('state-dot'),
 name:$('employee-name'),email:$('employee-email'),platform:$('device-platform'),connection:$('connection-state'),meta:$('employee-meta'),extensionCard:$('browser-extension-card'),browser:$('browser-extension-state'),
 activation:$('activation'),monitoring:$('monitoring'),breakState:$('break-state'),
 consent:$('work-consent'),start:$('start-monitoring'),stop:$('stop-monitoring'),refresh:$('refresh'),
 openCheckin:$('open-checkin'),extension:$('extension-folder'),extensionHelp:$('extension-help'),status:$('status')
};
let current=null;
function status(message,type){
 el.status.textContent=message||'';
 el.status.className='status'+(type?' '+type:'');
}
function show(id,visible){$(id).classList.toggle('hidden',!visible)}
function formatTime(value){
 if(!value)return '';
 const date=new Date(value);
 return Number.isNaN(date.getTime())?'':date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function render(state){
 current=state||{};
 const authenticated=!!current.authenticated;
 el.signedOut.classList.toggle('hidden',authenticated);
 el.signedIn.classList.toggle('hidden',!authenticated);
 if(!authenticated){status('Sign in with the same DENVique staff account used for your workspace.');return}
 el.name.textContent=current.user&&current.user.full_name||'Employee';
 el.email.textContent=current.user&&current.user.email||'';
 el.platform.textContent=current.platform||'—';
 el.connection.textContent=current.agent_connected?'Connected':'Connecting…';
 el.browser.textContent=current.platform==='Windows'?(current.browser_extension_connected?'Connected':'Optional — not installed'):(current.platform==='macOS'?'Built-in domain integration':'Optional browser extension');
 const schedule=current.shift;
 const start=formatTime(schedule&&schedule.starts_at),end=formatTime(schedule&&schedule.ends_at);
 const stateName=current.state||'unknown';
 const portalActive=current.portal_access_active===true;
 const workCaptureRequired=current.work_monitoring_required===true;
 const workActive=current.monitoring_active===true;
 if(el.meta)el.meta.classList.remove('hidden');
 if(el.extensionCard)el.extensionCard.classList.toggle('hidden',stateName==='outside_shift'||!workCaptureRequired);
 el.dot.className='dot'+(portalActive&&(!workCaptureRequired||workActive)?' active':' warn');
 if(stateName==='outside_shift'){
  el.stateTitle.textContent='Outside scheduled shift';
  el.stateDetail.textContent=portalActive
   ?'Desktop Monitor is connected. Screen snapshots and app / website activity are paused outside your shift.'
   :'Activate Desktop Monitor to access DENVique, even outside scheduled shifts.';
 }else if(stateName==='pre_shift'){
  el.stateTitle.textContent=workActive?'Work monitoring active before shift':(portalActive?'Desktop Monitor connected':'Your shift is approaching');
  el.stateDetail.textContent='Scheduled start: '+start+(end?' · End: '+end:'');
 }else if(stateName==='on_break'){
  el.stateTitle.textContent=portalActive?'Desktop Monitor connected · recorded break':'Recorded break · app connection required';
  el.stateDetail.textContent='Screen and activity capture are paused during this recorded break.';
 }else if(stateName==='in_shift'){
  el.stateTitle.textContent=workActive?'Work monitoring active':(portalActive?'Desktop Monitor connected · work capture required':'Shift in progress · app connection required');
  el.stateDetail.textContent='Scheduled shift: '+start+' – '+end;
 }else{
  el.stateTitle.textContent='Checking your schedule';
  el.stateDetail.textContent='Refresh to load the latest shift details.';
 }
 show('activation',authenticated&&(!portalActive||(workCaptureRequired&&!workActive)));
 show('monitoring',authenticated&&portalActive&&(!workCaptureRequired||workActive)&&!current.break_active);
 show('break-state',authenticated&&portalActive&&current.break_active);
 el.start.disabled=!el.consent.checked;
 if(state.notice)status(state.notice);
}
async function invoke(fn,success){
 try{
  const result=await fn();
  if(result&&typeof result==='object')render(result);
  if(success)status(success,'success');
 }catch(error){status(error&&error.message||'Something went wrong.','error')}
}
el.signIn.addEventListener('click',()=>invoke(()=>api.signIn(),'Opening secure DENVique sign-in…'));
el.signOut.addEventListener('click',()=>invoke(()=>api.signOut(),'Signed out.'));
el.start.addEventListener('click',()=>invoke(()=>api.start(),'DENVique Desktop Monitor is active.'));
el.stop.addEventListener('click',()=>invoke(()=>api.stop(),'Desktop Monitor disconnected. DENVique workspace access is locked.'));
el.refresh.addEventListener('click',()=>invoke(()=>api.refresh(),'Status refreshed.'));
el.openCheckin.addEventListener('click',()=>api.openCheckin());
el.extension.addEventListener('click',()=>invoke(()=>api.openExtensionFolder(),'Extension folder opened.'));
el.extensionHelp.addEventListener('click',()=>status('In Chrome open chrome://extensions; in Edge open edge://extensions. Enable Developer mode, choose Load unpacked, then select the extension folder.',''));
el.consent.addEventListener('change',()=>{el.start.disabled=!el.consent.checked});
api.onState(state=>render(state));
api.onNotice(notice=>{if(notice)status(notice,'')});
api.getState().then(render).catch(error=>status(error.message,'error'));
setInterval(()=>api.refresh().then(render).catch(()=>{}),20000);
})();
