const BASE='http://127.0.0.1:43189';
let token=null;
let lastDomain='';
let lastSessionId='';
let lastTabId=null;

async function loadToken(){
  if(token)return token;
  try{
    const response=await fetch(BASE+'/config',{cache:'no-store'});
    if(!response.ok)return null;
    const data=await response.json();
    token=String(data.token||'');
    return token||null;
  }catch(_){return null}
}
async function appState(){
  try{
    const response=await fetch(BASE+'/state',{cache:'no-store'});
    if(!response.ok)return null;
    return await response.json();
  }catch(_){return null}
}
async function postEvent(accessToken,payload){
  return fetch(BASE+'/event',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-denvique-token':accessToken},
    body:JSON.stringify(payload)
  });
}
async function sendDomain(tabId){
  const current=await appState();
  if(!current||current.active!==true||!current.session_id){
    lastDomain='';lastSessionId='';lastTabId=null;
    return;
  }
  if(String(current.session_id)!==lastSessionId){
    lastSessionId=String(current.session_id);
    lastDomain='';
    lastTabId=null;
  }
  let tab;
  try{tab=await chrome.tabs.get(tabId)}catch(_){return}
  if(!tab||!tab.url)return;
  let host='';
  try{
    const url=new URL(tab.url);
    if(!['http:','https:'].includes(url.protocol))return;
    host=url.hostname.toLowerCase();
  }catch(_){return}
  if(!host)return;
  if(host===lastDomain){lastTabId=tabId;return}
  const accessToken=await loadToken();
  if(!accessToken)return;
  try{
    const response=await postEvent(accessToken,{
      event_type:'site',item_name:host,domain:host,source:'browser-extension'
    });
    if(response.ok){lastDomain=host;lastTabId=tabId}
    else if(response.status===403)token=null;
  }catch(_){}
}
async function closeCurrentDomain(tabId){
  if(tabId!==lastTabId||!lastDomain)return;
  const current=await appState();
  if(current&&current.active===true&&current.session_id){
    const accessToken=await loadToken();
    if(accessToken){
      try{await postEvent(accessToken,{event_type:'site_end',source:'browser-extension'})}
      catch(_){}
    }
  }
  lastDomain='';
  lastTabId=null;
  await activeTab();
}
async function activeTab(){
  try{
    const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if(tabs[0]&&tabs[0].id!==undefined)await sendDomain(tabs[0].id);
  }catch(_){}
}
chrome.tabs.onActivated.addListener(info=>sendDomain(info.tabId));
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status==='complete'&&tab.active)sendDomain(tabId);
});
chrome.tabs.onRemoved.addListener(tabId=>closeCurrentDomain(tabId));
chrome.windows.onFocusChanged.addListener(windowId=>{
  if(windowId!==chrome.windows.WINDOW_ID_NONE)activeTab();
});
chrome.alarms.create('denvique-site-heartbeat',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(activeTab);
chrome.runtime.onStartup.addListener(activeTab);
chrome.runtime.onInstalled.addListener(activeTab);
