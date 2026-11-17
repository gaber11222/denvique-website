const {contextBridge,ipcRenderer}=require('electron');

contextBridge.exposeInMainWorld('denviqueMonitor',{
  getState:()=>ipcRenderer.invoke('monitor:get-state'),
  signIn:()=>ipcRenderer.invoke('monitor:sign-in'),
  signOut:()=>ipcRenderer.invoke('monitor:sign-out'),
  start:()=>ipcRenderer.invoke('monitor:start'),
  stop:()=>ipcRenderer.invoke('monitor:stop'),
  refresh:()=>ipcRenderer.invoke('monitor:refresh'),
  openCheckin:()=>ipcRenderer.invoke('monitor:open-checkin'),
  openExtensionFolder:()=>ipcRenderer.invoke('monitor:open-extension-folder'),
  onState:callback=>ipcRenderer.on('monitor:state',(_event,state)=>callback(state)),
  onNotice:callback=>ipcRenderer.on('monitor:notice',(_event,notice)=>callback(notice))
});
