const apps=[];
export function initializeApp(options,name='[DEFAULT]'){ const a={name,options}; apps.push(a); (window.__aiLog=window.__aiLog||[]).push({ev:'initApp',name}); return a; }
export function getApps(){ return apps; }
