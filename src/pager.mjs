// The pager: a tiny installable page that lets one phone receive Cue's critical events as push notifications.
// On iPhone, web push needs the page on the Home Screen (iOS 16.4+), so the page says that first.

export const SW = `self.addEventListener('push', (e) => {
  let m = {}; try { m = e.data.json(); } catch { m = { title: 'Cue', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Cue', { body: m.body || '', tag: m.tag, data: { link: m.link || '/cue' }, requireInteraction: true }));
});
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data.link)); });
`;

export const MANIFEST = JSON.stringify({ name: 'Cue pager', short_name: 'Cue', start_url: '/cue/pager', scope: '/cue/', display: 'standalone', background_color: '#0a0f26', theme_color: '#0a0f26', icons: [{ src: '/cue/pager.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });

export const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0f26"/><path d="M20 44V22l24 11-24 11z" fill="#6ff2c8"/></svg>';

export const SCRIPT = `(function(){
  var b=document.getElementById('on'),s=document.getElementById('say'),k=new URLSearchParams(location.search).get('k')||localStorage.getItem('cue-k')||'';
  if(k)localStorage.setItem('cue-k',k);
  function say(t){s.textContent=t;}
  var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){say(/iPhone|iPad/.test(navigator.userAgent)&&!standalone?'On iPhone: tap Share, then Add to Home Screen, then open Cue from the Home Screen and tap the button.':'This browser cannot receive push notifications.');b.disabled=true;return;}
  function key(s){s=s.replace(/-/g,'+').replace(/_/g,'/');var r=atob(s+'==='.slice((s.length+3)%4)),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
  b.onclick=function(){
    if(!k){say('This page needs the pairing link Cue made for you.');return;}
    say('Asking…');
    navigator.serviceWorker.register('/cue/sw.js',{scope:'/cue/'}).then(function(r){return navigator.serviceWorker.ready;}).then(function(r){
      return Notification.requestPermission().then(function(p){if(p!=='granted')throw new Error('Notifications were not allowed.');
        return r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key(b.dataset.key)});});
    }).then(function(sub){
      return fetch('/cue/api/pager',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({k:k,sub:sub.toJSON()})});
    }).then(function(r){return r.json();}).then(function(j){say(j.ok?'This phone is paired. A test page is on its way.':(j.error||'That did not work.'));})
    .catch(function(e){say(e.message);});
  };
})();`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const pagerPage = (publicKey, devices) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cue pager</title>
<link rel="manifest" href="/cue/pager.webmanifest"><link rel="apple-touch-icon" href="/cue/pager.svg"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a0f26">
<style>:root{color-scheme:dark}body{margin:0 auto;max-width:520px;padding:48px 16px;background:#0a0f26;color:#eef1ff;font:17px/1.5 ui-monospace,Menlo,monospace}h1{font-size:40px;margin:0 0 8px;color:#6ff2c8}p{color:#b9c1e2}button{font:inherit;font-weight:700;padding:14px 22px;border-radius:12px;border:0;background:#6ff2c8;color:#0a0f26;cursor:pointer}button:disabled{opacity:.4}#say{min-height:3em}</style>
<h1>Cue pager</h1><p>Cue pages this phone only for an outage or a decision that's yours to make. Facts stay in the log.</p>
<p><button id="on" data-key="${esc(publicKey)}">Turn on alerts</button></p><p id="say"></p><p>${devices} paired device${devices === 1 ? '' : 's'}.</p>
<script src="/cue/pager.js"></script></html>`;
