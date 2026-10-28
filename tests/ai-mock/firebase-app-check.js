export class ReCaptchaV3Provider{ constructor(k){ this.key=k; } }
export function initializeAppCheck(app,opts){ (window.__aiLog=window.__aiLog||[]).push({ev:'appCheck',app:app.name,key:opts.provider.key,enterprise:!!opts.provider.enterprise}); return {app}; }
export class ReCaptchaEnterpriseProvider{ constructor(k){ this.key=k; this.enterprise=true; } }
export async function getToken(ac){ if(window.__acFail) { const e=new Error('AppCheck: Fetch server returned an HTTP error status. HTTP status: 403. (appCheck/fetch-status-error).'); e.code='appCheck/fetch-status-error'; throw e; } return {token:'tok'}; }
