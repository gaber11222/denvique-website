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
 if(!authenticated){status('Sign in with your DENVique employee credentials to connect this device.');return}
 el.name.textContent=current.user&&current.user.full_name||'Employee';
 el.email.textContent=current.user&&current.user.email||'';
 el.platform.textContent=current.platform||'—';
 el.connection.textContent=current.agent_connected?'Connected':'Connecting…';
 el.browser.textContent=current.platform==='Windows'?(current.browser_extension_connected?'Connected':'Optional — not installed'):(current.platform==='macOS'?'Built-in domain integration':'Optional browser extension');
 const schedule=current.shift;
 const start=formatTime(schedule&&schedule.starts_at),end=formatTime(schedule&&schedule.ends_at);
 const stateName=current.state||'unknown';
 const outsideShift=stateName==='outside_shift';
 if(el.meta)el.meta.classList.toggle('hidden',outsideShift);
 if(el.extensionCard)el.extensionCard.classList.toggle('hidden',outsideShift);
 el.dot.className='dot'+(current.monitoring_active?' active':(stateName==='outside_shift'?'':' warn'));
 if(stateName==='outside_shift'){
  el.stateTitle.textContent='Outside scheduled shift';
  el.stateDetail.textContent='No work-monitoring session is active.';
 }else if(stateName==='pre_shift'){
  el.stateTitle.textContent=current.monitoring_active?'Monitoring active before shift':'Your shift is approaching';
  el.stateDetail.textContent='Scheduled start: '+start+(end?' · End: '+end:'');
 }else if(stateName==='on_break'){
  el.stateTitle.textContent='Recorded break';
  el.stateDetail.textContent='Work monitoring is paused for this break.';
 }else if(stateName==='in_shift'){
  el.stateTitle.textContent=current.monitoring_active?'Monitoring active':'Shift in progress';
  el.stateDetail.textContent='Scheduled shift: '+start+' – '+end;
 }else{
  el.stateTitle.textContent='Checking your schedule';
  el.stateDetail.textContent='Refresh to load the latest shift details.';
 }
 show('activation',authenticated&&['pre_shift','in_shift'].includes(stateName)&&!current.monitoring_active);
 show('monitoring',authenticated&&current.monitoring_active&&!current.break_active);
 show('break-state',authenticated&&current.break_active);
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
el.start.addEventListener('click',()=>invoke(()=>api.start(),'Work monitoring is active.'));
el.stop.addEventListener('click',()=>invoke(()=>api.stop(),'Work monitoring has stopped.'));
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
